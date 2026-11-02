import { watch } from "vue";
import { isMac, latinKey } from "../input/platform";
import { useGeometryBrowserStore, type GeometryKind } from "../stores/geometryBrowser";
import { singleKeysOn } from "../ui/a11yPrefs";
import { announce } from "../ui/announce";
import { isChoiceOpen } from "../ui/choice";
import { describePick } from "../ui/describePick";
import type { Engine } from "./engine";

const KINDS: readonly GeometryKind[] = ["faces", "edges", "planes"];
const KIND_WORDS: Record<GeometryKind, string> = { faces: "Faces", edges: "Edges", planes: "Planes" };
const STEP_SPEECH_DELAY = 120;

/** Makes the canvas a Tab stop that a pointer press does not land on: with no focus change on a press, every path that
 *  hands focus back only from the body keeps working (focusables.ts, treeRowKeys.ts, Menu.vue, Select.vue). */
export function installCanvasStop(canvas: HTMLElement): void {
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "3D view");
  canvas.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const active = document.activeElement;
    if (active !== canvas && active instanceof HTMLElement) active.blur();
  });
}

// Windows reports AltGr as Ctrl+Alt and a Mac types brackets with Option on many layouts, plain Ctrl stays a chord.
function bracketChord(ev: KeyboardEvent): boolean {
  if (ev.metaKey) return false;
  if (ev.getModifierState("AltGraph")) return true;
  if (ev.ctrlKey) return ev.altKey;
  return !ev.altKey || isMac();
}

// A bracket a layout types with Shift keeps its meaning. Only a key read by its place, say a Cyrillic one, has Shift
// mean the other character.
function bracketOf(ev: KeyboardEvent): { delta: 1 | -1; switches: boolean } | null {
  const k = latinKey(ev);
  if (k === "}" || k === "{") return { delta: k === "}" ? 1 : -1, switches: true };
  if (k !== "]" && k !== "[") return null;
  return { delta: k === "]" ? 1 : -1, switches: ev.shiftKey && ev.key !== k };
}

export interface CanvasPickHost {
  geometryBrowser: Engine["geometryBrowser"];
  viewport: { domElement: HTMLElement };
  sketch: { active: boolean };
  toolOwnsScreen(): boolean;
  setStatus: Engine["setStatus"];
}

/** A window bubble listener and not a keymap row, since rows go off with Single key shortcuts: every tool's capture
 *  listener has heard the key by now, and a key taken here is defaultPrevented, which the keymap leaves alone. Install
 *  it before the keymap. */
export function installCanvasPick(e: CanvasPickHost): () => void {
  const list = useGeometryBrowserStore();
  const ctl = e.geometryBrowser;
  const canvas = e.viewport.domElement;
  let waiting: 1 | -1 | null = null;

  const held = () => e.sketch.active || e.toolOwnsScreen() || isChoiceOpen();
  const say = (text: string) => announce(text, "polite", { key: "pick-step", delay: STEP_SPEECH_DELAY });

  function putOut() {
    waiting = null;
    list.setLit(false);
  }

  function emptyWords(): string {
    if (list.state === "error" && list.error) return list.error;
    if (list.rows.length) return `No ${list.kind} match the filter`;
    return list.bodyId === null ? "No body to step through" : `No ${list.kind} on this body`;
  }

  function step(delta: 1 | -1) {
    const blocked = ctl.pickBlocked();
    if (blocked) return say(blocked);
    ctl.startStepping();
    if (list.state === "loading") {
      waiting = delta;
      return say(`Listing ${list.kind}`);
    }
    const row = ctl.step(delta);
    if (!row) {
      list.setLit(false);
      return say(emptyWords());
    }
    list.setLit(true);
    const { type, facing, minSize } = list.filters;
    const words = describePick(row.facts).spoken;
    say(type !== null || facing !== null || minSize !== null ? `${words}. Filtered` : words);
  }

  function switchKind(delta: 1 | -1) {
    putOut();
    const next = KINDS[(KINDS.indexOf(list.kind) + delta + KINDS.length) % KINDS.length]!;
    ctl.setKind(next);
    ctl.startStepping();
    say(KIND_WORDS[next]);
  }

  function pick(additive: boolean) {
    const row = list.litRow!;
    if (row.plane && !additive) {
      ctl.activatePlane(row);
      putOut();
      return;
    }
    const refused = ctl.pickRows([row], { additive });
    if (refused) e.setStatus(refused, "");
  }

  function onKey(ev: KeyboardEvent) {
    // Not taken: the keymap goes on to clear the selection.
    if (ev.key === "Escape") return putOut();
    if (ev.defaultPrevented || held()) return;
    if (ev.target !== canvas && !(ev.target === document.body && singleKeysOn())) return;
    const bracket = bracketOf(ev);
    if (bracket) {
      if (!bracketChord(ev)) return;
      ev.preventDefault();
      if (bracket.switches) switchKind(bracket.delta);
      else step(bracket.delta);
      return;
    }
    if (ev.key !== "Enter" && ev.key !== " ") return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey || !list.litRow) return;
    ev.preventDefault();
    if (!ev.repeat) pick(ev.key === " ");
  }

  // The window's capture comes before the target, so a list row's own light goes on after this one is out.
  function onFocus(ev: Event) {
    if (ev.target instanceof Element && ev.target !== canvas) putOut();
  }
  // A browser sends a zero move after a layout change, with the pointer at rest.
  function onPointerMove(ev: PointerEvent) {
    if (ev.movementX || ev.movementY) putOut();
  }

  const stopLight = watch(
    () => list.litRow,
    (row) => ctl.hover(row),
    { flush: "sync" },
  );
  const stopWaiting = watch(
    () => list.state,
    (state) => {
      if (waiting === null || state === "loading") return;
      const delta = waiting;
      waiting = null;
      if (state !== "idle" && !held()) step(delta);
    },
    { flush: "sync" },
  );
  window.addEventListener("keydown", onKey);
  window.addEventListener("focus", onFocus, true);
  canvas.addEventListener("pointerdown", putOut);
  canvas.addEventListener("pointermove", onPointerMove);

  return () => {
    stopLight();
    stopWaiting();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("focus", onFocus, true);
    canvas.removeEventListener("pointerdown", putOut);
    canvas.removeEventListener("pointermove", onPointerMove);
  };
}
