import { watch } from "vue";
import { isMac, latinKey } from "../input/platform";
import { useGeometryBrowserStore, type GeometryKind } from "../stores/geometryBrowser";
import { singleKeysOn } from "../ui/a11yPrefs";
import { announce } from "../ui/announce";
import { isChoiceOpen } from "../ui/choice";
import { describePick } from "../ui/describePick";
import { onPickSessionBegin, treePickWaiting } from "../ui/treePick";
import { VIEW_SUMMARY_ID } from "../ui/viewSummary";
import type { Engine } from "./engine";
import { refuseAloud } from "./planePick";

const KINDS: readonly GeometryKind[] = ["faces", "edges", "planes"];
const KIND_WORDS: Record<GeometryKind, string> = { faces: "Faces", edges: "Edges", planes: "Planes" };
const STEP_SPEECH_DELAY = 120;

/** Makes the canvas a Tab stop that a pointer press does not land on: with no focus change on a press, every path that
 *  hands focus back only from the body keeps working (focusables.ts, treeRowKeys.ts, Menu.vue, Select.vue).
 *  An img, never an application: that switches off browse mode in Windows and Linux screen readers and the rotor in VoiceOver. */
export function installCanvasStop(canvas: HTMLElement): void {
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Model");
  canvas.setAttribute("aria-roledescription", "3D view");
  canvas.setAttribute("aria-describedby", VIEW_SUMMARY_ID);
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

export function emptyStepWords(list: ReturnType<typeof useGeometryBrowserStore>): string {
  if (list.state === "error" && list.error) return list.error;
  if (list.rows.length) return `No ${list.kind} match the filter`;
  return list.bodyId === null ? "No body to step through" : `No ${list.kind} on this body`;
}

export interface CanvasPickHost {
  geometryBrowser: Engine["geometryBrowser"];
  viewport: { domElement: HTMLElement };
  sketch: { active: boolean };
  toolOwnsScreen(): boolean;
  setStatus: Engine["setStatus"];
}

/** Not keymap rows, which go off with Single key shortcuts. Install before the keymap: it leaves a defaultPrevented key,
 *  and in window bubble every tool's capture listener has heard the key first. */
export function installCanvasPick(e: CanvasPickHost): () => void {
  const list = useGeometryBrowserStore();
  const ctl = e.geometryBrowser;
  const canvas = e.viewport.domElement;
  let waiting: 1 | -1 | null = null;

  // A tool owns the screen except while it waits for a row, which these keys feed.
  const held = () => e.sketch.active || isChoiceOpen() || (e.toolOwnsScreen() && !treePickWaiting());
  const say = (text: string) => announce(text, "polite", { key: "pick-step", delay: STEP_SPEECH_DELAY });

  function putOut() {
    waiting = null;
    list.setLit(false);
  }

  function step(delta: 1 | -1) {
    const blocked = ctl.stepBlocked();
    if (blocked) return say(blocked);
    ctl.startStepping();
    if (list.state === "loading") {
      waiting = delta;
      return say(ctl.waitsOnTool() ?? `Listing ${list.kind}`);
    }
    const held = ctl.rowsHeld();
    if (held) {
      list.setLit(false);
      return say(held);
    }
    const row = ctl.step(delta);
    if (!row) {
      list.setLit(false);
      return say((!list.rows.length && ctl.waitsOnTool()) || emptyStepWords(list));
    }
    list.setLit(true);
    const { type, facing, minSize } = list.filters;
    const said = describePick(row.facts);
    // Enter gives a plane to the waiting tool, it starts no sketch then.
    const words = row.plane && treePickWaiting() ? said.readout.replaceAll(" · ", ", ") : said.spoken;
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
    if (refused) refuseAloud(e, refused);
  }

  // The key of an Enter or Space this listener took. Its repeats are swallowed wherever they land, since the take may
  // have moved focus to the tool's value box, whose own Enter commits.
  let claimedKey: string | null = null;

  // A tool's own Enter (Mirror and Fillet apply on it) listens in window capture, so this one must hear first.
  function onKeyCapture(ev: KeyboardEvent) {
    // Not taken: the keymap goes on to clear the selection, and a tool's capture may stop the key after this.
    if (ev.key === "Escape") return putOut();
    if (ev.key !== "Enter" && ev.key !== " ") return;
    if (ev.repeat && claimedKey === ev.key) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    if (!ev.repeat) claimedKey = null;
    if (!treePickWaiting() || held()) return;
    if (ev.target !== canvas && !(ev.target === document.body && singleKeysOn())) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
    const row = list.litRow;
    if (ev.repeat || !row) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    claimedKey = ev.key;
    putOut();
    const stale = ctl.offer([row]);
    if (stale) refuseAloud(e, stale);
  }

  function onKey(ev: KeyboardEvent) {
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
  // A light from before the pick began would go to its first Enter unasked.
  const stopBegun = onPickSessionBegin(putOut);
  window.addEventListener("keydown", onKeyCapture, true);
  window.addEventListener("keydown", onKey);
  window.addEventListener("focus", onFocus, true);
  canvas.addEventListener("pointerdown", putOut);
  canvas.addEventListener("pointermove", onPointerMove);

  return () => {
    stopLight();
    stopWaiting();
    stopBegun();
    window.removeEventListener("keydown", onKeyCapture, true);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("focus", onFocus, true);
    canvas.removeEventListener("pointerdown", putOut);
    canvas.removeEventListener("pointermove", onPointerMove);
  };
}
