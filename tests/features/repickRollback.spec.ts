// Re-pick of an ambiguous reference is taken on the model rolled back to the
// feature that holds it. The finished model carries every later move, so a point
// picked there and written into an earlier fillet lands on nothing it can see.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { resetTreePicks } from "../../src/ui/treePick";
import type { Feature, Selector } from "../../src/types";
import type { RebuildState } from "../../src/document/store";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

const near = (p: [number, number, number]): Selector => ({ kind: "edge", by: "nearest", point: p }) as Selector;

// A box with a fillet whose saved edge point is tied, then a move of dx 100.
function rig() {
  let planePick = false;
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  const features: Feature[] = [
    { id: "f1", type: "box", length: 20, width: 20, height: 20 } as Feature,
    { id: "f2", type: "fillet", radius: 2, edges: [near([0, 0, 10])] } as Feature,
    { id: "f3", type: "move", bodies: ["body1"], dx: 100 } as unknown as Feature,
  ];
  const listeners = new Set<(s: RebuildState) => void>();
  const full = { mesh: { positions: [0] } };
  const rolled = { mesh: { positions: [0] } };
  let build = { building: false, result: full, previewBuilt: null } as unknown as RebuildState;
  const emit = (s: Partial<RebuildState>) => {
    build = { ...build, ...s } as RebuildState;
    for (const fn of [...listeners]) fn(build);
  };
  let editId: string | null = null;
  const updateFeature = vi.fn((id: string, patch: Partial<Feature>) => {
    const i = features.findIndex((f) => f.id === id);
    features[i] = { ...features[i], ...patch } as Feature;
  });
  const endEditPreview = vi.fn(() => { editId = null; });
  const store = {
    document: { parameters: {}, features },
    get buildState() { return build; },
    get editPreviewId() { return editId; },
    onBuild: (fn: (s: RebuildState) => void) => {
      listeners.add(fn);
      fn(build);
      return () => listeners.delete(fn);
    },
    beginEditPreview: vi.fn((id: string) => {
      editId = id;
      emit({ building: true });
    }),
    endEditPreview,
    updateFeature,
    deriveFeature: vi.fn(),
  };
  // The edge under the cursor sits where the model on screen has it: moved by
  // 100 on the finished model, at the box on the model rolled back to the fillet.
  const viewport = {
    suspendPicking: false,
    emphasizeEdges: vi.fn(),
    hoverEdge: vi.fn(),
    pickEdgeAt: () => {
      const x = build.result === rolled ? 10 : 110;
      return { selector: near([x, 0, 10]), edge: { points: [[x, -10, 10], [x, 10, 10]] } };
    },
  };
  const deps = {
    store,
    viewport,
    canvas,
    toolBusy: () => planePick,
    hasBody: () => true,
    setStatus: vi.fn(),
    selectFeature: vi.fn(),
    noteCommitted: vi.fn(),
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    setPlanePick: (v: boolean) => { planePick = v; },
    datumMoveTarget: () => null,
  } as unknown as FeatureStartersDeps;
  const starters = createFeatureStarters(deps);
  const landRollback = () => emit({ building: false, result: rolled, previewBuilt: [] } as unknown as RebuildState);
  const click = () => canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 50, clientY: 50 }));
  return { starters, store, features, landRollback, click, planePick: () => planePick, editId: () => editId };
}

beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => { frames.push(f); return frames.length; });
});
afterEach(() => {
  resetTreePicks();
  vi.unstubAllGlobals();
});

describe("re-pick on the model rolled back to the feature", () => {
  it("stores a point on the unmoved body, not on the moved one", () => {
    const r = rig();
    r.starters.repickReference("f2", [0, 0, 10], "edge");
    expect(r.store.beginEditPreview).toHaveBeenCalledWith("f2");
    r.landRollback();
    r.click();
    flushFrame();
    const edges = (r.features[1] as { edges: { point: number[] }[] }).edges;
    expect(edges[0]!.point[0]).toBe(10);
    expect(r.store.endEditPreview).toHaveBeenCalledTimes(1);
    expect(r.store.updateFeature.mock.invocationCallOrder[0]!)
      .toBeLessThan(r.store.endEditPreview.mock.invocationCallOrder[0]!);
    expect(r.planePick()).toBe(false);
  });

  it("a click before the rolled-back build lands picks nothing", () => {
    const r = rig();
    r.starters.repickReference("f2", [0, 0, 10], "edge");
    r.click();
    flushFrame();
    expect(r.store.updateFeature).not.toHaveBeenCalled();
    expect(r.planePick()).toBe(true);
  });

  it("Escape while picking puts the finished model back and writes nothing", () => {
    const r = rig();
    r.starters.repickReference("f2", [0, 0, 10], "edge");
    r.landRollback();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(r.store.endEditPreview).toHaveBeenCalledTimes(1);
    expect(r.editId()).toBeNull();
    expect(r.store.updateFeature).not.toHaveBeenCalled();
    expect(r.planePick()).toBe(false);
  });

  it("Escape while the rollback is still building also ends it", () => {
    const r = rig();
    r.starters.repickReference("f2", [0, 0, 10], "edge");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(r.editId()).toBeNull();
    expect(r.planePick()).toBe(false);
    r.landRollback();
    r.click();
    flushFrame();
    expect(r.store.updateFeature).not.toHaveBeenCalled();
  });
});
