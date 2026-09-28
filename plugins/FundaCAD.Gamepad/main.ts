// The game controller capability: a pad or a Steam Deck flying the camera and
// running commands.
//
// THE APP KNOWS NOTHING OF IT. What it reaches is what every plugin gets: the
// camera rig on the viewport, the one dispatcher the ribbon and the palette
// share, and the command list the palette searches. Keys and clicks it sends as
// ordinary DOM events, so whatever already answers Enter, Escape or a click on
// the canvas answers the pad the same way, with no second path to disagree.
//
// No native half. The pad is read through the webview's Gamepad API, which
// WebView2 and WKWebView carry and WebKitGTK carries when it was built with
// libmanette. A webview built without it reports no pads at all, and this does
// nothing, which is the right amount of nothing.

import {
  CURSOR,
  getGamepadConfig,
  motionOf,
  parseKey,
  pressed,
  type Binding,
} from "./gamepad";
import { padState } from "./state";
import GamepadSection from "./GamepadSection.vue";
import { contribute, stickyFact } from "fundacad";
import type { Engine } from "fundacad";

export async function activate(e: Engine): Promise<() => void> {
  const stops: (() => void)[] = [];
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    stickyFact("[gamepad] this webview has no Gamepad API");
    return () => {};
  }

  const cursor = createCursor();
  stops.push(() => cursor.remove());

  let prev: boolean[] = [];
  let last = performance.now();
  let frame = 0;
  let stopped = false;

  const pick = (): Gamepad | null => {
    let best: Gamepad | null = null;
    for (const p of navigator.getGamepads()) {
      if (!p || !p.connected) continue;
      if (p.mapping === "standard") return p;
      best ??= p;
    }
    return best;
  };

  const run = (b: Binding) => {
    if (!b) return;
    if (b === CURSOR) {
      cursor.toggle();
      return;
    }
    const k = parseKey(b);
    if (k) {
      sendKey(k.key, k.ctrl, k.shift);
      return;
    }
    e.handleAction(b);
  };

  const loop = () => {
    if (stopped) return; // not re-scheduled: this is what "off" means
    const now = performance.now();
    const dt = Math.min(50, now - last) / 1000;
    last = now;

    const pad = pick();
    padState.name = pad?.id ?? null;
    if (!pad) {
      // Nothing plugged in: stop polling until the webview says one arrived.
      frame = 0;
      prev = [];
      cursor.hide();
      return;
    }
    frame = requestAnimationFrame(loop);

    const cfg = getGamepadConfig();
    const down = pad.buttons.map((b) => b.pressed);
    const m = motionOf(
      pad.axes,
      [pad.buttons[6]?.value ?? 0, pad.buttons[7]?.value ?? 0],
      cfg,
      cursor.on(),
    );

    const rig = e.viewport.rig;
    if (m.panX || m.panY) rig.panScreen(m.panX * dt, m.panY * dt);
    if (m.zoom) rig.zoomBy(Math.exp(-m.zoom * dt)); // zoomBy(>1) is out
    if (!rig.orbitLocked() && (m.orbitAz || m.orbitPol)) rig.orbitBy(m.orbitAz * dt, m.orbitPol * dt);
    if (m.cursorX || m.cursorY) cursor.move(m.cursorX * dt, m.cursorY * dt);

    // While the cursor is on, A is its left button, held for a drag.
    if (cursor.on()) {
      if (down[0] && !prev[0]) cursor.press();
      if (!down[0] && prev[0]) cursor.release();
    }
    for (const i of pressed(prev, down)) {
      if (i === 6 || i === 7) continue; // the triggers are zoom
      if (i === 0 && cursor.on()) continue;
      run(cfg.buttons[i] ?? "");
    }
    prev = down;
  };

  const start = () => {
    if (stopped || frame) return;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  };

  const onConnect = (ev: GamepadEvent) => {
    stickyFact(`[gamepad] connected: ${ev.gamepad.id} (${ev.gamepad.mapping || "no standard mapping"})`);
    start();
  };
  window.addEventListener("gamepadconnected", onConnect);
  stops.push(() => window.removeEventListener("gamepadconnected", onConnect));
  // A pad already known to the webview before this ran fires no event.
  start();

  stops.push(() => {
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    padState.name = null;
  });

  stops.push(
    contribute("FundaCAD.Gamepad", {
      settings: [{ key: "gamepad", title: "Game Controller", component: GamepadSection }],
    }),
  );

  return () => {
    for (const stop of stops.reverse()) stop();
  };
}

/** A key press, delivered where a real one would land. */
function sendKey(key: string, ctrl: boolean, shift: boolean) {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const init: KeyboardEventInit = {
    key,
    ctrlKey: ctrl,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** The on-screen cursor, for a pad with no trackpad to point with.
 *
 *  It sends the pointer and mouse events a real left button sends, to whatever
 *  is under it, so a face on the canvas, a ribbon button and a field in a dialog
 *  all take it without knowing it is not a mouse. A Steam Deck does not need
 *  it: its trackpads already are a mouse. */
function createCursor() {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "14px",
    height: "14px",
    margin: "-7px 0 0 -7px",
    borderRadius: "50%",
    border: "2px solid #fff",
    background: "var(--accent, #3b82f6)",
    boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
    pointerEvents: "none",
    zIndex: "2147483647",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);

  let on = false;
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  let held = false;
  let over: Element | null = null;

  const place = () => {
    el.style.transform = `translate(${x}px, ${y}px)`;
  };

  const fire = (type: string, target: Element | null, buttons: number) => {
    if (!target) return;
    const init = {
      clientX: x,
      clientY: y,
      button: 0,
      buttons,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    };
    if (type.startsWith("pointer")) {
      target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    } else {
      target.dispatchEvent(new MouseEvent(type, init));
    }
  };

  const under = () => document.elementFromPoint(x, y);

  return {
    on: () => on,
    toggle() {
      on = !on;
      if (on) {
        el.style.display = "block";
        place();
      } else {
        if (held) this.release();
        el.style.display = "none";
      }
    },
    hide() {
      if (on) this.toggle();
    },
    move(dx: number, dy: number) {
      x = Math.min(window.innerWidth - 1, Math.max(0, x + dx));
      y = Math.min(window.innerHeight - 1, Math.max(0, y + dy));
      place();
      const target = under();
      if (target !== over) {
        fire("pointerleave", over, held ? 1 : 0);
        fire("mouseout", over, held ? 1 : 0);
        over = target;
        fire("pointerover", over, held ? 1 : 0);
        fire("mouseover", over, held ? 1 : 0);
      }
      fire("pointermove", target, held ? 1 : 0);
      fire("mousemove", target, held ? 1 : 0);
    },
    press() {
      held = true;
      const t = under();
      fire("pointerdown", t, 1);
      fire("mousedown", t, 1);
      if (t instanceof HTMLElement && t.tabIndex >= 0) t.focus();
    },
    release() {
      held = false;
      const t = under();
      fire("pointerup", t, 0);
      fire("mouseup", t, 0);
      fire("click", t, 0);
    },
    remove() {
      el.remove();
    },
  };
}
