import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { lockedPoseFields, writeDatumPose } from "../../src/features/datumPlaneEdit";
import { foldDegrees, tiltStep } from "../../src/features/datumPoseTool";
import { ZERO_POSE } from "../../src/document/datumPose";

vi.stubGlobal("window", globalThis);

function backend() {
  const sent: CadDocument[] = [];
  const be = {
    async rebuild(doc: CadDocument) {
      sent.push(doc);
      const result: RebuildResult = { mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: { min: [0, 0, 0], max: [0, 0, 0] } };
      return { ok: true as const, result };
    },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
  } as unknown as GeometryBackend;
  return { be, sent };
}

const plane = (extra: Record<string, unknown> = {}) =>
  ({ id: "p", type: "datumPlane", plane: "XY", offset: 10, ...extra }) as unknown as Feature;
const sketch = { id: "s", type: "sketch", plane: "XY", planeId: "p", entities: [] } as unknown as Feature;
const field = (store: DocumentStore, k: string) =>
  (store.document.features.find((f) => f.id === "p") as unknown as Record<string, unknown>)[k];
const settle = (store: DocumentStore) => (store as unknown as { paramChain: Promise<void> }).paramChain;

describe("writing a datum pose", () => {
  it("writes only what changed, and leaves a zero angle out", () => {
    const store = new DocumentStore(backend().be, { parameters: {}, features: [plane({ spin: 15 })] });
    const r = writeDatumPose(store, "p", { ...ZERO_POSE, offset: 10, tiltX: 30 });
    expect(r).toEqual({ written: true, refused: [] });
    expect(field(store, "tiltX")).toBe(30);
    expect(field(store, "spin")).toBeUndefined();
    expect(field(store, "offset")).toBe(10);
    expect(writeDatumPose(store, "p", { ...ZERO_POSE, offset: 10, tiltX: 30 }).written).toBe(false);
  });

  it("moves a parameter bound to a field instead of cutting it loose", async () => {
    const store = new DocumentStore(backend().be, { parameters: {}, features: [plane({ tiltX: 30 })] });
    const target = { kind: "feature" as const, feature: "p", field: "tiltX" };
    expect(store.setTargetExpr(target, "lean=30", "angle")).toBeNull();
    await settle(store);
    writeDatumPose(store, "p", { ...ZERO_POSE, offset: 10, tiltX: 45 });
    await settle(store);
    expect(store.boundExpr(target)).toMatchObject({ name: "lean", value: 45 });
    expect(field(store, "tiltX")).toBe(45);
  });

  it("refuses a field an expression drives, and hides its handle", async () => {
    const store = new DocumentStore(backend().be, { parameters: {}, features: [plane({ tiltX: 30 })] });
    expect(store.addParam("base", "20", "deg")).toBeNull();
    await settle(store);
    expect(store.setTargetExpr({ kind: "feature", feature: "p", field: "tiltX" }, "base + 10", "angle")).toBeNull();
    await settle(store);
    expect([...lockedPoseFields(store, "p")]).toEqual(["tiltX"]);
    const r = writeDatumPose(store, "p", { ...ZERO_POSE, offset: 12, tiltX: 50 });
    expect(r.refused).toEqual(["tiltX"]);
    expect(field(store, "offset")).toBe(12);
    expect(field(store, "tiltX")).toBe(30);
  });
});

describe("an in-place edit preview", () => {
  it("builds the edited datum where it stands with everything after it", async () => {
    const h = backend();
    const store = new DocumentStore(h.be, { parameters: {}, features: [plane(), sketch] });
    store.beginEditPreview("p", plane({ tiltX: 20 }), { inPlace: true });
    await store.rebuildNow();
    const doc = h.sent.at(-1)!;
    expect(doc.features.map((f) => f.id)).toEqual(["p", "s"]);
    expect((doc.features[0] as unknown as { tiltX: number }).tiltX).toBe(20);
    expect(store.editPreviewInPlace).toBe(true);
    store.endEditPreview(false);
    expect(store.editPreviewInPlace).toBe(false);
  });

  it("still rolls away what follows for an ordinary edit", async () => {
    const h = backend();
    const store = new DocumentStore(h.be, { parameters: {}, features: [plane(), sketch] });
    store.beginEditPreview("p", plane({ tiltX: 20 }));
    await store.rebuildNow();
    expect(h.sent.at(-1)!.features.map((f) => f.id)).toEqual(["p"]);
  });
});

describe("tilt handle steps", () => {
  it("steps by 5, by 1 with Shift, and freely with Alt", () => {
    expect(tiltStep({ shiftKey: false, altKey: false })).toBe(5);
    expect(tiltStep({ shiftKey: true, altKey: false })).toBe(1);
    expect(tiltStep({ shiftKey: true, altKey: true })).toBe(0);
  });

  it("folds a dragged angle the short way round", () => {
    expect(foldDegrees(190)).toBe(-170);
    expect(foldDegrees(-180)).toBe(180);
    expect(foldDegrees(45)).toBe(45);
    expect(foldDegrees(-0)).toBe(0);
  });
});
