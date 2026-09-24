// Pointer, wheel and touch input for the navigator.
//
// The left button is never taken: selection and every tool's handles live on
// it. Right orbits (pans while Shift is held or the orbit is locked), middle
// pans. The pointer is captured for the drag, and pointerup, pointercancel and
// lostpointercapture all end it, so a drag that leaves the window or is taken
// by the system cannot leave a gesture running.

import type { Navigator } from "./navigator";

export interface InputPrefs {
  /** A plain wheel (two-finger scroll on a trackpad) pans instead of zooming. */
  scrollPans(): boolean;
}

export interface InputBinding {
  wheel(e: WheelEvent): void;
  dispose(): void;
}

const BUTTON_MASK: Record<number, number> = { 0: 1, 1: 4, 2: 2 };

export function bindInput(dom: HTMLElement, nav: Navigator, prefs: InputPrefs): InputBinding {
  const style = dom.style as CSSStyleDeclaration | undefined;
  if (style) {
    style.touchAction = "none";
    style.userSelect = "none";
  }

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = dom.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

  // --- mouse and pen ------------------------------------------------------------
  let mouse: { id: number; mask: number; t: number } | null = null;

  const capture = (id: number) => {
    try { dom.setPointerCapture?.(id); } catch { /* capture is a nicety */ }
  };
  const release = (id: number) => {
    try { if (dom.hasPointerCapture?.(id)) dom.releasePointerCapture(id); } catch { /* already gone */ }
  };

  const endMouse = () => {
    if (!mouse) return;
    const id = mouse.id;
    mouse = null;
    nav.endGesture();
    release(id);
  };

  // --- touch ----------------------------------------------------------------------
  const touches = new Map<number, [number, number]>();
  let pinchDist = 0;

  const centroid = (): [number, number] => {
    let x = 0, y = 0;
    for (const [px, py] of touches.values()) { x += px; y += py; }
    return [x / touches.size, y / touches.size];
  };
  const spread = (): number => {
    const pts = [...touches.values()];
    return pts.length >= 2 ? Math.hypot(pts[0]![0] - pts[1]![0], pts[0]![1] - pts[1]![1]) : 0;
  };
  /** Restart the touch gesture for however many fingers are down now. */
  const touchGesture = () => {
    nav.endGesture();
    const n = touches.size;
    if (n === 0) return;
    const [x, y] = centroid();
    if (n === 1) nav.beginOrbit(x, y);
    else if (n === 2) {
      pinchDist = spread();
      nav.beginPinch(x, y);
    } else nav.beginPan(x, y);
  };

  // --- handlers ---------------------------------------------------------------------
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, local(e));
      capture(e.pointerId);
      touchGesture();
      return;
    }
    if (e.button !== 1 && e.button !== 2) return;
    if (mouse) return; // a second button during a drag changes nothing
    const [x, y] = local(e);
    if (e.button === 1) e.preventDefault(); // no autoscroll
    mouse = { id: e.pointerId, mask: BUTTON_MASK[e.button]!, t: now() };
    capture(e.pointerId);
    if (e.button === 2 && !e.shiftKey) nav.beginOrbit(x, y);
    else nav.beginPan(x, y);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, local(e));
      const [x, y] = centroid();
      if (touches.size === 2) {
        const d = spread();
        const log = d > 0 && pinchDist > 0 ? Math.log(pinchDist / d) : 0;
        pinchDist = d;
        nav.pinchTo(x, y, log);
      } else nav.dragTo(x, y);
      return;
    }
    if (!mouse || e.pointerId !== mouse.id) return;
    // The button that started the drag came up without a pointerup (it does,
    // when another is still held).
    if (typeof e.buttons === "number" && (e.buttons & mouse.mask) === 0) {
      endMouse();
      return;
    }
    const t = now();
    const dt = t - mouse.t;
    mouse.t = t;
    const [x, y] = local(e);
    nav.dragTo(x, y, dt);
  };

  const onEnd = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      if (!touches.delete(e.pointerId)) return;
      touchGesture();
      return;
    }
    if (mouse && e.pointerId === mouse.id) endMouse();
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1; // lines/pages -> px
    const [x, y] = local(e);
    const dy = e.deltaY * unit;
    // A trackpad pinch arrives as ctrl+wheel in small steps; a mouse wheel
    // turned with Ctrl held arrives the same way but a whole notch at a time.
    if (e.ctrlKey && Math.abs(dy) < 50) {
      nav.wheel(x, y, dy, true);
    } else if (e.ctrlKey) {
      nav.wheel(x, y, dy);
    } else if (prefs.scrollPans()) {
      nav.scrollPan(x, y, e.deltaX * unit, dy);
    } else {
      nav.wheel(x, y, dy);
    }
  };

  // The app's own menu is decided elsewhere; the browser's never shows here.
  const onContext = (e: Event) => e.preventDefault();

  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerup", onEnd);
  dom.addEventListener("pointercancel", onEnd);
  dom.addEventListener("lostpointercapture", onEnd as EventListener);
  dom.addEventListener("wheel", wheel, { passive: false });
  dom.addEventListener("contextmenu", onContext);

  return {
    wheel,
    dispose() {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onEnd);
      dom.removeEventListener("pointercancel", onEnd);
      dom.removeEventListener("lostpointercapture", onEnd as EventListener);
      dom.removeEventListener("wheel", wheel);
      dom.removeEventListener("contextmenu", onContext);
    },
  };
}
