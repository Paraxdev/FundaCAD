// A pick the tool is waiting for, answered from an Items row instead of the view.
// MO-3: Offset Plane, "Select a plane or face to offset from", the YZ row clicked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { resetTreePicks, routeTreeClick, treePickWaiting, type TreePick } from "../../src/ui/treePick";
import { usePromptStore } from "../../src/stores/prompt";
import { ZERO_POSE } from "../../src/document/datumPose";
import type { PlaneDef } from "../../src/types";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

function rig(bodies: { id: string; name: string }[] = []) {
  let planePick = false;
  const canvas = document.createElement("canvas");
  const datumPoseStart = vi.fn();
  const addFeature = vi.fn();
  const viewport = {
    domElement: canvas,
    suspendPicking: false,
    showAllPlanes: vi.fn(),
    clearHover: () => {},
    hoverDatum: () => {},
    hoverBody: () => {},
    setPickMarkers: vi.fn(),
    selectedFaceSketchPlane: () => null,
    getSelectedBodies: () => [],
    setSelectedBodies: vi.fn(),
  };
  const deps = {
    store: {
      document: { parameters: {}, features: [] },
      buildState: { result: { bodies, mesh: { positions: bodies.length ? [0] : [] } } },
      nextId: () => "f9",
      addFeature,
    },
    viewport,
    overlay: { regions: [] },
    sketch: { enter: vi.fn() },
    datumPose: { start: datumPoseStart },
    canvas,
    toolBusy: () => planePick,
    hasBody: () => bodies.length > 0,
    setStatus: vi.fn(),
    selectFeature: vi.fn(),
    noteCommitted: vi.fn(),
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    setPlanePick: (v: boolean) => { planePick = v; },
    datumMoveTarget: () => null,
  } as unknown as FeatureStartersDeps;
  const starters = createFeatureStarters(deps);
  const hints: string[] = [];
  const click = (pick: TreePick) =>
    routeTreeClick(pick, { busyHint: () => null, hint: (t) => hints.push(t) });
  return { starters, datumPoseStart, addFeature, viewport, hints, click, planePick: () => planePick };
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

describe("a tool's pick answered from the Items tree", () => {
  it("Offset Plane takes the YZ row as its reference plane", () => {
    const r = rig();
    r.starters.offsetPlane();
    expect(usePromptStore().text).toBe("Select a plane or face to offset from");
    expect(r.click({ kind: "basePlane", plane: "YZ" })).toBe("taken");
    // the pick is over at once, exactly as a click on the quad ends it
    expect(r.planePick()).toBe(false);
    expect(treePickWaiting()).toBe(false);
    expect(usePromptStore().text).toBeNull();
    flushFrame();
    expect(r.datumPoseStart).toHaveBeenCalledTimes(1);
    expect(r.datumPoseStart.mock.calls[0]![0]).toMatchObject({ src: "YZ" });
  });

  it("a datum plane row carries its id, so the new plane hangs off that datum", () => {
    const r = rig();
    r.starters.offsetPlane();
    const def: PlaneDef = { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] };
    r.click({ kind: "datumPlane", id: "dp", def });
    flushFrame();
    const [pose, done] = r.datumPoseStart.mock.calls[0]! as [unknown, (p: unknown) => void];
    expect(pose).toMatchObject({ src: def });
    done({ ...ZERO_POSE, offset: 3 });
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "datumPlane", plane: def, planeId: "dp" });
  });

  it("a row the pick cannot use is refused with a hint and the pick stays open", () => {
    const r = rig();
    r.starters.offsetPlane();
    expect(r.click({ kind: "body", id: "b1" })).toBe("refused");
    expect(r.hints).toEqual(["That row is a body, this step needs a plane, or a face picked in the view"]);
    expect(r.planePick()).toBe(true);
    expect(treePickWaiting()).toBe(true);
    expect(usePromptStore().text).toBe("Select a plane or face to offset from");
    // and still answers the right row afterwards
    expect(r.click({ kind: "basePlane", plane: "XZ" })).toBe("taken");
  });

  it("Escape ends the wait, so a later row click is the row's own again", () => {
    const r = rig();
    r.starters.offsetPlane();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(treePickWaiting()).toBe(false);
    expect(r.click({ kind: "basePlane", plane: "YZ" })).toBe("row");
  });

  it("a point pick takes a datum point row as one of its points", () => {
    const r = rig();
    r.starters.createDatumPoint();
    r.click({ kind: "datumPoint", id: "p1", point: [4, 5, 6] });
    flushFrame();
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "datumPoint", point: [4, 5, 6] });
  });

  it("a boolean takes body rows, and refuses the body it already has", () => {
    const r = rig([{ id: "b1", name: "A" }, { id: "b2", name: "B" }]);
    r.starters.startBoolean("subtract");
    expect(r.click({ kind: "body", id: "b1" })).toBe("taken");
    flushFrame();
    expect(r.click({ kind: "body", id: "b1" })).toBe("refused");
    expect(r.click({ kind: "body", id: "b2" })).toBe("taken");
    flushFrame();
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "boolean", operation: "subtract", target: "b1", tools: ["b2"] });
  });
});
