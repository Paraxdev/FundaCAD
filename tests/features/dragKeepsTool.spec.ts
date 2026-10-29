// Letting go of a dragged handle only ends the drag: the tool stays open with the dragged value in its box, the box
// options still answer, and only Enter writes the feature. A plain click on the canvas does what it always did.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PressPullTool } from "../../src/features/pressPullTool";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { DraftTool } from "../../src/features/draftTool";
import { FaceOffsetTool } from "../../src/features/faceOffsetTool";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { JointTool } from "../../src/features/jointTool";
import { MechanismTool } from "../../src/features/mechanismTool";
import { DatumPoseTool } from "../../src/features/datumPoseTool";
import { MoveTool } from "../../src/features/moveTool";
import { ALL_HANDLES, WORLD_FRAME, type MoveResult, type MoveTarget } from "../../src/features/moveTarget";
import type { DocumentStore } from "../../src/document/store";
import { needsSave, settleHeldEdit, type SaveEngine } from "../../src/app/documentActions";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector } from "../../src/types";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

/** Anything not given answers as a no-op, for the many viewport and store calls a tool makes only for looks. */
function lenient<T>(own: Record<string, unknown>): T {
  return new Proxy(own, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  }) as unknown as T;
}

const FACE: Selector = { kind: "face", by: "nearest", point: [0, 0, 0] };

/** The pointer ray at (x, y) runs along +X at height z = y / 10, so a drag down the screen by 10 px pulls a +Z
 *  handle 1 mm. */
function fakeViewport(extra: Record<string, unknown> = {}) {
  const canvas = document.createElement("canvas");
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const rayFrom = (_x: number, y: number) =>
    new THREE.Raycaster(new THREE.Vector3(-200, 0, y / 10), new THREE.Vector3(1, 0, 0));
  return lenient<Viewport>({
    suspendPicking: false,
    domElement: canvas,
    camera,
    rayFrom,
    probe: <T>(x: number, y: number, test: (rc: THREE.Raycaster) => T) => test(rayFrom(x, y)) || null,
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 0.5,
    modelDiagonal: () => 100,
    pickFaceForPressPull: () => null,
    roundFaceAt: () => null,
    faceTriangles: () => [],
    thicknessBehind: () => null,
    selectedFacesForPressPull: () => ({
      selectors: [FACE],
      faceIds: [7],
      normal: new THREE.Vector3(0, 0, 1),
      anchor: new THREE.Vector3(0, 0, 0),
      bodyId: "b1",
      round: null,
    }),
    ...extra,
  });
}

function fakeStore(extra: Record<string, unknown> = {}) {
  const added: Feature[] = [];
  let n = 0;
  const store = lenient<DocumentStore>({
    document: { features: [], parameters: {} },
    nextId: () => `f${++n}`,
    addFeature: (f: Feature) => added.push(f),
    onBuild: () => () => {},
    onSessionBuild: () => () => {},
    faceAxis: async () => null,
    isParamBound: () => false,
    bareParamRef: () => null,
    hasPreview: false,
    previewError: null,
    buildState: { building: false, result: null },
    ...extra,
  });
  return { store, added };
}

function pointer(canvas: HTMLElement, type: string, y: number) {
  canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true, cancelable: true }));
}

/** Press at `from`, drag to `to` and let go, with the handle under the press. */
function dragHandle(canvas: HTMLElement, from: number, to: number) {
  flushFrame();
  pointer(canvas, "pointerdown", from);
  pointer(canvas, "pointermove", (from + to) / 2);
  pointer(canvas, "pointermove", to);
  vi.advanceTimersByTime(500);
  pointer(canvas, "pointerup", to);
}

function click(canvas: HTMLElement, at: number) {
  pointer(canvas, "pointerdown", at);
  pointer(canvas, "pointerup", at);
}

const box = () => [...document.querySelectorAll<HTMLElement>(".dim-input")].find((b) => b.style.display !== "none")!;
const input = () => box().querySelector<HTMLInputElement>("input")!;
const segment = (option: string, id: string) =>
  box().querySelector<HTMLElement>(`.dim-seg[data-option="${option}"] .dim-segment[data-id="${id}"]`)!;
const press = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
const enter = () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

/** Every tool a test opened, put away after it: one left open keeps its window keydown listener, and Move's takes
 *  the next test's Escape. */
const opened: { active: boolean; cancel(): void }[] = [];
function track<T extends { active: boolean; cancel(): void }>(tool: T): T {
  opened.push(tool);
  return tool;
}

/** Puts the handle under the pointer, or takes it away, without drawing a gizmo to aim at. */
function handleUnder(tool: object, method: string, on: () => unknown) {
  Object.assign(tool, { [method]: on });
}

beforeEach(() => {
  setActivePinia(createPinia());
  frames = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  for (const tool of opened.splice(0)) if (tool.active) tool.cancel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Press/Pull", () => {
  function setup(grab: boolean) {
    const vp = fakeViewport();
    const s = fakeStore();
    const tool = track(new PressPullTool(vp, s.store));
    let over = true;
    handleUnder(tool, "hitGizmo", () => over);
    handleUnder(tool, "hitTaper", () => false);
    const done = vi.fn();
    tool.start(done, grab ? { grabAt: { x: 0, y: 0 } } : undefined);
    return { tool, canvas: vp.domElement, ...s, done, away: () => (over = false) };
  }

  /** The press that starts the passive handle's drag already happened in faceNudge, so only the move and the
   *  release land on the canvas. */
  function fluentDrag(canvas: HTMLElement, to: number) {
    pointer(canvas, "pointermove", to);
    vi.advanceTimersByTime(500);
    pointer(canvas, "pointerup", to);
  }

  it("a drag from the selection handle, let go, leaves the tool open with the value and nothing committed", () => {
    const t = setup(true);
    fluentDrag(t.canvas, 50);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("5");
    expect(t.added).toEqual([]);
    expect(document.activeElement).toBe(input());
  });

  it("after the release a mode click changes the mode and commits nothing, Enter commits it once", () => {
    const t = setup(true);
    fluentDrag(t.canvas, 50);
    press(segment("mode", "new"));
    expect(segment("mode", "new").classList.contains("on")).toBe(true);
    expect(t.added).toEqual([]);
    enter();
    expect(t.added).toEqual([
      { id: "f1", type: "press-pull", face: FACE, distance: 5, operation: "join", mode: "new", body: "b1" },
    ]);
    expect(t.tool.active).toBe(false);
    expect(t.done).toHaveBeenCalledWith("f1");
  });

  it("a drag on the tool's own arrow stays open", () => {
    const t = setup(false);
    dragHandle(t.canvas, 0, 30);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("3");
    expect(t.added).toEqual([]);
  });

  it("a drag on the taper arc stays open, and Enter writes the taper", () => {
    const t = setup(false);
    dragHandle(t.canvas, 0, 30);
    handleUnder(t.tool, "hitTaper", () => true);
    dragHandle(t.canvas, 0, -10);
    expect(t.tool.active).toBe(true);
    expect(t.added).toEqual([]);
    const taper = Number(box().querySelectorAll("input")[1]!.value);
    expect(taper).not.toBe(0);
    enter();
    expect(t.added).toEqual([
      { id: "f1", type: "press-pull", face: FACE, distance: 3, operation: "join", body: "b1", taper },
    ]);
  });

  it("Esc after the release cancels", () => {
    const t = setup(true);
    fluentDrag(t.canvas, 50);
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.added).toEqual([]);
    expect(t.done).toHaveBeenCalledWith(null);
  });

  it("a plain click off the handle still commits, as before", () => {
    const t = setup(false);
    dragHandle(t.canvas, 0, 30);
    t.away();
    click(t.canvas, 200);
    expect(t.added).toEqual([{ id: "f1", type: "press-pull", face: FACE, distance: 3, operation: "join", body: "b1" }]);
  });

  describe("a push let go of but not entered", () => {
    const saving = (tool: PressPullTool) =>
      ({ store: { dirty: false }, tools: { pressPull: tool } }) as unknown as SaveEngine;

    it("is written once by a save, as Enter would", () => {
      const t = setup(true);
      fluentDrag(t.canvas, 50);
      expect(needsSave(saving(t.tool))).toBe(true);
      settleHeldEdit(saving(t.tool));
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([
        { id: "f1", type: "press-pull", face: FACE, distance: 5, operation: "join", body: "b1" },
      ]);
      expect(t.tool.active).toBe(false);
      expect(needsSave(saving(t.tool))).toBe(false);
    });

    it("is left alone by a save while the hand still holds it", () => {
      const t = setup(true);
      pointer(t.canvas, "pointermove", 50);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([]);
      expect(t.tool.active).toBe(true);
      pointer(t.canvas, "pointerup", 50);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toHaveLength(1);
    });

    it("tells its watchers, and Esc still cancels it and clears the mark", () => {
      const t = setup(true);
      const seen = vi.fn();
      t.tool.onHeldChange(seen);
      fluentDrag(t.canvas, 50);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(t.tool.pending).toBe(true);
      escape();
      expect(t.tool.active).toBe(false);
      expect(t.added).toEqual([]);
      expect(seen).toHaveBeenCalledTimes(2);
      expect(needsSave(saving(t.tool))).toBe(false);
    });

    it("stays quiet before any drag, and a save leaves the tool open", () => {
      const t = setup(false);
      const seen = vi.fn();
      t.tool.onHeldChange(seen);
      flushFrame();
      expect(needsSave(saving(t.tool))).toBe(false);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([]);
      expect(t.tool.active).toBe(true);
      expect(seen).not.toHaveBeenCalled();
    });
  });
});

describe("Fillet", () => {
  const EDGE = { kind: "edge", by: "nearest", point: [0, 0, 0], body: "b1" };
  function setup(grab: boolean) {
    const vp = fakeViewport({
      selectedEdgeSelectors: () => [EDGE],
      selectedEdgeScope: () => ({ scope: "single" }),
      edgeLineByMid: () => null,
      visibleEdgeLines: () => [],
      pickEdgeAt: () => null,
    });
    const s = fakeStore();
    const tool = track(new EdgeFeatureTool(vp, s.store));
    let over = true;
    handleUnder(tool, "hitGizmo", () => over);
    Object.assign(tool, { swipeProj: (_x: number, y: number) => y / 10, limit: () => Infinity });
    const done = vi.fn();
    tool.start("fillet", done, grab ? { grabAt: { x: 0, y: 0 } } : undefined);
    return { tool, canvas: vp.domElement, ...s, done, away: () => (over = false) };
  }

  function fluentDrag(canvas: HTMLElement, to: number) {
    pointer(canvas, "pointermove", to);
    vi.advanceTimersByTime(500);
    pointer(canvas, "pointerup", to);
  }

  it("a drag from the selection handle, let go, leaves the tool open with the radius and nothing committed", () => {
    const t = setup(true);
    fluentDrag(t.canvas, 20);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("2");
    expect(t.added).toEqual([]);
  });

  it("after the release a continuity click takes and commits nothing, Enter commits both once", () => {
    const t = setup(true);
    fluentDrag(t.canvas, 20);
    press(segment("continuity", "G2"));
    expect(segment("continuity", "G2").classList.contains("on")).toBe(true);
    expect(t.added).toEqual([]);
    enter();
    expect(t.added).toEqual([{ id: "f1", type: "fillet", radius: 2, edges: EDGE, continuity: "G2" }]);
    expect(t.tool.active).toBe(false);
  });

  it("Esc after the release cancels", () => {
    const t = setup(true);
    fluentDrag(t.canvas, 20);
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.added).toEqual([]);
  });

  it("a plain click off the handle still keeps the tool open, as before", () => {
    const t = setup(false);
    dragHandle(t.canvas, 0, 20);
    t.away();
    click(t.canvas, 200);
    expect(t.tool.active).toBe(true);
    expect(t.added).toEqual([]);
  });

  describe("a radius let go of but not entered", () => {
    const saving = (tool: EdgeFeatureTool) =>
      ({ store: { dirty: false }, tools: { edgeFeature: tool } }) as unknown as SaveEngine;
    const FILLET = { id: "f1", type: "fillet", radius: 2, edges: EDGE };

    it("is written once by a save, as Enter would", () => {
      const t = setup(true);
      fluentDrag(t.canvas, 20);
      expect(needsSave(saving(t.tool))).toBe(true);
      settleHeldEdit(saving(t.tool));
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([FILLET]);
      expect(t.tool.active).toBe(false);
      expect(needsSave(saving(t.tool))).toBe(false);
    });

    it("is left alone by a save while the hand grabs it again", () => {
      const t = setup(true);
      fluentDrag(t.canvas, 20);
      flushFrame();
      pointer(t.canvas, "pointerdown", 20);
      pointer(t.canvas, "pointermove", 30);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([]);
      expect(t.tool.active).toBe(true);
      vi.advanceTimersByTime(500);
      pointer(t.canvas, "pointerup", 30);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([{ ...FILLET, radius: 3 }]);
    });

    it("tells its watchers, and Esc still cancels it and clears the mark", () => {
      const t = setup(true);
      const seen = vi.fn();
      t.tool.onHeldChange(seen);
      fluentDrag(t.canvas, 20);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(t.tool.pending).toBe(true);
      escape();
      expect(t.tool.active).toBe(false);
      expect(t.added).toEqual([]);
      expect(seen).toHaveBeenCalledTimes(2);
      expect(needsSave(saving(t.tool))).toBe(false);
      t.tool.start("fillet", t.done);
      flushFrame();
      expect(needsSave(saving(t.tool))).toBe(false);
    });

    it("stays quiet on the default the command opens with, and a save leaves the tool open", () => {
      const t = setup(false);
      const seen = vi.fn();
      t.tool.onHeldChange(seen);
      flushFrame();
      expect(input().value).not.toBe("");
      expect(needsSave(saving(t.tool))).toBe(false);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([]);
      expect(t.tool.active).toBe(true);
      expect(seen).not.toHaveBeenCalled();
    });

    it("counts a typed radius", () => {
      const t = setup(false);
      input().value = "3";
      input().dispatchEvent(new Event("input", { bubbles: true }));
      flushFrame();
      expect(needsSave(saving(t.tool))).toBe(true);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([{ ...FILLET, radius: 3 }]);
    });
  });
});

describe("Draft", () => {
  /** A wall facing +X, 5 mm along Y from the model's corner, drafted against the Y pull. */
  function setup() {
    const vp = fakeViewport({
      selectedFacesForPressPull: () => ({
        selectors: [FACE],
        faceIds: [7],
        normal: new THREE.Vector3(1, 0, 0),
        anchor: new THREE.Vector3(0, 5, 0),
        bodyId: "b1",
      }),
    });
    const s = fakeStore();
    const tool = track(new DraftTool(vp, s.store));
    let over = true;
    handleUnder(tool, "hitGizmo", () => over);
    const done = vi.fn();
    tool.start(done);
    return { tool, canvas: vp.domElement, ...s, done, away: () => (over = false) };
  }

  it("a drag, let go, leaves the tool open with the angle and nothing committed", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 50);
    expect(t.tool.active).toBe(true);
    expect(Number(input().value)).toBeGreaterThan(0);
    expect(t.added).toEqual([]);
  });

  it("a press on the box after the release commits nothing, Enter commits the dragged angle once", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 50);
    const angle = Number(input().value);
    press(input());
    expect(t.added).toEqual([]);
    enter();
    flushFrame();
    expect(t.added).toEqual([{ id: "f1", type: "draft", faces: FACE, angle, axis: "Y" }]);
  });

  it("Esc after the release cancels", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 50);
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.added).toEqual([]);
  });

  it("a plain click off the handle still commits, as before", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 50);
    const angle = Number(input().value);
    t.away();
    click(t.canvas, 200);
    expect(t.added).toEqual([{ id: "f1", type: "draft", faces: FACE, angle, axis: "Y" }]);
  });
});

describe("Offset face and shell", () => {
  function setup(mode: "offsetFace" | "shell") {
    const vp = fakeViewport();
    const s = fakeStore();
    const tool = track(new FaceOffsetTool(vp, s.store));
    let over = true;
    handleUnder(tool, "hitGizmo", () => over);
    const done = vi.fn();
    tool.start(mode, done);
    return { tool, canvas: vp.domElement, ...s, done, away: () => (over = false) };
  }

  it("a drag, let go, leaves the tool open with the distance and nothing committed", () => {
    const t = setup("offsetFace");
    dragHandle(t.canvas, 0, 20);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("2");
    expect(t.added).toEqual([]);
  });

  it("a press on the box after the release commits nothing, Enter commits the dragged distance once", () => {
    const t = setup("offsetFace");
    dragHandle(t.canvas, 0, 20);
    press(input());
    expect(t.added).toEqual([]);
    enter();
    expect(t.added).toEqual([{ id: "f1", type: "offsetFace", faces: FACE, distance: 2, body: "b1" }]);
  });

  it("a shell drag stays open too, and Esc cancels it", () => {
    const t = setup("shell");
    dragHandle(t.canvas, 0, 20);
    expect(t.tool.active).toBe(true);
    expect(t.added).toEqual([]);
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.added).toEqual([]);
  });

  it("a plain click off the handle still commits, as before", () => {
    const t = setup("offsetFace");
    dragHandle(t.canvas, 0, 20);
    t.away();
    click(t.canvas, 200);
    expect(t.added).toHaveLength(1);
  });
});

describe("Extrude", () => {
  function setup(grab: boolean) {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const area = {
      sketchId: "s1",
      interior3D: new THREE.Vector3(0, 0, 0),
      plane: { n: new THREE.Vector3(0, 0, 1), plane, to2D: () => new THREE.Vector2(), to3D: () => new THREE.Vector3() },
      region: { loop: [] },
    };
    let selected: unknown[] = [area];
    const overlay = lenient({
      regions: [],
      selectedRegions: () => selected,
      clearRegionSelection: () => {
        selected = [];
      },
    });
    const vp = fakeViewport({ pointInSolid: () => false });
    const s = fakeStore({ hiddenBodyIds: () => undefined });
    const tool = track(new ExtrudeTool(vp, overlay as never, s.store));
    let over = false;
    handleUnder(tool, "hitGizmo", () => over);
    handleUnder(tool, "hitTaper", () => false);
    Object.assign(tool, { updatePreview: () => {}, positionDim: () => {} });
    const done = vi.fn();
    tool.start(done, grab ? { grabAt: { x: 0, y: 0 } } : undefined);
    return { tool, canvas: vp.domElement, ...s, done, over: (on: boolean) => (over = on) };
  }

  function fluentDrag(canvas: HTMLElement, to: number) {
    pointer(canvas, "pointermove", to);
    pointer(canvas, "pointerup", to);
  }

  const feature = (distance: number, more: Record<string, unknown> = {}) => ({
    id: "f1",
    type: "extrude",
    sketch: "s1",
    distance,
    operation: "new",
    regions: [[0, 0, 0]],
    ...more,
  });

  it("a drag from the profile's handle, let go, holds its depth while the hand goes to the box", () => {
    const t = setup(true);
    fluentDrag(t.canvas, 50);
    pointer(t.canvas, "pointermove", 300);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("5");
    expect(t.added).toEqual([]);
  });

  it("after the release a Symmetric click takes and commits nothing, Enter commits both once", () => {
    const t = setup(true);
    fluentDrag(t.canvas, 50);
    press(box().querySelector(".dim-toggle")!);
    expect(t.added).toEqual([]);
    enter();
    expect(t.added).toEqual([feature(5, { symmetric: true })]);
  });

  it("a drag on the depth arrow stays open, and Esc cancels", () => {
    const t = setup(false);
    pointer(t.canvas, "pointermove", 0);
    t.over(true);
    dragHandle(t.canvas, 0, 40);
    t.over(false);
    pointer(t.canvas, "pointermove", 300);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("4");
    expect(t.added).toEqual([]);
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.added).toEqual([]);
  });

  it("a plain click on the depth arrow still commits the depth, as before", () => {
    const t = setup(false);
    pointer(t.canvas, "pointermove", 30);
    t.over(true);
    click(t.canvas, 30);
    expect(t.added).toEqual([feature(3)]);
  });

  describe("a depth let go of but not entered", () => {
    const saving = (tool: ExtrudeTool) =>
      ({ store: { dirty: false }, tools: { extrude: tool } }) as unknown as SaveEngine;
    function armDrag(t: ReturnType<typeof setup>, from: number, to: number) {
      pointer(t.canvas, "pointermove", from);
      t.over(true);
      dragHandle(t.canvas, from, to);
    }

    it("is written once by a save, as Enter would", () => {
      const t = setup(true);
      fluentDrag(t.canvas, 50);
      expect(needsSave(saving(t.tool))).toBe(true);
      settleHeldEdit(saving(t.tool));
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([feature(5)]);
      expect(t.tool.active).toBe(false);
      expect(needsSave(saving(t.tool))).toBe(false);
    });

    it("is left alone by a save while the hand grabs it again", () => {
      const t = setup(false);
      armDrag(t, 0, 40);
      pointer(t.canvas, "pointerdown", 40);
      pointer(t.canvas, "pointermove", 60);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([]);
      expect(t.tool.active).toBe(true);
      pointer(t.canvas, "pointerup", 60);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([feature(6)]);
    });

    it("tells its watchers, and Esc still cancels it and clears the mark", () => {
      const t = setup(true);
      const seen = vi.fn();
      t.tool.onHeldChange(seen);
      fluentDrag(t.canvas, 50);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(t.tool.pending).toBe(true);
      escape();
      expect(t.tool.active).toBe(false);
      expect(t.added).toEqual([]);
      expect(seen).toHaveBeenCalledTimes(2);
      expect(needsSave(saving(t.tool))).toBe(false);
      t.tool.start(t.done);
      expect(needsSave(saving(t.tool))).toBe(false);
    });

    it("stays quiet while the depth only follows the cursor, and a save leaves the tool open", () => {
      const t = setup(false);
      const seen = vi.fn();
      t.tool.onHeldChange(seen);
      pointer(t.canvas, "pointermove", 30);
      expect(needsSave(saving(t.tool))).toBe(false);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([]);
      expect(t.tool.active).toBe(true);
      expect(seen).not.toHaveBeenCalled();
    });

    it("stays quiet on a drag back to no depth", () => {
      const t = setup(false);
      armDrag(t, 0, 40);
      dragHandle(t.canvas, 40, 0);
      expect(needsSave(saving(t.tool))).toBe(false);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([]);
      expect(t.tool.active).toBe(true);
    });

    it("counts a typed depth", () => {
      const t = setup(false);
      input().value = "7";
      input().dispatchEvent(new Event("input", { bubbles: true }));
      expect(needsSave(saving(t.tool))).toBe(true);
      settleHeldEdit(saving(t.tool));
      expect(t.added).toEqual([feature(7)]);
    });
  });
});

describe("Joint", () => {
  function setup() {
    const joint = { id: "j1", type: "joint" };
    const vp = fakeViewport();
    const updated: [string, unknown][] = [];
    const s = fakeStore({
      document: { features: [joint], parameters: {} },
      buildState: { result: { datumMarks: { j1: { kind: "axis", origin: [0, 0, 0], dir: [0, 0, 1] } } } },
      updateFeature: (id: string, patch: unknown) => updated.push([id, patch]),
    });
    const tool = track(new JointTool(vp, s.store));
    let over: "offset" | "angle" | null = "offset";
    handleUnder(tool, "pick", () => over);
    const done = vi.fn();
    expect(tool.startEdit("j1", done)).toBe(true);
    return { tool, canvas: vp.domElement, updated, done, away: () => (over = null) };
  }

  it("a drag on the arrow, let go, stays open with the offset and writes nothing", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 20);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("2");
    expect(t.updated).toEqual([]);
  });

  it("a press on the box after the release writes nothing, Enter writes the offset once", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 20);
    press(input());
    expect(t.updated).toEqual([]);
    enter();
    expect(t.updated).toEqual([["j1", { offset: 2, angle: undefined }]]);
  });

  it("Esc after the release cancels", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 20);
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.updated).toEqual([]);
  });

  it("a plain click off the handles still applies, as before", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 20);
    t.away();
    click(t.canvas, 200);
    expect(t.updated).toEqual([["j1", { offset: 2, angle: undefined }]]);
  });
});

describe("Mechanism", () => {
  function setup() {
    const mech = { id: "m1", type: "mechanism", drive: "d1", joints: [{ id: "d1", mode: "slider" }], offset: 0 };
    const vp = fakeViewport();
    const updated: [string, unknown][] = [];
    const s = fakeStore({
      document: { features: [mech], parameters: {} },
      buildState: { result: { datumMarks: { m1: { kind: "axis", origin: [0, 0, 0], dir: [0, 0, 1] } } } },
      updateFeature: (id: string, patch: unknown) => updated.push([id, patch]),
    });
    const tool = track(new MechanismTool(vp, s.store));
    let over = true;
    handleUnder(tool, "over", () => over);
    const done = vi.fn();
    expect(tool.startEdit("m1", done)).toBe(true);
    return { tool, canvas: vp.domElement, updated, done, away: () => (over = false) };
  }

  it("a drag, let go, stays open with the drive value and writes nothing", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 30);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("3");
    expect(t.updated).toEqual([]);
  });

  it("a press on the box after the release writes nothing, Enter writes the drive once", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 30);
    press(input());
    expect(t.updated).toEqual([]);
    enter();
    expect(t.updated).toEqual([["m1", { offset: 3 }]]);
  });

  it("Esc after the release cancels", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 30);
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.updated).toEqual([]);
  });

  it("a plain click off the handle still applies, as before", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 30);
    t.away();
    click(t.canvas, 200);
    expect(t.updated).toEqual([["m1", { offset: 3 }]]);
  });
});

describe("Datum plane pose edit", () => {
  const ZERO = { offset: 0, shiftX: 0, shiftY: 0, tiltX: 0, tiltY: 0, spin: 0 };
  function setup() {
    const vp = fakeViewport();
    const tool = track(new DatumPoseTool(vp));
    let over: "offset" | null = "offset";
    handleUnder(tool, "hit", () => over);
    const onStep = vi.fn();
    const done = vi.fn();
    tool.start({ src: "XY", pose: { ...ZERO }, ghost: false, onStep }, done);
    return { tool, canvas: vp.domElement, onStep, done, away: () => (over = null) };
  }

  it("a drag on the arrow, let go, stays open with the offset and writes nothing", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 20);
    expect(t.tool.active).toBe(true);
    expect(input().value).toBe("2");
    expect(t.onStep).not.toHaveBeenCalled();
  });

  it("a press on the box after the release writes nothing, Enter writes the pose once", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 20);
    press(input());
    expect(t.onStep).not.toHaveBeenCalled();
    enter();
    expect(t.onStep.mock.calls).toEqual([[{ ...ZERO, offset: 2 }]]);
    expect(t.tool.active).toBe(false);
  });

  it("Esc after the release cancels without writing", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 20);
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.onStep).not.toHaveBeenCalled();
    expect(t.done).toHaveBeenCalledWith(null);
  });

  it("a plain click off the handles still finishes, as before", () => {
    const t = setup();
    dragHandle(t.canvas, 0, 20);
    t.away();
    click(t.canvas, 200);
    expect(t.onStep.mock.calls).toEqual([[{ ...ZERO, offset: 2 }]]);
  });
});

describe("Move", () => {
  /** One gizmo unit is one world unit and the ray at y runs along +X at z = y, so a press at 40 lands on the Z
   *  arrow and a drag to 60 slides 20. */
  function setup() {
    const scene = new THREE.Scene();
    const ray = (y: number) => new THREE.Raycaster(new THREE.Vector3(-200, 0, y), new THREE.Vector3(1, 0, 0));
    const vp = fakeViewport({
      addToScene: (o: THREE.Object3D) => scene.add(o),
      removeFromScene: (o: THREE.Object3D) => scene.remove(o),
      pixelWorldSize: () => 1,
      rayFrom: (_x: number, y: number) => ray(y),
      probe: <T>(_x: number, y: number, test: (rc: THREE.Raycaster) => T) => test(ray(y)) || null,
      overlayOn: () => true,
      watchOverlays: () => () => {},
    });
    const sent: MoveResult[] = [];
    const target: MoveTarget = {
      frame: WORLD_FRAME,
      handles: ALL_HANDLES,
      uniformScale: false,
      canCopy: true,
      ownsEscape: true,
      centroid: () => new THREE.Vector3(),
      box: () => new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5)),
      begin: () => {},
      preview: () => {},
      commit: (c) => {
        sent.push(c);
        return { id: null, rebuild: false };
      },
      end: () => {},
      reopen: () => null,
    };
    const tool = track(new MoveTool(vp, fakeStore().store));
    const done = vi.fn();
    tool.startTarget(target, done);
    const drag = () => {
      flushFrame();
      scene.updateMatrixWorld(true);
      pointer(vp.domElement, "pointerdown", 40);
      pointer(vp.domElement, "pointermove", 60);
      pointer(vp.domElement, "pointerup", 60);
    };
    return { tool, canvas: vp.domElement, sent, done, drag };
  }

  const summary = (c: MoveResult) => ({ dz: c.values.dz, moved: c.moved, turned: c.turned, copy: c.copy });

  it("a drag, let go, keeps the gizmo up with the distance and writes nothing", () => {
    const t = setup();
    t.drag();
    expect(t.tool.active).toBe(true);
    expect(t.tool.pending).toBe(true);
    expect(input().value).toBe("20");
    expect(t.sent).toEqual([]);
  });

  it("after the release a Copy click takes and writes nothing, Enter writes both once", () => {
    const t = setup();
    t.drag();
    press(box().querySelector(".dim-toggle")!);
    expect(t.sent).toEqual([]);
    enter();
    expect(t.sent.map(summary)).toEqual([{ dz: 20, moved: true, turned: false, copy: true }]);
  });

  it("two drags before Enter are written as one move", () => {
    const t = setup();
    t.drag();
    t.drag();
    enter();
    expect(t.sent.map(summary)).toEqual([{ dz: 40, moved: true, turned: false, copy: false }]);
  });

  it("Esc after the release cancels", () => {
    const t = setup();
    t.drag();
    escape();
    expect(t.tool.active).toBe(false);
    expect(t.sent).toEqual([]);
    expect(t.done).toHaveBeenCalledWith(null);
  });

  it("a plain click off the handles still writes and ends, as before", () => {
    const t = setup();
    t.drag();
    click(t.canvas, 500);
    expect(t.sent.map(summary)).toEqual([{ dz: 20, moved: true, turned: false, copy: false }]);
    expect(t.tool.active).toBe(false);
  });

  it("settle writes a drag not yet entered, for a command that needs the gizmo gone", () => {
    const t = setup();
    t.drag();
    t.tool.settle();
    expect(t.sent.map(summary)).toEqual([{ dz: 20, moved: true, turned: false, copy: false }]);
    expect(t.tool.active).toBe(false);
  });
});
