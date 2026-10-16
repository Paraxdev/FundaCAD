import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNavigatorRig } from "../../../src/viewport/navigator/rig";
import { eyeOf } from "../../../src/viewport/navigator/pose";
const distanceOf = (p: Parameters<typeof eyeOf>[0]) => eyeOf(p).length();
import {
  DEFAULT_BINDINGS, bindingRows, pointerBindings, resolvePointer, setLeftButtonOwner, setPointerBindings,
  validateBindings, type PointerBinding, type PointerGesture,
} from "../../../src/viewport/navigator/bindings";
import { BoxScene, H, UNIT_BOX, W } from "./kit";

type Listener = (e: FakeEvent) => void;

class FakeEvent {
  type: string;
  defaultPrevented = false;
  cancelable = true;
  stopped = false;
  [k: string]: unknown;
  constructor(type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, { pointerId: 1, pointerType: "mouse", button: -1, buttons: 0, clientX: 0, clientY: 0, screenX: 0, screenY: 0, shiftKey: false, ctrlKey: false, altKey: false, deltaX: 0, deltaY: 0, deltaMode: 0 }, init);
    this.type = type;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}
class Native extends FakeEvent {}

function rigWithBox() {
  const listeners: Record<string, Listener[]> = {};
  const seen: { type: string; native: boolean; buttons: unknown }[] = [];
  const el = {
    style: {} as Record<string, string>,
    addEventListener: (t: string, f: Listener) => { (listeners[t] ??= []).push(f); },
    removeEventListener: (t: string, f: Listener) => { listeners[t] = (listeners[t] ?? []).filter((g) => g !== f); },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    dispatchEvent: (e: FakeEvent) => {
      for (const f of listeners[e.type] ?? []) { f(e); if (e.stopped) break; }
      return !e.defaultPrevented;
    },
  };
  const rig = createNavigatorRig(el as unknown as HTMLElement, W / H);
  const scene = new BoxScene([UNIT_BOX.clone()]);
  rig.setScene(scene);
  rig.setContentBox(scene.box());
  rig.setProjectionMode("persp");
  rig.resize(W, H);
  rig.fit(scene.box(), false);
  rig.navigator.opts.smoothTime = 0;
  rig.update(1 / 60);
  // The app behind the navigator, bound after it as the viewport and tools are.
  for (const t of ["pointerdown", "pointermove", "pointerup", "contextmenu"]) {
    el.addEventListener(t, (e) => { seen.push({ type: e.type, native: e instanceof Native, buttons: e.buttons }); });
  }
  const MASK: Record<number, number> = { 0: 1, 1: 4, 2: 2 };
  const fire = (type: string, button: number, x: number, mods: Record<string, boolean> = {}, y = 300) => {
    const e = new Native(type, {
      button: type === "pointermove" ? -1 : button, buttons: type === "pointerup" ? 0 : MASK[button], clientX: x, clientY: y, ...mods,
    });
    el.dispatchEvent(e);
    return e;
  };
  /** Press, move 60 px right, read what the navigator is doing, release. */
  const drag = (button: number, mods: Record<string, boolean> = {}) => {
    fire("pointerdown", button, 400, mods);
    fire("pointermove", button, 460, mods);
    const d = rig.navigator.dragging();
    fire("pointerup", button, 460, mods);
    return d;
  };
  const click = (button: number, mods: Record<string, boolean> = {}) => {
    fire("pointerdown", button, 400, mods);
    fire("pointerup", button, 401, mods);
  };
  const menus = () => seen.filter((s) => s.type === "contextmenu");
  return { rig, fire, drag, click, seen, menus };
}

const ALT_LEFT: PointerBinding[] = [
  { button: "left", alt: true, drag: "orbit" },
  { button: "right", shift: true, drag: "pan", click: "menu" },
  { button: "right", drag: "orbit", click: "menu" },
  { button: "middle", drag: "pan" },
];
const MIDDLE_ORBITS: PointerBinding[] = [
  { button: "middle", shift: true, drag: "pan" },
  { button: "middle", drag: "orbit" },
  { button: "right", click: "menu" },
];

beforeEach(() => {
  vi.stubGlobal("PointerEvent", FakeEvent);
  vi.stubGlobal("MouseEvent", FakeEvent);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setPointerBindings(null);
  setLeftButtonOwner(() => false);
});

describe("the default table is what the mouse did before there was a table", () => {
  it("matches the measured mapping", () => {
    const { drag } = rigWithBox();
    expect(drag(0)).toBe(null);
    expect(drag(0, { altKey: true })).toBe(null);
    expect(drag(1)).toBe("pan");
    expect(drag(1, { shiftKey: true })).toBe("pan");
    expect(drag(2)).toBe("orbit");
    expect(drag(2, { shiftKey: true })).toBe("pan");
    expect(drag(2, { ctrlKey: true })).toBe("orbit");
    expect(pointerBindings()).toBe(DEFAULT_BINDINGS);
  });
  it("leaves the right click menu to the browser", () => {
    const { click, menus } = rigWithBox();
    click(2);
    expect(menus()).toEqual([]);
  });
});

describe("Alt+left orbits", () => {
  it("orbits on Alt+left and the app never sees that press, its moves or its release", () => {
    setPointerBindings(ALT_LEFT);
    const { drag, seen } = rigWithBox();
    expect(drag(0, { altKey: true })).toBe("orbit");
    expect(seen).toEqual([]);
  });
  it("leaves a plain left press to the app", () => {
    setPointerBindings(ALT_LEFT);
    const { drag, seen } = rigWithBox();
    expect(drag(0)).toBe(null);
    expect(seen.map((s) => s.type)).toEqual(["pointerdown", "pointermove", "pointerup"]);
  });
  it("steps aside while a tool owns the left button", () => {
    setPointerBindings(ALT_LEFT);
    setLeftButtonOwner(() => true);
    const { drag, seen } = rigWithBox();
    expect(drag(0, { altKey: true })).toBe(null);
    expect(seen.length).toBe(3);
  });
});

describe("Middle orbits, Shift+middle pans", () => {
  it("moves orbit and pan to the middle button and frees the right drag", () => {
    setPointerBindings(MIDDLE_ORBITS);
    const { drag } = rigWithBox();
    expect(drag(1)).toBe("orbit");
    expect(drag(1, { shiftKey: true })).toBe("pan");
    expect(drag(2)).toBe(null);
  });
  it("keeps the right click menu", () => {
    setPointerBindings(MIDDLE_ORBITS);
    const { click, menus, fire } = rigWithBox();
    click(2);
    fire("contextmenu", 2, 400);
    expect(menus().length).toBe(1);
  });
});

describe("the context menu on another button", () => {
  const table: PointerBinding[] = [{ button: "middle", drag: "orbit", click: "menu" }, { button: "right", drag: "pan" }];
  it("sends one menu on a middle release without travel", () => {
    setPointerBindings(table);
    const { click, menus } = rigWithBox();
    click(1);
    expect(menus()).toEqual([{ type: "contextmenu", native: false, buttons: 0 }]);
  });
  it("sends none after a drag", () => {
    setPointerBindings(table);
    const { drag, menus } = rigWithBox();
    drag(1);
    expect(menus()).toEqual([]);
  });
  it("holds back the browser's right button menu", () => {
    setPointerBindings(table);
    const { click, fire, menus } = rigWithBox();
    click(2);
    fire("contextmenu", 2, 400);
    expect(menus()).toEqual([]);
  });
});

describe("a zoom drag", () => {
  it("zooms out dragging down and in dragging up, as the wheel does", () => {
    setPointerBindings([{ button: "middle", drag: "zoom" }, { button: "right", drag: "orbit", click: "menu" }]);
    const { rig, fire } = rigWithBox();
    const d0 = distanceOf(rig.navigator.pose);
    fire("pointerdown", 1, 400);
    expect(rig.navigator.dragging()).toBe("zoom");
    fire("pointermove", 1, 400, {}, 400);
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    const out = distanceOf(rig.navigator.pose);
    fire("pointermove", 1, 400, {}, 100);
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    const back = distanceOf(rig.navigator.pose);
    fire("pointerup", 1, 400, {}, 100);
    expect(out).toBeGreaterThan(d0 * 1.2);
    expect(back).toBeLessThan(out);
  });
});

describe("a gesture drag", () => {
  it("hands the press over once it has travelled, and a click is still the menu", () => {
    const got: PointerGesture[] = [];
    setPointerBindings([
      { button: "middle", drag: "orbit" },
      { button: "right", drag: "gesture", click: "menu" },
    ], (g) => got.push(g));
    const { fire, rig } = rigWithBox();
    fire("pointerdown", 2, 400);
    fire("pointermove", 2, 403);
    expect(got).toEqual([]);
    fire("pointermove", 2, 480);
    expect(got).toEqual([{ x: 400, y: 300, pointerId: 1, button: "right" }]);
    expect(rig.navigator.dragging()).toBe(null);
    fire("pointerup", 2, 480);
  });
});

describe("validateBindings", () => {
  it("names both actions bound to the same button and modifiers", () => {
    const bad = validateBindings([{ button: "middle", drag: "orbit" }, { button: "middle", drag: "gesture" }]);
    expect(bad.join()).toContain("Middle is bound twice, to orbit and to the radial menu");
  });
  it("refuses plain left, which selects", () => {
    expect(validateBindings([{ button: "left", drag: "orbit" }]).join()).toContain("is selection");
    expect(validateBindings([{ button: "left", alt: false, drag: "orbit" }, { button: "right", drag: "orbit" }]).join()).toContain("is selection");
  });
  it("refuses Shift+left and Ctrl+left, which add to the selection", () => {
    const orbit: PointerBinding = { button: "right", drag: "orbit" };
    expect(validateBindings([{ button: "left", shift: true, drag: "pan" }, orbit]).join()).toContain("Shift+left is selection");
    expect(validateBindings([{ button: "left", ctrl: true, drag: "zoom" }, orbit]).join()).toContain("Ctrl+left is selection");
    expect(validateBindings([{ button: "left", alt: true, shift: true, drag: "pan" }, orbit])).toEqual([]);
  });
  it("accepts the default and a modifier+left table", () => {
    expect(validateBindings(DEFAULT_BINDINGS)).toEqual([]);
    expect(validateBindings(ALT_LEFT)).toEqual([]);
  });
  it("refuses a table where nothing orbits, and setPointerBindings throws on it", () => {
    const t: PointerBinding[] = [{ button: "middle", drag: "pan" }];
    expect(validateBindings(t)).toContain("No button orbits the view");
    expect(() => setPointerBindings(t)).toThrow(/refused/);
    expect(pointerBindings()).toBe(DEFAULT_BINDINGS);
  });
  it("resolves Cmd as Ctrl", () => {
    const t: PointerBinding[] = [{ button: "middle", ctrl: true, drag: "pan" }, { button: "middle", drag: "orbit" }];
    expect(resolvePointer(t, { button: 1, shiftKey: false, ctrlKey: false, altKey: false, metaKey: true })?.drag).toBe("pan");
  });
  it("writes the ? sheet rows from the table", () => {
    expect(bindingRows(MIDDLE_ORBITS)).toEqual([
      { key: "Shift+middle drag", label: "Pan" },
      { key: "Middle drag", label: "Orbit" },
      { key: "Right click", label: "The context menu" },
    ]);
  });
});
