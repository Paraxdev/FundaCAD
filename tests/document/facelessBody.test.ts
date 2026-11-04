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

const FAR = 1e8;
const NO_FACES = "The body came out with no faces, so there is nothing to show.";
const HINT = " Move the sketch within 1 km of the origin.";

const doc = (at: number | string = FAR, plane: unknown = "XY"): CadDocument => ({
  parameters: { far: FAR },
  features: [
    { id: "sk", type: "sketch", plane, entities: [{ type: "rectangle", x: at, y: 5, width: 40, height: 20 }] },
    { id: "ex", type: "extrude", sketch: "sk", distance: 8 },
    { id: "ex2", type: "extrude", sketch: "sk", distance: 4 },
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
    expect(b.errorMessage).toBe(NO_FACES + HINT);
    expect([...featureFailures({ ...b, featureErrors: b.result?.featureErrors }).keys()]).toEqual(["ex"]);
    const line = buildLine(b, null, names)!;
    expect(line.priority).toBe("assertive");
    expect(line.text).toMatch(/^Build failed at Extrude 1: /);
    expect(line.text).not.toMatch(/Built/);
  });

  it("says no 1 km hint when the sketch is near the origin, as the cause is something else", async () => {
    const store = new DocumentStore(backend([body("body1", 0, 0)]), doc(5));
    await store.rebuildNow();
    const b = store.buildState;
    expect(b.errorFeatureId).toBe("ex");
    expect(b.errorMessage).toBe(NO_FACES);
    expect(buildLine(b, null, names)?.text).toBe(`Build failed at Extrude 1: ${NO_FACES}`);
  });

  it("gives the hint for a sketch placed past 1 km, or drawn there through a parameter", async () => {
    const placed = { origin: [0, 0, 2e6], normal: [0, 0, 1], xdir: [1, 0, 0] };
    for (const d of [doc(5, placed), doc("far")]) {
      const store = new DocumentStore(backend([body("body1", 0, 0)]), d);
      await store.rebuildNow();
      expect(store.buildState.errorMessage).toBe(NO_FACES + HINT);
    }
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
