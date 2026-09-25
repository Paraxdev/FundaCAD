// NV-9 at the store: re-editing a fillet in the middle of the timeline, the way
// EdgeFeatureTool does it (roll back, preview, commit), must leave every feature
// as it was except the edited value, and one undo must restore it all exactly.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { blendEditCommit } from "../../src/features/blendEdit";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

// The debounced rebuild a parameter commit schedules goes through window.setTimeout.
vi.stubGlobal("window", globalThis);

function stubBackend(rebuilds: CadDocument[]): GeometryBackend {
  return {
    async rebuild(doc: CadDocument): Promise<RebuildReply> {
      rebuilds.push(doc);
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

const A = { kind: "edge", by: "nearest", point: [0, -46, 20.3], body: "body1" };
const B = { kind: "edge", by: "nearest", point: [0, 46, 20.3], body: "body1" };

const doc = (bound: boolean): CadDocument => ({
  parameters: bound ? { wall_blend_r: 4, d22: 4 } : {},
  ...(bound
    ? {
        paramDefs: {
          wall_blend_r: { expr: "4", value: 4, unit: "mm" as const, comment: "bowl to inner wall blend" },
          d22: {
            expr: "wall_blend_r", value: 4, unit: "mm" as const,
            target: { kind: "feature" as const, feature: "wall_blend", field: "radius" },
          },
        },
      }
    : {}),
  features: [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
    { id: "wall_blend", type: "fillet", name: "Bowl to wall blend", radius: 4, edges: [A, B] },
    { id: "c1", type: "chamfer", name: "Later", edges: { kind: "edge", by: "nearest", point: [1, 0, 0] }, distance: 1 },
  ] as Feature[],
});

// What the tool's buildFeature() produces for this fillet: no name, its own edge order.
const toolView = (radius: number): Feature =>
  ({ id: "wall_blend", type: "fillet", edges: [B, A], radius }) as unknown as Feature;

describe("a mid-timeline fillet edit through the store", () => {
  let rebuilds: CadDocument[];
  beforeEach(() => {
    vi.useFakeTimers();
    rebuilds = [];
  });
  afterEach(() => void vi.useRealTimers());

  async function editTo(store: DocumentStore, radius: number, paramRef: string | null) {
    const original = structuredClone(store.document.features.find((f) => f.id === "wall_blend")!);
    store.beginEditPreview("wall_blend");
    await vi.runAllTimersAsync();
    expect(rebuilds.at(-1)!.features.map((f) => f.id)).toEqual(["s1", "e1"]);
    store.setEditPreview({ ...toolView(radius), draft: true } as Feature, { hold: true });
    await vi.runAllTimersAsync();
    expect(rebuilds.at(-1)!.features.map((f) => f.id)).toEqual(["s1", "e1", "wall_blend"]);
    const edit = blendEditCommit({ original, opened: toolView(4), built: toolView(radius), paramRef });
    store.endEditPreview(false);
    expect(store.commitFeatureEdit("wall_blend", edit.feature, edit.param)).toBeNull();
    await vi.runAllTimersAsync();
  }

  it("a bound radius: only the parameter and the value it drives change, and one undo restores all", async () => {
    const store = new DocumentStore(stubBackend(rebuilds), doc(true));
    const before = store.toJSON();
    const featuresBefore = structuredClone(store.document.features);
    await editTo(store, 12, store.bareParamRef({ kind: "feature", feature: "wall_blend", field: "radius" }));

    const after = store.document.features;
    expect(after.map((f) => f.id)).toEqual(["s1", "e1", "wall_blend", "c1"]);
    expect(after).toEqual(featuresBefore.map((f) => (f.id === "wall_blend" ? { ...f, radius: 12 } : f)));
    expect(store.document.paramDefs!.wall_blend_r!.expr).toBe("12");
    expect(store.document.paramDefs!.d22!.expr).toBe("wall_blend_r");
    expect(rebuilds.at(-1)!.features.map((f) => f.id)).toEqual(["s1", "e1", "wall_blend", "c1"]);

    store.undo();
    expect(store.toJSON()).toBe(before);
    expect((store.document.features[2] as { name?: string }).name).toBe("Bowl to wall blend");
  });

  it("a plain radius: the feature keeps its name, id and edges, and one undo restores all", async () => {
    const store = new DocumentStore(stubBackend(rebuilds), doc(false));
    const before = store.toJSON();
    const featuresBefore = structuredClone(store.document.features);
    await editTo(store, 6, null);

    expect(store.document.features).toEqual(
      featuresBefore.map((f) => (f.id === "wall_blend" ? { ...f, radius: 6 } : f)),
    );
    store.undo();
    expect(store.toJSON()).toBe(before);
    expect((store.document.features[2] as { name?: string }).name).toBe("Bowl to wall blend");
  });
});
