// The section's phases: editing shows the handle, the box and the F and G keys, and confirming keeps the cut on
// with none of them, so every other tool and key works over it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { SectionTool, type SectionDeps, type SectionPhase } from "../../src/features/sectionTool";
import { clipPlaneAt, sectionAnchor } from "../../src/features/sectionMath";
import { HANDLE_UP } from "../../src/features/manipulator";
import { usePromptStore } from "../../src/stores/prompt";
import type { Viewport } from "../../src/viewport/viewport";
import type { PlaneDef, SectionView, Vec3 } from "../../src/types";
import { readSectionView } from "../../src/document/sectionView";

const CENTRE: Vec3 = [37.5, -12, 20];

let frames = new Map<number, () => void>();
let nextFrame = 1;
const flushFrames = () => {
  const run = [...frames.values()];
  frames = new Map();
  for (const f of run) f();
};

type Sent = { normal: Vec3; constant: number; ghost: number } | null;

/** A viewport whose pointer ray at (x, y) runs along +X at height z = y, so a drag on the Z handle from y to y'
 *  moves the cut by y' - y. `hit` says whether the pointer is over the handle. */
function fakeViewport() {
  const scene = new THREE.Scene();
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  const sent: Sent[] = [];
  const state = { hit: false };
  const vp = {
    suspendPicking: false,
    domElement: canvas,
    camera,
    modelBox: () => new THREE.Box3(new THREE.Vector3(10, -40, 5), new THREE.Vector3(65, 16, 35)),
    setSectionView: (v: { plane: THREE.Plane; ghost: number } | null) =>
      sent.push(v ? { normal: v.plane.normal.toArray() as Vec3, constant: v.plane.constant, ghost: v.ghost } : null),
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    requestRender: () => {},
    pixelWorldSize: () => 1,
    projectToScreen: (p: THREE.Vector3) => ({ x: p.x, y: -p.z }),
    snapStep: () => 0.5,
    rayFrom: (_x: number, y: number) => new THREE.Raycaster(new THREE.Vector3(-200, 0, y), new THREE.Vector3(1, 0, 0)),
    probe: () => state.hit || null,
    showAllPlanes: () => {},
    clearHover: () => {},
    hoverDatum: () => {},
    hoverPlane: () => {},
    hoverFaceAt: () => {},
    pickDatumAt: () => null,
  };
  return { vp: vp as unknown as Viewport, scene, canvas, sent, state };
}

const plane = (offset: number, side: 1 | -1, ghost: number): Sent => ({
  ...clipPlaneAt(CENTRE, [0, 0, 1], offset, side),
  ghost,
});

const handles = (scene: THREE.Scene) => scene.children.filter((o) => o.userData.handle === "section");
const box = () => document.querySelector<HTMLElement>(".dim-input");
const input = () => document.querySelector<HTMLInputElement>(".dim-input input");
const prompt = () => usePromptStore().text;

function type(text: string) {
  const el = input()!;
  el.value = text;
  el.dispatchEvent(new Event("input"));
  return el;
}

function key(target: EventTarget, k: string) {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

function pointer(canvas: HTMLCanvasElement, type: string, y: number) {
  canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true }));
}

// Each tool's key listener sits on window, so a tool a test leaves editing would take the next test's keys.
const made: SectionTool[] = [];

function setup(deps: SectionDeps = {}) {
  const v = fakeViewport();
  const tool = new SectionTool(v.vp, deps);
  made.push(tool);
  return { ...v, tool };
}

describe("section phases", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      const id = nextFrame++;
      frames.set(id, fn);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => {
    for (const t of made.splice(0)) t.stop();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("an axis cut starts editing with the handle, the box and its check, and no cross", () => {
    const { tool, scene, sent } = setup();
    tool.start("Z");
    expect(tool.phase).toBe("editing");
    expect([tool.active, tool.editing, tool.picking]).toEqual([true, true, false]);
    expect(sent).toEqual([plane(0, 1, 0.14)]);
    expect(handles(scene)).toHaveLength(1);
    expect(box()?.style.display).toBe("flex");
    expect(document.querySelector(".dim-input .dim-ok")).not.toBeNull();
    expect(document.querySelector(".dim-input .dim-no")).toBeNull();
    expect(prompt()).toContain("Enter or Esc keeps the cut");
  });

  it("Enter on a typed offset keeps the cut on and puts the handle, box, prompt and frame away", () => {
    const { tool, scene, sent } = setup();
    tool.start("Z");
    key(type("-9.5"), "Enter");
    expect(tool.phase).toBe("on");
    expect([tool.active, tool.editing, tool.picking]).toEqual([true, false, false]);
    expect(sent.at(-1)).toEqual(plane(-9.5, 1, 0.14));
    expect(sent).not.toContain(null);
    expect(handles(scene)).toHaveLength(0);
    expect(box()?.style.display).toBe("none");
    expect(prompt()).toBeNull();
    flushFrames();
    expect(frames.size).toBe(0);
  });

  it("the check does what Enter does", () => {
    const { tool, sent } = setup();
    tool.start("Z");
    type("12.25");
    document.querySelector(".dim-input .dim-ok")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(tool.phase).toBe("on");
    expect(sent.at(-1)).toEqual(plane(12.25, 1, 0.14));
  });

  it("an offset the box refuses keeps editing", () => {
    const { tool, sent } = setup();
    tool.start("Z");
    key(type("abc"), "Enter");
    expect(tool.phase).toBe("editing");
    expect(sent).toEqual([plane(0, 1, 0.14)]);
  });

  it("Esc in the box or on the canvas keeps the cut on", () => {
    for (const where of ["box", "canvas"] as const) {
      const { tool, canvas, sent } = setup();
      tool.start("Z");
      const target = where === "box" ? type("-4") : canvas;
      key(target, "Escape");
      expect(tool.phase).toBe("on");
      expect(sent.at(-1)).toEqual(plane(where === "box" ? -4 : 0, 1, 0.14));
      expect(sent).not.toContain(null);
      tool.stop();
      document.body.innerHTML = "";
    }
  });

  it("Esc while aiming ends with no cut and calls onDone once", () => {
    const { tool, canvas, sent } = setup();
    const done = vi.fn();
    tool.start({ kind: "pick" }, done);
    expect(tool.phase).toBe("aiming");
    expect(tool.picking).toBe(true);
    key(canvas, "Escape");
    expect(tool.phase).toBe("off");
    expect(done).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it("F flips while editing and is left to Fillet once the cut is on", () => {
    const { tool, canvas, sent } = setup();
    const later = vi.fn();
    window.addEventListener("keydown", later);
    tool.start("Z");
    key(canvas, "f");
    expect(sent.at(-1)).toEqual(plane(0, -1, 0.14));
    expect(later).not.toHaveBeenCalled();

    key(canvas, "Escape");
    const count = sent.length;
    key(canvas, "F");
    expect(sent).toHaveLength(count);
    expect(later).toHaveBeenCalledTimes(2);
    window.removeEventListener("keydown", later);
  });

  it("F and G in the box flip and step the ghost until something is typed, then they are text", () => {
    const { tool, sent } = setup();
    const later = vi.fn();
    window.addEventListener("keydown", later);
    tool.start("Z");
    const pressed = [key(input()!, "f"), key(input()!, "G"), key(input()!, "F")];
    expect(pressed.map((e) => e.defaultPrevented)).toEqual([true, true, true]);
    expect(sent).toEqual([plane(0, 1, 0.14), plane(0, -1, 0.14), plane(0, -1, 0.3), plane(0, 1, 0.3)]);
    expect(later).not.toHaveBeenCalled();
    expect(input()!.value).toBe("0");

    type("4");
    const typed = [key(input()!, "f"), key(input()!, "g")];
    expect(typed.map((e) => e.defaultPrevented)).toEqual([false, false]);
    expect(sent).toHaveLength(4);
    expect(tool.phase).toBe("editing");
    window.removeEventListener("keydown", later);
  });

  it("Ctrl+F and Alt+G are left to the app while editing, on the canvas and in the box", () => {
    const { tool, canvas, sent } = setup();
    tool.start("Z");
    for (const target of [canvas, input()!]) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "g", altKey: true, bubbles: true, cancelable: true }));
    }
    expect(sent).toEqual([plane(0, 1, 0.14)]);
  });

  it("G cycles the ghost while editing and does nothing once the cut is on", () => {
    const { tool, canvas, sent } = setup();
    tool.start("Z");
    for (let i = 0; i < 3; i++) key(canvas, "g");
    expect(sent.map((s) => s?.ghost)).toEqual([0.14, 0.3, 0, 0.06]);
    expect(prompt()).toContain("(faint)");
    key(canvas, "Escape");
    key(canvas, "G");
    expect(sent.map((s) => s?.ghost)).toEqual([0.14, 0.3, 0, 0.06]);
  });

  it("another tool turning busy confirms the edit, without clearing that tool's prompt", () => {
    let busy = false;
    const afterEdit = vi.fn();
    const { tool, scene } = setup({ toolBusy: () => busy, afterEdit });
    tool.start("Z");
    flushFrames();
    expect(tool.phase).toBe("editing");
    busy = true;
    usePromptStore().text = "Fillet: pick edges";
    flushFrames();
    expect(tool.phase).toBe("on");
    expect(handles(scene)).toHaveLength(0);
    expect(prompt()).toBe("Fillet: pick edges");
    expect(afterEdit).not.toHaveBeenCalled();
  });

  it("a chooser or dialog turning busy without a prompt of its own takes the editing prompt away", () => {
    let busy = false;
    const { tool } = setup({ toolBusy: () => busy });
    tool.start("Z");
    flushFrames();
    expect(prompt()).toContain("F flips");
    busy = true;
    flushFrames();
    expect([tool.phase, prompt()]).toEqual(["on", null]);
  });

  it("a tool already busy when editing starts does not confirm it until it drops and rises again", () => {
    let busy = true;
    const { tool } = setup({ toolBusy: () => busy });
    tool.start("Z");
    flushFrames();
    flushFrames();
    expect(tool.phase).toBe("editing");
    busy = false;
    flushFrames();
    expect(tool.phase).toBe("editing");
    busy = true;
    flushFrames();
    expect(tool.phase).toBe("on");
  });

  it("afterEdit follows Enter, Esc and confirm(), once each", () => {
    const afterEdit = vi.fn();
    const { tool, canvas } = setup({ afterEdit });
    tool.start("Z");
    key(type("3"), "Enter");
    expect(afterEdit).toHaveBeenCalledTimes(1);
    tool.edit();
    key(canvas, "Escape");
    expect(afterEdit).toHaveBeenCalledTimes(2);
    tool.edit();
    tool.confirm();
    tool.confirm();
    expect(afterEdit).toHaveBeenCalledTimes(3);
  });

  it("edit() brings the handle back on the same cut, and only from the on phase", () => {
    const { tool, scene, sent } = setup();
    tool.edit();
    expect(tool.phase).toBe("off");
    expect(sent).toEqual([]);

    tool.start("Z");
    key(canvas(), "f");
    key(type("-9.5"), "Enter");
    const count = sent.length;
    tool.edit();
    expect(tool.phase).toBe("editing");
    expect(handles(scene)).toHaveLength(1);
    expect(Number(input()!.value)).toBe(-9.5);
    expect(sent).toHaveLength(count);
    expect(sent.at(-1)).toEqual(plane(-9.5, -1, 0.14));

    tool.edit();
    expect(handles(scene)).toHaveLength(1);
    expect(sent).toHaveLength(count);

    function canvas() {
      return document.querySelector("canvas")!;
    }
  });

  it("Edit shows a cut below its plane signed, so Tab and Enter, or a new number, keep it on that side", () => {
    const { tool, sent } = setup();
    tool.start("Z");
    key(type("-9.5"), "Enter");
    tool.edit();
    expect(input()!.value).toBe("-9.5");
    key(input()!, "Tab");
    key(input()!, "Enter");
    expect([tool.phase, sent.at(-1)]).toEqual(["on", plane(-9.5, 1, 0.14)]);
    tool.edit();
    key(type("-12.25"), "Enter");
    expect(sent.at(-1)).toEqual(plane(-12.25, 1, 0.14));
  });

  it("a drag below the plane shows the signed offset", () => {
    const { tool, canvas, state, sent } = setup();
    tool.start("Z");
    flushFrames();
    state.hit = true;
    pointer(canvas, "pointerdown", 30);
    pointer(canvas, "pointermove", 23.5);
    pointer(canvas, "pointerup", 23.5);
    expect([sent.at(-1), Number(input()!.value)]).toEqual([plane(-6.5, 1, 0.14), -6.5]);
  });

  it("flip() keeps the other half while on, and does nothing while off", () => {
    const { tool, sent } = setup();
    tool.flip();
    expect(sent).toEqual([]);
    tool.start("Z");
    tool.confirm();
    tool.flip();
    expect(tool.phase).toBe("on");
    expect(sent).toEqual([plane(0, 1, 0.14), plane(0, -1, 0.14)]);
  });

  it("stop() removes the cut from on and from editing, and only ends the aim from aiming", () => {
    for (const from of ["on", "editing"] as const) {
      const { tool, scene, sent } = setup();
      tool.start("Z");
      if (from === "on") tool.confirm();
      tool.stop();
      expect(tool.phase).toBe("off");
      expect(sent.at(-1)).toBeNull();
      expect(handles(scene)).toHaveLength(0);
      document.body.innerHTML = "";
    }
    const { tool, sent } = setup();
    const done = vi.fn();
    tool.start({ kind: "pick" }, done);
    tool.stop();
    expect(tool.phase).toBe("off");
    expect(done).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it("endEdit() keeps an edited cut on, ends an aim, and leaves a cut that is on alone", () => {
    const a = setup();
    a.tool.start("Z");
    a.tool.endEdit();
    expect(a.tool.phase).toBe("on");
    expect(a.sent).toEqual([plane(0, 1, 0.14)]);
    a.tool.endEdit();
    expect(a.tool.phase).toBe("on");
    expect(a.sent).toHaveLength(1);

    const b = setup();
    const done = vi.fn();
    b.tool.start({ kind: "pick" }, done);
    b.tool.endEdit();
    expect(b.tool.phase).toBe("off");
    expect(done).toHaveBeenCalledTimes(1);
    expect(b.sent).toEqual([]);
  });

  it("start() is refused while aiming, editing or on", () => {
    for (const from of ["aiming", "editing", "on"] as const) {
      const { tool, sent } = setup();
      if (from === "aiming") tool.start({ kind: "pick" });
      else tool.start("Z");
      if (from === "on") tool.confirm();
      const count = sent.length;
      tool.start("X");
      expect(tool.phase).toBe(from);
      expect(sent).toHaveLength(count);
      tool.stop();
      document.body.innerHTML = "";
    }
  });

  it("a drag on the handle moves the cut by the pointer's travel", () => {
    const { tool, canvas, state, sent } = setup();
    tool.start("Z");
    flushFrames();
    state.hit = true;
    pointer(canvas, "pointerdown", 30);
    pointer(canvas, "pointermove", 37.5);
    pointer(canvas, "pointerup", 37.5);
    expect(sent.at(-1)).toEqual(plane(7.5, 1, 0.14));
    expect(Number(input()!.value)).toBe(7.5);
  });

  it("a slanted plane drags along its own normal, and F flips the kept side and the handle about it", () => {
    const def: PlaneDef = { origin: [52, -7, 31], normal: [0, -0.6, 0.8], xdir: [1, 0, 0] };
    const anchor = sectionAnchor(def.origin, def.normal, CENTRE);
    const at = (offset: number, side: 1 | -1): Sent => ({ ...clipPlaneAt(anchor, def.normal, offset, side), ghost: 0.14 });
    const { tool, canvas, state, sent, scene } = setup();
    tool.start({ kind: "plane", def });
    flushFrames();
    expect(sent).toEqual([at(0, 1)]);
    state.hit = true;
    // The pointer ray runs along +X at height z = y, so it meets this normal's line 0.8 per unit of y.
    pointer(canvas, "pointerdown", 30);
    pointer(canvas, "pointermove", 42.5);
    pointer(canvas, "pointerup", 42.5);
    expect(sent.at(-1)).toEqual(at(10, 1));
    key(canvas, "f");
    flushFrames();
    expect(sent.at(-1)).toEqual(at(10, -1));
    const handle = handles(scene)[0]!;
    const round = (v: THREE.Vector3) => v.toArray().map((x) => Math.round(x * 1e6) / 1e6 + 0);
    expect(round(handle.position)).toEqual(round(new THREE.Vector3(...anchor).addScaledVector(new THREE.Vector3(...def.normal), 10)));
    expect(round(HANDLE_UP.clone().applyQuaternion(handle.quaternion))).toEqual([0, 0.6, -0.8]);
  });

  it("onChange reports every phase until it is unsubscribed", () => {
    const { tool, canvas } = setup();
    const seen: SectionPhase[] = [];
    const off = tool.onChange((p) => seen.push(p));
    tool.start("Z");
    key(type("2"), "Enter");
    tool.edit();
    key(canvas, "Escape");
    tool.stop();
    expect(seen).toEqual(["off", "editing", "on", "editing", "on", "off"]);
    off();
    tool.start("Y");
    expect(seen).toHaveLength(6);
  });
});

/** A store that normalises what it is given, as DocumentStore does, and tells every listener. */
function fakeSaved(initial: SectionView | null = null) {
  let cut = initial && readSectionView(initial);
  const writes: (SectionView | null)[] = [];
  const listeners = new Set<(v: SectionView | null) => void>();
  const tell = () => { for (const fn of [...listeners]) fn(cut); };
  return {
    writes,
    saved: {
      get: () => cut,
      set: (v: SectionView | null) => {
        writes.push(v && structuredClone(v));
        cut = v && readSectionView(v);
        tell();
      },
      onChange: (fn: (v: SectionView | null) => void) => {
        listeners.add(fn);
        fn(cut);
        return () => { listeners.delete(fn); };
      },
    },
    outside: (v: SectionView | null) => {
      cut = v && readSectionView(v);
      tell();
    },
  };
}

describe("the section and its saved cut", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      const id = nextFrame++;
      frames.set(id, fn);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => {
    for (const t of made.splice(0)) t.stop();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const cut = (offset: number, extra: Partial<SectionView> = {}): SectionView =>
    ({ origin: CENTRE, normal: [0, 0, 1], offset, side: 1, ghost: "soft", ...extra });
  const OTHER: SectionView = { origin: [-14, 33, 7.5], normal: [0, -0.8, 0.6], offset: 4.75, side: -1, ghost: "strong" };

  it("writes the cut when it starts, on each drag step and on Enter, and null on Off", () => {
    const store = fakeSaved();
    const { tool, canvas, state } = setup({ saved: store.saved });
    tool.start("Z");
    flushFrames();
    state.hit = true;
    pointer(canvas, "pointerdown", 30);
    pointer(canvas, "pointermove", 34);
    pointer(canvas, "pointermove", 37.5);
    pointer(canvas, "pointerup", 37.5);
    key(type("-2"), "Enter");
    tool.stop();
    expect(store.writes).toEqual([cut(0), cut(4), cut(7.5), cut(-2), null]);
  });

  it("writes a flip and a ghost step, and nothing for edit() or a confirm with nothing typed", () => {
    const store = fakeSaved();
    const { tool, canvas } = setup({ saved: store.saved });
    tool.start("Z");
    key(canvas, "g");
    tool.confirm();
    tool.edit();
    tool.confirm();
    tool.flip();
    expect(store.writes).toEqual([cut(0), cut(0, { ghost: "strong" }), cut(0, { ghost: "strong", side: -1 })]);
  });

  it("does not take the echo of its own write, normalised, for a change", () => {
    const store = fakeSaved();
    const { tool, sent, canvas } = setup({ saved: store.saved });
    tool.start({ kind: "plane", def: { origin: [37.5, -12, 2], normal: [0, 0, 2], xdir: [1, 0, 0] } });
    key(canvas, "g");
    expect(tool.phase).toBe("editing");
    expect(store.writes).toEqual([
      cut(0, { origin: [37.5, -12, 2], normal: [0, 0, 2] }),
      cut(0, { origin: [37.5, -12, 2], normal: [0, 0, 2], ghost: "strong" }),
    ]);
    expect(store.saved.get()).toEqual(cut(0, { origin: [37.5, -12, 2], ghost: "strong" }));
    const at = clipPlaneAt([37.5, -12, 2], [0, 0, 1], 0, 1);
    expect(sent).toEqual([{ ...at, ghost: 0.14 }, { ...at, ghost: 0.3 }]);
  });

  it("takes on a cut changed under it: an edit ends, an aim ends once, and null turns it off", () => {
    const a = fakeSaved();
    const one = setup({ saved: a.saved });
    one.tool.start("Z");
    a.outside(OTHER);
    expect(one.tool.phase).toBe("on");
    expect(handles(one.scene)).toHaveLength(0);
    expect(one.sent.at(-1)).toEqual({ ...clipPlaneAt(OTHER.origin, OTHER.normal, 4.75, -1), ghost: 0.3 });
    a.outside(null);
    expect(one.tool.phase).toBe("off");
    expect(one.sent.at(-1)).toBeNull();
    expect(a.writes).toEqual([cut(0)]);

    const b = fakeSaved();
    const two = setup({ saved: b.saved });
    const done = vi.fn();
    two.tool.start({ kind: "pick" }, done);
    b.outside(OTHER);
    expect(two.tool.phase).toBe("on");
    expect(done).toHaveBeenCalledTimes(1);
    expect(b.writes).toEqual([]);
  });

  it("keeps an edit on a long normal when the store's unit length reading of that cut comes back from outside", () => {
    const store = fakeSaved();
    const { tool } = setup({ saved: store.saved });
    const def: PlaneDef = { origin: [41.25, -17.5, 9], normal: [1.5, -2, 6], xdir: [1, 0, 0] };
    tool.start({ kind: "plane", def });
    const read = store.saved.get()!;
    expect(read.normal).toEqual([1.5 / 6.5, -2 / 6.5, 6 / 6.5]);
    store.outside(structuredClone(read));
    expect(tool.phase).toBe("editing");
    store.outside({ ...read, normal: [-2 / 6.5, 1.5 / 6.5, 6 / 6.5] });
    expect(tool.phase).toBe("on");
  });

  it("leaves an edit alone when the same cut comes back from outside", () => {
    const store = fakeSaved();
    const { tool } = setup({ saved: store.saved });
    tool.start("Z");
    store.outside(cut(0));
    expect(tool.phase).toBe("editing");
  });

  it("puts a saved cut on when it is made, with that cut's ghost", () => {
    const store = fakeSaved(OTHER);
    const { tool, sent, scene } = setup({ saved: store.saved });
    expect(tool.phase).toBe("on");
    expect(sent).toEqual([{ ...clipPlaneAt(OTHER.origin, OTHER.normal, 4.75, -1), ghost: 0.3 }]);
    expect(handles(scene)).toHaveLength(0);
    tool.edit();
    expect(Number(input()!.value)).toBe(4.75);
  });
});
