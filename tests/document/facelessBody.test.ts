// A sketch 1e8 mm out extrudes to a body with no faces: the build is a failure at the step that made it, not "Built".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, RebuildReply, RebuildResult } from "../../src/types";
import { buildLine } from "../../src/ui/buildAnnouncement";
import { featureFailures } from "../../src/ui/featureNotes";

type Bodies = NonNullable<RebuildResult["bodies"]>;

const body = (id: string, faceStart: number, faceCount: number) => ({ id, name: id, faceStart, faceCount });

function backend(bodies: Bodies, extra: Partial<RebuildResult> = {}): GeometryBackend {
  return {
    async rebuild(): Promise<RebuildReply> {
      return {
        ok: true,
        result: {
          mesh: { positions: [], indices: [], faceIds: [] },
          edges: [],
          bbox: { min: [0, 0, 0], max: [0, 0, 0] },
          bodies,
          bodyIds: { "ex:0": "body1", "ex2:0": "body2" },
          ...extra,
        },
      } as unknown as RebuildReply;
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
}

const doc = (): CadDocument => ({
  parameters: {},
  features: [
    { id: "sk", type: "sketch", plane: "XY", entities: [] },
    { id: "ex", type: "extrude", profile: "sk", distance: 8 },
    { id: "ex2", type: "extrude", profile: "sk", distance: 4 },
  ] as unknown as Feature[],
});

const names = (id: string) => ({ ex: "Extrude 1", ex2: "Extrude 2" })[id] ?? null;

describe("a body with no faces", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("fails the step that made it, in History and in what is said", async () => {
    const store = new DocumentStore(backend([body("body1", 0, 0), body("body2", 0, 6)]), doc());
    await store.rebuildNow();
    const b = store.buildState;
    expect(b.errorFeatureId).toBe("ex");
    expect(b.errorMessage).toMatch(/no faces/);
    expect(b.errorMessage).toMatch(/within 1 km of the origin/);
    expect([...featureFailures({ ...b, featureErrors: b.result?.featureErrors }).keys()]).toEqual(["ex"]);
    const line = buildLine(b, null, names)!;
    expect(line.priority).toBe("assertive");
    expect(line.text).toMatch(/^Build failed at Extrude 1: /);
    expect(line.text).not.toMatch(/Built/);
  });

  it("keeps an engine failure the most downstream one and adds its own beside it", async () => {
    const engine = { feature_id: "ex2", message: "Profile is open" };
    const store = new DocumentStore(
      backend([body("body1", 0, 0)], { featureError: engine, featureErrors: [engine] }),
      doc(),
    );
    await store.rebuildNow();
    const b = store.buildState;
    expect(b.errorFeatureId).toBe("ex2");
    expect(b.result?.featureErrors?.map((e) => e.feature_id)).toEqual(["ex2", "ex"]);
  });

  it("is not counted as a built body when a later build still says it fails", () => {
    const settled = {
      building: false,
      cancelled: false,
      previewBuilt: null,
      errorFeatureId: "ex",
      errorMessage: "no faces",
      result: { bodies: [{ faceCount: 0 }, { faceCount: 6 }] },
    };
    expect(buildLine(settled, settled, names)?.text).toBe("Built, 1 body, Extrude 1 still fails");
  });

  it("THE CONTROL: bodies with faces build as before", async () => {
    const store = new DocumentStore(backend([body("body1", 0, 6), body("body2", 6, 6)]), doc());
    await store.rebuildNow();
    const b = store.buildState;
    expect(b.errorFeatureId).toBeNull();
    expect(b.result?.featureErrors).toBeUndefined();
    expect(buildLine(b, null, names)).toEqual({ text: "Built, 2 bodies", priority: "polite" });
  });
});
