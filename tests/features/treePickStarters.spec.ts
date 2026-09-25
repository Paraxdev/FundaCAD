// A pick the tool is waiting for, answered from an Items row instead of the view.
// MO-3: Offset Plane, "Select a plane or face to offset from", the YZ row clicked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { endPickSession, resetTreePicks, routeTreeClick, treePickWaiting, type TreePick } from "../../src/ui/treePick";
import { createActions } from "../../src/app/actions";
import { DocumentStore } from "../../src/document/store";
import type { Engine } from "../../src/app/engine";
import type { GeometryBackend } from "../../src/geometry/client";
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
    overlay: { regions: [], selectedRegions: () => [] },
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
  return { starters, deps, datumPoseStart, addFeature, viewport, hints, click, planePick: () => planePick };
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

// The review's two leaks: a body pick that did not mark the screen busy, so a
// second command started over it and its taker came back later; and undo,
// which never touched the pick at all. Either way Box then Cylinder rows,
// clicked long after, committed a boolean nobody asked for.
describe("a pick session cannot outlive its tool", () => {
  const stubBackend = {
    async rebuild() { return { ok: false, error: { message: "stub" } }; },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;

  function actionsOver(r: ReturnType<typeof rig>) {
    const d = r.deps as unknown as Record<string, unknown>;
    return createActions({
      sketch: { active: false },
      starters: r.starters,
      tools: { section: { picking: false, active: false } },
      toolBusy: d.toolBusy,
      setStatus: d.setStatus,
      lastAction: null,
    } as unknown as Engine);
  }

  const noBoolean = (r: ReturnType<typeof rig>) =>
    r.addFeature.mock.calls.every(([f]) => (f as { type: string }).type !== "boolean");

  it("a body pick holds the screen, so a starter called over it does nothing", () => {
    const r = rig([{ id: "b1", name: "A" }, { id: "b2", name: "B" }]);
    r.starters.startBoolean("subtract");
    expect(r.planePick()).toBe(true);
    r.starters.offsetPlane();
    expect(usePromptStore().text).toBe("Click the body to keep · Esc cancels");
  });

  it("a command started over a body pick ends it, and later body rows commit nothing", () => {
    const r = rig([{ id: "b1", name: "A" }, { id: "b2", name: "B" }]);
    const act = actionsOver(r);
    r.starters.startBoolean("subtract");
    act("revolve");
    expect(r.planePick()).toBe(false);
    expect(treePickWaiting()).toBe(false);
    expect(r.click({ kind: "body", id: "b1" })).toBe("row");
    flushFrame();
    expect(r.click({ kind: "body", id: "b2" })).toBe("row");
    flushFrame();
    expect(noBoolean(r)).toBe(true);
  });

  it("a look around the model keeps the pick", () => {
    const r = rig([{ id: "b1", name: "A" }, { id: "b2", name: "B" }]);
    r.starters.startBoolean("subtract");
    try { actionsOver(r)("persp"); } catch { /* the fake has no viewport, only the pick matters */ }
    expect(treePickWaiting()).toBe(true);
  });

  it("undo mid pick ends it through its cleanup, and later body rows commit nothing", () => {
    const r = rig([{ id: "b1", name: "A" }, { id: "b2", name: "B" }]);
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    store.onRewind(endPickSession);
    store.addFeature({ id: "x", type: "box", length: 1, width: 1, height: 1 } as never);
    r.starters.startBoolean("subtract");
    store.undo();
    expect(r.planePick()).toBe(false);
    expect(usePromptStore().text).toBeNull();
    expect(r.click({ kind: "body", id: "b1" })).toBe("row");
    expect(r.click({ kind: "body", id: "b2" })).toBe("row");
    flushFrame();
    expect(noBoolean(r)).toBe(true);
  });

  it("redo, a load and a new document end it too", () => {
    const r = rig([{ id: "b1", name: "A" }]);
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    store.onRewind(endPickSession);
    store.addFeature({ id: "x", type: "box", length: 1, width: 1, height: 1 } as never);
    store.undo();
    for (const replace of [() => store.redo(), () => store.load(JSON.stringify({ parameters: {}, features: [] })), () => store.newDocument()]) {
      r.starters.offsetPlane();
      expect(treePickWaiting()).toBe(true);
      replace();
      expect(treePickWaiting()).toBe(false);
      expect(r.planePick()).toBe(false);
    }
  });
});
