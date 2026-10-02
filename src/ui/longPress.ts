// A long press with a finger is a right click, everywhere in the app.
//
// Rows in the tree, the timeline, materials and the tool rail open their menus
// on `contextmenu`, which a touchpad sends for a two-finger tap but a finger
// only sends in some engines (WebView2 does after a long hold, WebKit does
// not). So a finger held still for LONG_PRESS_MS sends one to whatever it is
// on, and the system's own, if it comes too, is dropped. The click the finger's
// release would make after the menu is open is dropped as well, or it would act
// on the row under the menu.
//
// The 3D canvas runs its own touch rules (navigator/input.ts) and opts out with
// data-own-touch, as does anything else that does its own thing with a hold.

import { LONG_PRESS_MS, TOUCH_SLOP_PX } from "../viewport/navigator/input";

/** A click or a system menu this soon after a long press is that press's. */
const AFTER_MS = 700;

interface Press {
  id: number;
  target: Element;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
}

let press: Press | null = null;
/** The finger whose long press went out, while it is still down. */
let firedFor: number | null = null;
/** When that finger lifted. */
let liftedAt = -Infinity;
const ours = new WeakSet<Event>();

const now = () => performance.now();

/** Inside a long press that fired, or just after its finger lifted. */
const afterPress = () => firedFor !== null || now() - liftedAt < AFTER_MS;

function cancel() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function fire() {
  const p = press;
  press = null;
  if (!p || !p.target.isConnected) return;
  firedFor = p.id;
  const ev = new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, composed: true,
    clientX: p.x, clientY: p.y, button: 2, buttons: 0, view: window,
  });
  ours.add(ev);
  p.target.dispatchEvent(ev);
}

function onDown(e: PointerEvent) {
  if (e.pointerType !== "touch") return;
  cancel();
  if (!e.isPrimary) return; // a second finger is a gesture, not a hold
  const t = e.target instanceof Element ? e.target : null;
  if (!t || t.closest("[data-own-touch]")) return;
  press = { id: e.pointerId, target: t, x: e.clientX, y: e.clientY, timer: setTimeout(fire, LONG_PRESS_MS) };
}

function onMove(e: PointerEvent) {
  if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > TOUCH_SLOP_PX) cancel();
}

function onEnd(e: PointerEvent) {
  if (e.pointerType !== "touch") return;
  if (press && e.pointerId === press.id) cancel();
  if (firedFor === e.pointerId) {
    firedFor = null;
    liftedAt = now();
  }
}

function onContext(e: MouseEvent) {
  if (ours.has(e)) return;
  if (afterPress()) {
    // The system's own long press menu, after ours went out.
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  // The system's beat ours to it: it stands, ours never goes.
  cancel();
}

function onClick(e: MouseEvent) {
  if (afterPress()) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

/** For tests: forget any press in flight. */
export function resetLongPressForTest() {
  cancel();
  firedFor = null;
  liftedAt = -Infinity;
}

let installed = false;

export function installLongPress(win: Window = window) {
  if (installed) return;
  installed = true;
  const capture = { capture: true };
  win.addEventListener("pointerdown", onDown, capture);
  win.addEventListener("pointermove", onMove, capture);
  win.addEventListener("pointerup", onEnd, capture);
  win.addEventListener("pointercancel", onEnd, capture);
  win.addEventListener("contextmenu", onContext, capture);
  win.addEventListener("click", onClick, capture);
}
