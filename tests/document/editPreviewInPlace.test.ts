// A value typed into a feature's row is previewed in place: the features after
// it stay built around the live value, instead of rolling away until Enter. An
// exploded assembly had every part snap back or vanish while the user typed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

type FeatureErrors = { feature_id: string; message: string }[];

function backend(rebuilds: CadDocument[], errorsFor: (doc: CadDocument) => FeatureErrors): GeometryBackend {
  return {
    async rebuild(doc: CadDocument): Promise<RebuildReply> {
      rebuilds.push(doc);
      const featureErrors = errorsFor(doc);
      return {
        ok: true,
        result: {
          mesh: { positions: [], indices: [], faceIds: [] },
          edges: [],
          bbox: null,
          bodies: [],
          ...(featureErrors.length ? { featureErrors, featureError: featureErrors[featureErrors.length - 1] } : {}),
        },
      } as unknown as RebuildReply;
    },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

const doc = (): CadDocument => ({
  parameters: {},
  features: [
    { id: "bx", type: "box", length: 20, width: 20, height: 20 },
    { id: "mv", type: "move", dx: 40, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, bodies: ["body1"] },
    { id: "cut", type: "boolean", operation: "cut", target: "body2", tools: ["body1"], name: "pocket" },
  ] as Feature[],
});

const box = (length: number): Feature =>
  ({ id: "bx", type: "box", length, width: 20, height: 20 }) as Feature;

const lengthOf = (d: CadDocument) => (d.features.find((f) => f.id === "bx") as { length?: number } | undefined)?.length;

/** The cut refuses a box longer than 50, sent or not, and `alwaysFails` refuses whatever it is given. */
const refusals = (alwaysFails: string[] = []) => (d: CadDocument): FeatureErrors => {
  const out: FeatureErrors = alwaysFails
    .filter((id) => d.features.some((f) => f.id === id))
    .map((id) => ({ feature_id: id, message: "was already broken" }));
  if ((lengthOf(d) ?? 0) > 50) {
    out.push({ feature_id: "cut", message: "the tool misses the target" });
  }
  return out;
};

describe("edit preview in place", () => {
  let rebuilds: CadDocument[];
  afterEach(() => void vi.useRealTimers());
  beforeEach(() => {
    vi.useFakeTimers();
    rebuilds = [];
  });

  const ids = (d: CadDocument) => d.features.map((f) => f.id);

  it("keeps every later feature, with the live value in place of the committed one", async () => {
    const store = new DocumentStore(backend(rebuilds, refusals()), doc());
    store.beginEditPreview("bx", box(120), { inPlace: true });
    await vi.runAllTimersAsync();
    const built = store.builtDocument();
    expect(ids(built)).toEqual(["bx", "mv", "cut"]);
    expect(lengthOf(built)).toBe(120);
    expect(lengthOf(rebuilds[rebuilds.length - 1]!)).toBe(120);
  });

  it("THE CONTROL: a preview that is not in place stops at the edited feature", async () => {
    const store = new DocumentStore(backend(rebuilds, refusals()), doc());
    store.beginEditPreview("bx", box(120));
    await vi.runAllTimersAsync();
    expect(ids(store.builtDocument())).toEqual(["bx"]);
  });

  it("past the rollback marker it rolls nothing back and appends the live feature", async () => {
    const store = new DocumentStore(backend(rebuilds, refusals()), doc());
    store.setRollback(1);
    store.beginEditPreview("cut", { ...doc().features[2]!, name: undefined } as Feature, { inPlace: true });
    await vi.runAllTimersAsync();
    expect(ids(store.builtDocument())).toEqual(["bx", "cut"]);
  });

  it("names a later feature the typed value breaks", async () => {
    const store = new DocumentStore(backend(rebuilds, refusals()), doc());
    await store.rebuildNow();
    store.beginEditPreview("bx", box(120), { inPlace: true });
    await vi.runAllTimersAsync();
    expect(store.previewError).toBe("pocket fails with this value: the tool misses the target");
    store.setEditPreview(box(30));
    await vi.runAllTimersAsync();
    expect(store.previewError).toBeNull();
  });

  it("THE CONTROL: a preview that is not in place never reports a later feature", async () => {
    const store = new DocumentStore(backend(rebuilds, refusals()), doc());
    await store.rebuildNow();
    store.beginEditPreview("bx", box(120));
    await vi.runAllTimersAsync();
    expect(store.buildState.result?.featureErrors?.[0]?.feature_id).toBe("cut");
    expect(store.previewError).toBeNull();
  });

  it("does not blame the typed value for a feature that already failed", async () => {
    const store = new DocumentStore(backend(rebuilds, refusals(["mv"])), doc());
    await store.rebuildNow();
    store.beginEditPreview("bx", box(30), { inPlace: true });
    await vi.runAllTimersAsync();
    expect(store.previewError).toBeNull();
  });

  it("reports the edited feature's own refusal even when a later one fails too", async () => {
    const own = (d: CadDocument): FeatureErrors =>
      lengthOf(d) === -1
        ? [{ feature_id: "bx", message: "length must be positive" }, { feature_id: "cut", message: "no tool body" }]
        : [];
    const store = new DocumentStore(backend(rebuilds, own), doc());
    await store.rebuildNow();
    store.beginEditPreview("bx", box(-1), { inPlace: true });
    await vi.runAllTimersAsync();
    expect(store.previewError).toBe("length must be positive");
  });
});
