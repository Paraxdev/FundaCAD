// Pointer, wheel and touch input for the navigator.
//
// The left button is never taken: selection and every tool's handles live on
// it. Right orbits (pans while Shift is held or the orbit is locked), middle
// pans. The pointer is captured for the drag, and pointerup, pointercancel and
// lostpointercapture all end it, so a drag that leaves the window or is taken
// by the system cannot leave a gesture running.
//
// The wheel is read per stream as a mouse wheel or a touchpad (wheelKind.ts):
// a mouse wheel zooms, a touchpad's two-finger scroll orbits (or pans, by the
// setting) with Shift doing the other, and a pinch zooms about the cursor.
//
// Touch: one finger orbits, two pan and pinch, three orbit (whatever tool is
// up), a tap is a click and a long press is a right click. A finger is held back from the rest of the app until
// it moves, lifts, or a second finger joins, so a two-finger gesture never
// starts as a click or a stroke under its first finger. A finger that moves is
// then replayed to the canvas as the press it was; a tool or the sketch that
// claims the press (preventDefault) owns the drag, otherwise the view orbits.

import type { Navigator } from "./navigator";
import { WheelClassifier, type WheelKind } from "./wheelKind";

export type WheelDevice = "auto" | WheelKind;

export interface InputPrefs {
  /** The device wheel events come from: read off each stream, or set. */
  wheelDevice(): WheelDevice;
  /** What a touchpad's two-finger scroll does; Shift does the other. */
  touchpadScroll(): "orbit" | "pan";
  /** Told the kind each wheel stream was read as, for the settings. */
  detected?(kind: WheelKind): void;
}

export interface InputBinding {
  wheel(e: WheelEvent): void;
  dispose(): void;
}

/** A finger held still this long is a right click. */
export const LONG_PRESS_MS = 500;
/** A finger that moves this far is a drag rather than a tap. */
export const TOUCH_SLOP_PX = 8;
/** A native contextmenu or dblclick this soon after a touch is the system's
 *  reading of it, which the navigator already answered. */
const NATIVE_MENU_GRACE_MS = 700;
/** A second tap this soon and this near the first is a double tap. */
export const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_PX = 24;

const BUTTON_MASK: Record<number, number> = { 0: 1, 1: 4, 2: 2 };

/** Events the navigator dispatched itself, which its own listeners let by,
 *  and what each stands for. */
const replayed = new WeakMap<Event, "tap" | "drag" | "menu" | "dblclick">();

/** What a press the navigator replayed stands for: "tap", sent from inside the
 *  finger's release (after the release has passed every window capture
 *  listener), or "drag", sent as the finger starts to move and possibly about
 *  to orbit rather than to act. Null for any other event. */
export function replayedPress(e: Event): "tap" | "drag" | null {
  const k = replayed.get(e);
  return k === "tap" || k === "drag" ? k : null;
}

export function bindInput(dom: HTMLElement, nav: Navigator, prefs: InputPrefs): InputBinding {
  const style = dom.style as CSSStyleDeclaration | undefined;
  if (style) {
    style.touchAction = "none";
    style.userSelect = "none";
    style.setProperty?.("-webkit-touch-callout", "none");
  }
  // App wide long press handling (src/ui/longPress.ts) leaves this element to us.
  if (dom.dataset) dom.dataset.ownTouch = "";

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = dom.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const now = () => clock() / 1000;

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

  // --- touch: the navigator's fingers ---------------------------------------------
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
    // Three fingers orbit too, for when a tool takes what one finger does.
    if (n === 2) {
      pinchDist = spread();
      nav.beginPinch(x, y);
    } else nav.beginOrbit(x, y);
  };
  const navMove = () => {
    const [x, y] = centroid();
    if (touches.size === 2) {
      const d = spread();
      const log = d > 0 && pinchDist > 0 ? Math.log(pinchDist / d) : 0;
      pinchDist = d;
      nav.pinchTo(x, y, log);
    } else nav.dragTo(x, y);
  };

  // --- touch: who owns the fingers -------------------------------------------------
  // "held": one finger down, not yet given to anyone. "nav": the navigator's.
  // "app": the first finger is the app's (a tool claimed it, or a tap); any
  // other finger is dropped. "spent": a long press opened the menu; nothing
  // more happens until every finger is up.
  type Owner = "held" | "nav" | "app" | "spent";
  let owner: Owner | null = null;
  /** The touch's first finger; `shown` once its press went out to the app. */
  let first: { id: number; down: PointerEvent; x: number; y: number; shown: boolean } | null = null;
  /** Every finger of this touch, whoever has it. */
  const fingers = new Set<number>();
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let touchEndedAt = -Infinity;

  const clearPress = () => {
    if (pressTimer !== null) clearTimeout(pressTimer);
    pressTimer = null;
  };

  /** The held press, dispatched to the canvas as the event it was. False when
   *  a listener claimed it. */
  const replayDown = (at?: PointerEvent, detail = 1): boolean => {
    const d = first!.down;
    const p = at ?? d;
    first!.shown = true;
    const Ctor = typeof PointerEvent === "function" ? PointerEvent : null;
    if (!Ctor || typeof dom.dispatchEvent !== "function") return true;
    const ev = new Ctor("pointerdown", {
      bubbles: true, cancelable: true, composed: true,
      pointerId: d.pointerId, pointerType: "touch", isPrimary: true,
      clientX: p.clientX, clientY: p.clientY, screenX: p.screenX, screenY: p.screenY,
      button: 0, buttons: 1, pressure: d.pressure || 0.5, width: d.width, height: d.height,
      shiftKey: d.shiftKey, ctrlKey: d.ctrlKey, altKey: d.altKey, metaKey: d.metaKey,
      detail, view: typeof window !== "undefined" ? window : null,
    });
    replayed.set(ev, at ? "tap" : "drag");
    return dom.dispatchEvent(ev);
  };

  /** The last tap, to count a double tap. */
  let lastTap: { t: number; x: number; y: number; n: number } | null = null;
  const countTap = (e: PointerEvent): number => {
    const t = clock();
    const near = lastTap && t - lastTap.t < DOUBLE_TAP_MS
      && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_PX;
    const n = near ? lastTap!.n + 1 : 1;
    lastTap = { t, x: e.clientX, y: e.clientY, n };
    return n;
  };
  /** A double tap's dblclick, after the release that made it has gone out. */
  const sendDblclick = (x: number, y: number) => {
    const Ctor = typeof MouseEvent === "function" ? MouseEvent : null;
    if (!Ctor || typeof dom.dispatchEvent !== "function") return;
    setTimeout(() => {
      const ev = new Ctor("dblclick", {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: 0, detail: 2,
        view: typeof window !== "undefined" ? window : null,
      });
      replayed.set(ev, "dblclick");
      dom.dispatchEvent(ev);
    }, 0);
  };

  const openMenu = () => {
    pressTimer = null;
    if (owner !== "held" || !first) return;
    owner = "spent";
    const Ctor = typeof MouseEvent === "function" ? MouseEvent : null;
    if (!Ctor || typeof dom.dispatchEvent !== "function") return;
    const ev = new Ctor("contextmenu", {
      bubbles: true, cancelable: true, composed: true,
      clientX: first.down.clientX, clientY: first.down.clientY,
      screenX: first.down.screenX, screenY: first.down.screenY,
      button: 2, buttons: 0, view: typeof window !== "undefined" ? window : null,
    });
    replayed.set(ev, "menu");
    dom.dispatchEvent(ev);
  };

  /** Stop a touch event reaching anyone else on the page. */
  const swallow = (e: Event) => {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };

  const navTake = (id: number, at: [number, number]) => {
    touches.set(id, at);
    capture(id);
    touchGesture();
  };

  const touchDown = (e: PointerEvent) => {
    fingers.add(e.pointerId);
    if (owner === null) {
      owner = "held";
      first = { id: e.pointerId, down: e, x: e.clientX, y: e.clientY, shown: false };
      clearPress();
      pressTimer = setTimeout(openMenu, LONG_PRESS_MS);
      swallow(e);
      return;
    }
    swallow(e);
    if (owner === "held") {
      // A second finger before the first did anything: the view's, both.
      clearPress();
      owner = "nav";
      touches.set(first!.id, local(first!.down));
      navTake(e.pointerId, local(e));
    } else if (owner === "nav") {
      navTake(e.pointerId, local(e));
    }
  };

  const touchMove = (e: PointerEvent) => {
    if (!fingers.has(e.pointerId)) return;
    if (owner === "held" && first && e.pointerId === first.id) {
      if (Math.hypot(e.clientX - first.x, e.clientY - first.y) <= TOUCH_SLOP_PX) {
        swallow(e);
        return;
      }
      clearPress();
      lastTap = null;
      if (!replayDown()) {
        owner = "app"; // a tool or the sketch took the press; this move is its
        return;
      }
      owner = "nav";
      touches.set(first.id, local(first.down));
      touchGesture();
      touches.set(e.pointerId, local(e));
      navMove();
      return; // the rest of the app sees a left drag, which selects nothing
    }
    if (owner === "app" && first && e.pointerId === first.id) return;
    if (owner === "nav" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, local(e));
      navMove();
      // The finger the app saw pressed goes on reporting while it is alone.
      if (first?.shown && e.pointerId === first.id && touches.size === 1) return;
    }
    swallow(e);
  };

  const touchEnd = (e: PointerEvent) => {
    if (!fingers.delete(e.pointerId)) return;
    const isFirst = first !== null && e.pointerId === first.id;
    if (owner === "held" && isFirst) {
      clearPress();
      if (e.type === "pointerup") {
        // A tap: the press goes out now, where the finger lifted so the
        // release lands on it exactly (a tool reads any travel as a drag),
        // and this release after it.
        owner = "app";
        const n = countTap(e);
        replayDown(e, n);
        if (n === 2) sendDblclick(e.clientX, e.clientY);
      } else swallow(e);
    } else if (owner === "nav" && touches.delete(e.pointerId)) {
      touchGesture();
      if (!(isFirst && first!.shown)) swallow(e);
    } else if (!(owner === "app" && isFirst)) {
      swallow(e);
    }
    if (isFirst) first = null;
    if (fingers.size === 0) {
      clearPress();
      owner = null;
      first = null;
      touches.clear();
      touchEndedAt = clock();
    }
  };

  // --- handlers ---------------------------------------------------------------------
  // Captured on the canvas and bound before anything else is, so the touch
  // rules run ahead of every tool's own listeners.
  const onTouchCapture = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || replayed.has(e)) return;
    if (e.type === "pointerdown") touchDown(e);
    else if (e.type === "pointermove") touchMove(e);
    else touchEnd(e);
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
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
    if (e.pointerType === "touch") return;
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
      // Capture lost without an up or a cancel (the system took the finger).
      if (e.type === "lostpointercapture" && fingers.has(e.pointerId) && owner === "nav") touchEnd(e);
      return;
    }
    if (mouse && e.pointerId === mouse.id) endMouse();
  };

  // --- wheel --------------------------------------------------------------------------
  const kinds = new WheelClassifier();
  /** Safari's pinch arrives as gesture events rather than ctrl+wheel. */
  let gestureScale: number | null = null;

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1; // lines/pages -> px
    const [x, y] = local(e);
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const read = kinds.classify(e, clock());
    if (read.fresh) prefs.detected?.(read.kind);
    const set = prefs.wheelDevice();
    const kind = set === "auto" ? read.kind : set;
    // A trackpad pinch arrives as ctrl+wheel in small steps; a mouse wheel
    // turned with Ctrl held arrives the same way but a whole notch at a time.
    if (e.ctrlKey) {
      if (gestureScale !== null) return; // Safari sends the pinch twice
      nav.wheel(x, y, dy, Math.abs(dy) < 50);
      return;
    }
    if (kind === "mouse") {
      nav.wheel(x, y, dy);
      return;
    }
    const orbit = (prefs.touchpadScroll() === "orbit") !== e.shiftKey;
    if (orbit) nav.scrollOrbit(x, y, dx, dy, read.fresh);
    else nav.scrollPan(x, y, dx, dy);
  };

  type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    gestureScale = (e as GestureLike).scale || 1;
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as GestureLike;
    const s = g.scale || 1;
    if (gestureScale === null) gestureScale = s;
    const log = Math.log(gestureScale / s);
    gestureScale = s;
    if (!Number.isFinite(log) || log === 0) return;
    const [x, y] = local({ clientX: g.clientX ?? 0, clientY: g.clientY ?? 0 });
    // In wheel pixels at the pinch rate, so both pinches zoom alike.
    nav.wheel(x, y, log / 0.01, true);
  };
  const onGestureEnd = (e: Event) => {
    e.preventDefault();
    gestureScale = null;
  };

  /** The system's own reading of a touch (its long press menu, its double
   *  tap), which the rules above answered already. */
  const systemsOwn = (e: Event) => {
    if (replayed.has(e)) return false;
    if (fingers.size === 0 && clock() - touchEndedAt >= NATIVE_MENU_GRACE_MS) return false;
    const pe = e as Partial<PointerEvent>;
    return pe.pointerType !== "mouse" && pe.pointerType !== "pen";
  };
  // The app's own menu is decided elsewhere; the browser's never shows here.
  const onContext = (e: Event) => {
    e.preventDefault();
    if (systemsOwn(e)) e.stopImmediatePropagation();
  };
  const onDblclick = (e: Event) => {
    if (systemsOwn(e)) e.stopImmediatePropagation();
  };

  const touchTypes = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;
  for (const t of touchTypes) dom.addEventListener(t, onTouchCapture as EventListener, true);
  dom.addEventListener("contextmenu", onContext, true);
  dom.addEventListener("dblclick", onDblclick, true);
  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerup", onEnd);
  dom.addEventListener("pointercancel", onEnd);
  dom.addEventListener("lostpointercapture", onEnd as EventListener);
  dom.addEventListener("wheel", wheel, { passive: false });
  dom.addEventListener("gesturestart", onGestureStart);
  dom.addEventListener("gesturechange", onGestureChange);
  dom.addEventListener("gestureend", onGestureEnd);

  return {
    wheel,
    dispose() {
      clearPress();
      for (const t of touchTypes) dom.removeEventListener(t, onTouchCapture as EventListener, true);
      dom.removeEventListener("contextmenu", onContext, true);
      dom.removeEventListener("dblclick", onDblclick, true);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onEnd);
      dom.removeEventListener("pointercancel", onEnd);
      dom.removeEventListener("lostpointercapture", onEnd as EventListener);
      dom.removeEventListener("wheel", wheel);
      dom.removeEventListener("gesturestart", onGestureStart);
      dom.removeEventListener("gesturechange", onGestureChange);
      dom.removeEventListener("gestureend", onGestureEnd);
    },
  };
}
