// The move gizmo's session lifecycle, as a plugin driving startTarget sees it:
// switching targets, a drag that waits on a rebuild, and the owner cancelling.
// What is measured is the scene: a handle set left in it after its session is
// over is a gizmo drawn on screen that nothing answers to.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { MoveTool } from "../../src/features/moveTool";
import { ALL_HANDLES, WORLD_FRAME, type MoveCommit, type MoveTarget } from "../../src/features/moveTarget";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};

/** A viewport where one gizmo unit is one world unit, and the pointer ray at
 *  (x, y) runs along +X at height z = y, so pressing at y lands on the Z arrow
 *  y units up it and dragging to y' slides by y' - y. */
function fakeViewport() {
  const scene = new THREE.Scene();
  const canvas = document.createElement("canvas");
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    camera,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 1,
    projectToScreen: (p: THREE.Vector3) => ({ x: p.x, y: -p.z }),
    hoverThrough: () => {},
    rayFrom: (_x: number, y: number) =>
      new THREE.Raycaster(new THREE.Vector3(-200, 0, y), new THREE.Vector3(1, 0, 0)),
    screenToPlane: () => null,
    pointAt: () => null,
  };
  return { vp: vp as unknown as Viewport, scene, canvas };
}

function fakeStore() {
  const listeners = new Set<(s: { building: boolean }) => void>();
  const store = {
    onBuild(fn: (s: { building: boolean }) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const build = () => {
    for (const fn of [...listeners]) fn({ building: true });
    for (const fn of [...listeners]) fn({ building: false });
  };
  return { store: store as unknown as DocumentStore, build };
}

interface Probe {
  target: MoveTarget;
  began: number;
  ends: boolean[];
  commits: number;
  sent: { dz: number; sized: boolean }[];
  scales: number[];
}

function probe(at: [number, number, number], opts: { rebuild?: boolean; reopen?: () => MoveTarget | null } = {}): Probe {
  const p: Probe = { target: null as unknown as MoveTarget, began: 0, ends: [], commits: 0, sent: [], scales: [] };
  const c = new THREE.Vector3(...at);
  p.target = {
    frame: WORLD_FRAME,
    handles: ALL_HANDLES,
    uniformScale: false,
    canCopy: false,
    ownsEscape: true,
    centroid: () => c.clone(),
    box: () => new THREE.Box3(c.clone().subScalar(5), c.clone().addScalar(5)),
    begin: () => { p.began++; },
    preview: () => {},
    commit: (c): MoveCommit => {
      p.commits++;
      p.sent.push({ dz: c.values.dz, sized: c.sized });
      p.scales.push(c.scale.z);
      return { id: null, rebuild: opts.rebuild ?? false };
    },
    end: (restore) => { p.ends.push(restore); },
    reopen: opts.reopen ?? (() => probe(at, opts).target),
  };
  return p;
}

/** The gizmo arrows in the scene: each carries its frame axis as a number. */
function gizmoArrows(scene: THREE.Scene): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  scene.traverse((o) => { if (typeof o.userData.axis === "number") out.push(o); });
  return out;
}

function pointer(canvas: HTMLCanvasElement, type: string, y: number) {
  canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true }));
}

/** Drag the Z arrow from 40 to 60 units up it and let go. The frame places the
 *  gizmo and the matrix update stands in for the render the raycast relies on. */
function dragZ(canvas: HTMLCanvasElement, scene: THREE.Scene) {
  flushFrame();
  scene.updateMatrixWorld(true);
  pointer(canvas, "pointerdown", 40);
  pointer(canvas, "pointermove", 60);
  pointer(canvas, "pointerup", 60);
}

describe("move gizmo lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frames.push(fn); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("a second target replaces the gizmo on the first, rather than being ignored", () => {
    const { vp, scene } = fakeViewport();
    const tool = new MoveTool(vp, fakeStore().store);
    const a = probe([0, 0, 0]);
    const b = probe([50, 0, 0]);
    const doneA = vi.fn();
    tool.startTarget(a.target, doneA);
    tool.startTarget(b.target, () => {});
    flushFrame();

    expect(a.ends).toContain(true);
    expect(doneA).toHaveBeenCalledWith(null);
    expect(b.began).toBe(1);
    const arrows = gizmoArrows(scene);
    expect(arrows).toHaveLength(3);
    expect(arrows[0]!.parent!.position.x).toBe(50);
  });

  it("switching targets and then ending the tool leaves no handles in the scene", () => {
    const { vp, scene } = fakeViewport();
    const tool = new MoveTool(vp, fakeStore().store);
    tool.startTarget(probe([0, 0, 0]).target, () => {});
    tool.startTarget(probe([50, 0, 0]).target, () => {});
    tool.startTarget(probe([0, 50, 0]).target, () => {});
    tool.cancel();

    expect(tool.active).toBe(false);
    expect(gizmoArrows(scene)).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
  });

  it("a drag settles and the gizmo comes straight back on the same target", () => {
    const { vp, scene, canvas } = fakeViewport();
    const tool = new MoveTool(vp, fakeStore().store);
    const a = probe([0, 0, 0]);
    tool.startTarget(a.target, () => {});
    dragZ(canvas, scene);

    expect(a.commits).toBe(1);
    expect(tool.active).toBe(true);
    expect(gizmoArrows(scene)).toHaveLength(3);
  });

  it("a drag waiting on its rebuild does not come back once the owner cancelled", () => {
    const { vp, scene, canvas } = fakeViewport();
    const { store, build } = fakeStore();
    const tool = new MoveTool(vp, store);
    tool.startTarget(probe([0, 0, 0], { rebuild: true }).target, () => {});
    dragZ(canvas, scene);
    expect(tool.active).toBe(false);

    tool.cancel();
    build();

    expect(tool.active).toBe(false);
    expect(gizmoArrows(scene)).toHaveLength(0);
  });

  it("a drag waiting on its rebuild asks its target again only once the rebuild lands", () => {
    const { vp, scene, canvas } = fakeViewport();
    const { store, build } = fakeStore();
    const tool = new MoveTool(vp, store);
    let ownerOpen = true;
    const reopen = () => (ownerOpen ? probe([0, 0, 0]).target : null);
    tool.startTarget(probe([0, 0, 0], { rebuild: true, reopen }).target, () => {});
    dragZ(canvas, scene);

    ownerOpen = false;
    build();

    expect(tool.active).toBe(false);
    expect(gizmoArrows(scene)).toHaveLength(0);
  });

  it("a new target started while a drag waits on its rebuild is not replaced by the old one", () => {
    const { vp, scene, canvas } = fakeViewport();
    const { store, build } = fakeStore();
    const tool = new MoveTool(vp, store);
    tool.startTarget(probe([0, 0, 0], { rebuild: true }).target, () => {});
    dragZ(canvas, scene);
    const b = probe([50, 0, 0]);
    tool.startTarget(b.target, () => {});
    tool.cancel();
    build();

    expect(tool.active).toBe(false);
    expect(gizmoArrows(scene)).toHaveLength(0);
  });

  it("cancel with nothing up does not tell the last session it ended a second time", () => {
    const { vp } = fakeViewport();
    const tool = new MoveTool(vp, fakeStore().store);
    const done = vi.fn();
    tool.startTarget(probe([0, 0, 0]).target, done);
    tool.cancel();
    vp.suspendPicking = true;
    tool.cancel();

    expect(done).toHaveBeenCalledTimes(1);
    expect(vp.suspendPicking).toBe(true);
  });
});

describe("a typed move", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frames.push(fn); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const field = () => document.querySelector<HTMLInputElement>(".dim-input input")!;
  const typeAndEnter = (text: string) => {
    field().value = text;
    field().dispatchEvent(new Event("input", { bubbles: true }));
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  const problem = () => document.querySelector(".dim-problem")?.textContent ?? null;

  function setup() {
    const { vp, scene, canvas } = fakeViewport();
    const tool = new MoveTool(vp, fakeStore().store);
    const a = probe([0, 0, 0]);
    a.target.reopen = () => a.target;
    tool.startTarget(a.target, () => {});
    flushFrame();
    scene.updateMatrixWorld(true);
    return { tool, a, canvas };
  }

  it("goes along an arrow that was only clicked, sign and all", () => {
    // The click re-opens the gizmo at once, having moved nothing, and that
    // re-open used to forget which arrow was picked, so the typed -2 went nowhere.
    const { a, canvas } = setup();
    pointer(canvas, "pointerdown", 40);
    pointer(canvas, "pointerup", 40);
    typeAndEnter("-2");
    expect(a.sent).toEqual([{ dz: -2, sized: false }]);
  });

  const typeInto = (el: HTMLInputElement, text: string) => {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  const scaleField = () =>
    [...document.querySelectorAll<HTMLInputElement>(".dim-input input")].find((i) =>
      i.closest("label")?.textContent?.includes("Scale"))!;
  /** The Z cube stands past the arrow's tip, at SCALE_AT gizmo units. */
  const clickZCube = (canvas: HTMLCanvasElement) => {
    pointer(canvas, "pointerdown", 79);
    pointer(canvas, "pointerup", 79);
  };

  it("puts typing in the Scale field after a cube click, and scales along that cube", () => {
    const { a, canvas } = setup();
    clickZCube(canvas);
    flushFrame();
    expect(document.activeElement).toBe(scaleField());
    typeInto(scaleField(), "3");
    expect(a.sent).toEqual([{ dz: 0, sized: true }]);
    expect(a.scales).toEqual([3]);
  });

  it("refuses a distance typed into Move while only a cube is picked, pointing at Scale", () => {
    const { a, tool, canvas } = setup();
    clickZCube(canvas);
    typeAndEnter("-2");
    expect(a.commits).toBe(0);
    expect(tool.active).toBe(true);
    expect(problem()).toMatch(/Scale/);
  });

  it("with no arrow picked, stays open and says so instead of closing on nothing", () => {
    const { tool, a } = setup();
    typeAndEnter("-2");
    expect(a.commits).toBe(0);
    expect(tool.active).toBe(true);
    expect(problem()).toMatch(/Click an arrow/);
  });
});
