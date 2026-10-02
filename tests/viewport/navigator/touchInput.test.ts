// Touch and touchpad input through the navigator rig, with a stub canvas that
// keeps the order listeners were added in and honours stopImmediatePropagation,
// preventDefault and dispatchEvent the way a browser does for one element.
//
// One finger orbits once it moves, two pan and pinch, a tap reaches the app as
// a press and a release, a press a tool claims is the tool's, and a long press
// is a right click. Wheel streams are read as a mouse or a touchpad: a mouse
// zooms, a touchpad orbits (Shift pans) and its pinch zooms.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNavigatorRig } from "../../../src/viewport/navigator/rig";
import { LONG_PRESS_MS, replayedPress } from "../../../src/viewport/navigator/input";
import { getNavPrefs, setNavPrefs } from "../../../src/ui/interactionPrefs";
import { BoxScene, H, UNIT_BOX, W } from "./kit";

type Listener = (e: FakeEvent) => void;

class FakeEvent {
  type: string;
  defaultPrevented = false;
  cancelable = true;
  stopped = false;
  [k: string]: unknown;
  constructor(type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, { pointerId: 1, pointerType: "mouse", button: -1, buttons: 0, clientX: 0, clientY: 0, screenX: 0, screenY: 0, shiftKey: false, ctrlKey: false, deltaX: 0, deltaY: 0, deltaMode: 0 }, init);
    this.type = type;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

function stubCanvas() {
  const listeners: Record<string, Listener[]> = {};
  const seen: { type: string; replayed: boolean; x: unknown; detail?: unknown }[] = [];
  /** What replayedPress said of each press that reached the app. */
  const presses: ("tap" | "drag" | null)[] = [];
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
  /** The app behind the navigator, bound after it as the viewport and the
   *  tools are: records what reaches it, and claims a press when told to. */
  const app = { claim: false };
  const bindApp = () => {
    for (const t of ["pointerdown", "pointermove", "pointerup", "contextmenu", "dblclick"]) {
      el.addEventListener(t, (e) => {
        seen.push({ type: e.type, replayed: !(e instanceof Native), x: e.clientX, ...(t === "dblclick" || t === "pointerdown" ? { detail: e.detail } : {}) });
        if (t === "pointerdown") presses.push(replayedPress(e as unknown as Event));
        if (t === "pointerdown" && app.claim) e.preventDefault();
      });
    }
  };
  class Native extends FakeEvent {}
  const fire = (type: string, init: Record<string, unknown>) => {
    const e = new Native(type, init);
    el.dispatchEvent(e);
    return e;
  };
  const touch = (type: string, id: number, x: number, y = 300) =>
    fire(type, { pointerType: "touch", pointerId: id, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y });
  return { el, fire, touch, seen, presses, app, bindApp };
}

function rigWithBox() {
  const c = stubCanvas();
  const rig = createNavigatorRig(c.el as unknown as HTMLElement, W / H);
  const scene = new BoxScene([UNIT_BOX.clone()]);
  rig.setScene(scene);
  rig.setContentBox(scene.box());
  rig.setProjectionMode("persp");
  rig.resize(W, H);
  rig.fit(scene.box(), false);
  rig.navigator.opts.smoothTime = 0;
  rig.update(1 / 60);
  c.bindApp();
  return { rig, ...c };
}

const steady = (rig: ReturnType<typeof rigWithBox>["rig"]) => {
  for (let i = 0; i < 400; i++) rig.update(1 / 60);
};

const saved = getNavPrefs();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", FakeEvent);
  vi.stubGlobal("MouseEvent", FakeEvent);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setNavPrefs(saved);
});

describe("touch", () => {
  it("one finger turns the view once it moves, and the app sees the drag start where the finger landed", () => {
    const { rig, touch, seen, presses } = rigWithBox();
    const q0 = rig.navigator.pose.q.clone();
    touch("pointerdown", 7, 400);
    expect(rig.navigator.dragging()).toBe(null);
    expect(seen).toEqual([]);
    touch("pointermove", 7, 404);
    expect(rig.navigator.dragging()).toBe(null);
    touch("pointermove", 7, 460);
    expect(rig.navigator.dragging()).toBe("orbit");
    rig.update(1 / 60);
    expect(rig.navigator.pose.q.angleTo(q0)).toBeGreaterThan(0.1);
    expect(seen[0]).toEqual({ type: "pointerdown", replayed: true, x: 400, detail: 1 });
    touch("pointerup", 7, 460);
    expect(rig.navigator.dragging()).toBe(null);
    expect(seen.map((s) => s.type)).toEqual(["pointerdown", "pointermove", "pointerup"]);
    expect(presses).toEqual(["drag"]);
  });

  it("two fingers pan and pinch, and nothing reaches the app", () => {
    const { rig, touch, seen } = rigWithBox();
    const s0 = rig.viewScale();
    touch("pointerdown", 11, 350);
    touch("pointerdown", 12, 450);
    expect(rig.navigator.dragging()).toBe("pan");
    touch("pointermove", 11, 300);
    touch("pointermove", 12, 500);
    steady(rig);
    expect(rig.viewScale()).toBeLessThan(s0 * 0.6);
    touch("pointerup", 12, 500);
    expect(rig.navigator.dragging()).toBe("orbit");
    touch("pointerup", 11, 300);
    expect(rig.navigator.dragging()).toBe(null);
    expect(seen).toEqual([]);
  });

  it("a tap is a press and a release for the app, and turns nothing", () => {
    const { rig, touch, seen, presses } = rigWithBox();
    steady(rig);
    const v0 = rig.poseVersion();
    touch("pointerdown", 3, 400);
    touch("pointermove", 3, 403);
    touch("pointerup", 3, 403);
    steady(rig);
    expect(rig.poseVersion()).toBe(v0);
    expect(seen.map((s) => [s.type, s.replayed, s.x])).toEqual([["pointerdown", true, 403], ["pointerup", false, 403]]);
    expect(presses).toEqual(["tap"]);
  });

  it("a double tap counts its presses and ends in a dblclick; the system's own is dropped", () => {
    const { touch, fire, seen } = rigWithBox();
    touch("pointerdown", 3, 400);
    touch("pointerup", 3, 401);
    vi.advanceTimersByTime(120);
    touch("pointerdown", 4, 404);
    touch("pointerup", 4, 405);
    fire("dblclick", { pointerType: undefined, clientX: 405, clientY: 300 });
    vi.advanceTimersByTime(10);
    expect(seen.filter((s) => s.type !== "pointerup")).toEqual([
      { type: "pointerdown", replayed: true, x: 401, detail: 1 },
      { type: "pointerdown", replayed: true, x: 405, detail: 2 },
      { type: "dblclick", replayed: true, x: 405, detail: 2 },
    ]);
  });

  it("three fingers orbit", () => {
    const { rig, touch, seen } = rigWithBox();
    const q0 = rig.navigator.pose.q.clone();
    touch("pointerdown", 1, 350);
    touch("pointerdown", 2, 400);
    touch("pointerdown", 3, 450);
    expect(rig.navigator.dragging()).toBe("orbit");
    for (const id of [1, 2, 3]) touch("pointermove", id, 350 + (id - 1) * 50 + 60);
    rig.update(1 / 60);
    expect(rig.navigator.pose.q.angleTo(q0)).toBeGreaterThan(0.1);
    for (const id of [1, 2, 3]) touch("pointerup", id, 0);
    expect(seen).toEqual([]);
  });

  it("a press a tool claims is the tool's drag, not an orbit, and a second finger is dropped", () => {
    const { rig, touch, seen, app } = rigWithBox();
    app.claim = true;
    steady(rig);
    const v0 = rig.poseVersion();
    touch("pointerdown", 5, 400);
    touch("pointermove", 5, 450);
    touch("pointerdown", 6, 500);
    touch("pointermove", 6, 550);
    touch("pointermove", 5, 480);
    touch("pointerup", 6, 550);
    touch("pointerup", 5, 480);
    steady(rig);
    expect(rig.poseVersion()).toBe(v0);
    expect(seen.map((s) => s.type)).toEqual(["pointerdown", "pointermove", "pointermove", "pointerup"]);
  });

  it("a long press is a right click, and the rest of that touch does nothing", () => {
    const { rig, touch, seen } = rigWithBox();
    steady(rig);
    const v0 = rig.poseVersion();
    touch("pointerdown", 9, 400);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(seen.map((s) => s.type)).toEqual(["contextmenu"]);
    touch("pointermove", 9, 480);
    touch("pointerup", 9, 480);
    steady(rig);
    expect(rig.poseVersion()).toBe(v0);
    expect(seen.length).toBe(1);
  });

  it("the system's own long press menu after a touch is dropped", () => {
    const { touch, fire, seen } = rigWithBox();
    touch("pointerdown", 9, 400);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    fire("contextmenu", { pointerType: "touch", clientX: 400, clientY: 300 });
    touch("pointerup", 9, 400);
    expect(seen.filter((s) => s.type === "contextmenu").length).toBe(1);
  });
});

describe("wheel", () => {
  const wheel = (rig: ReturnType<typeof rigWithBox>["rig"], init: Record<string, unknown>) =>
    rig.wheel(new FakeEvent("wheel", { clientX: W / 2, clientY: H / 2, ...init }) as unknown as WheelEvent);

  it("a mouse notch zooms and turns nothing", () => {
    const { rig } = rigWithBox();
    const q0 = rig.navigator.pose.q.clone();
    const s0 = rig.viewScale();
    wheel(rig, { deltaY: -100, wheelDeltaY: 120 });
    steady(rig);
    expect(rig.viewScale()).toBeLessThan(s0);
    expect(rig.navigator.pose.q.angleTo(q0)).toBeLessThan(1e-12);
  });

  it("a touchpad's two-finger scroll orbits", () => {
    const { rig } = rigWithBox();
    const q0 = rig.navigator.pose.q.clone();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(16);
      wheel(rig, { deltaX: 6.5, deltaY: 1.25 });
      rig.update(1 / 60);
    }
    steady(rig);
    expect(rig.navigator.pose.q.angleTo(q0)).toBeGreaterThan(0.3);
  });

  it("Shift with a touchpad scroll pans instead, and the setting swaps the two", () => {
    const run = (shiftKey: boolean) => {
      const { rig } = rigWithBox();
      const q0 = rig.navigator.pose.q.clone();
      const t0 = rig.getTarget();
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(16);
        wheel(rig, { deltaX: 0.5, deltaY: 7.5, shiftKey });
      }
      steady(rig);
      return { turned: rig.navigator.pose.q.angleTo(q0), moved: rig.getTarget().distanceTo(t0) };
    };
    setNavPrefs({ touchpadScroll: "orbit" });
    expect(run(true).turned).toBeLessThan(1e-9);
    expect(run(true).moved).toBeGreaterThan(1e-3);
    expect(run(false).turned).toBeGreaterThan(0.05);
    setNavPrefs({ touchpadScroll: "pan" });
    expect(run(false).turned).toBeLessThan(1e-9);
    expect(run(true).turned).toBeGreaterThan(0.05);
  });

  it("a swipe keeps one pivot even when the smoothing settles between events", () => {
    const { rig } = rigWithBox();
    const pivots = new Set<string>();
    const nav = rig.navigator as unknown as { scrollPivot: { pivot: { toArray(): number[] } } | null };
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(16);
      wheel(rig, { deltaX: 9.5, deltaY: 0.5, clientX: 420, clientY: 310 });
      steady(rig);
      vi.advanceTimersByTime(0);
      pivots.add(nav.scrollPivot!.pivot.toArray().map((v) => v.toFixed(9)).join());
    }
    expect(pivots.size).toBe(1);
  });

  it("a pinch zooms about the pointer whatever the device setting", () => {
    setNavPrefs({ wheelDevice: "mouse" });
    const { rig } = rigWithBox();
    const s0 = rig.viewScale();
    wheel(rig, { deltaY: -5, ctrlKey: true });
    steady(rig);
    expect(rig.viewScale()).toBeLessThan(s0);
  });

  it("forcing a device overrules what the deltas look like", () => {
    setNavPrefs({ wheelDevice: "mouse" });
    const { rig } = rigWithBox();
    const q0 = rig.navigator.pose.q.clone();
    wheel(rig, { deltaX: 6.5, deltaY: 1.25 });
    steady(rig);
    expect(rig.navigator.pose.q.angleTo(q0)).toBeLessThan(1e-12);
    setNavPrefs({ wheelDevice: "touchpad" });
    vi.advanceTimersByTime(1000);
    wheel(rig, { deltaY: -100, wheelDeltaY: 120 });
    steady(rig);
    expect(rig.navigator.pose.q.angleTo(q0)).toBeGreaterThan(0.05);
  });
});
