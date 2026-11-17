// Carry on: after Extrude or Press/Pull commits for a face, edge or profile pick or a tool command, waits for the
// commit's build, finds the pick again on the result and starts the next tool on it.

import { t } from "../i18n";
import type { RebuildState } from "../document/store";
import { carryTo, type CarryHost, type CarrySource, type CarryTarget } from "../features/carryOn";
import type { WorldRegion } from "../sketch/overlay";
import type { SketchTool } from "../sketch/sketchMode";
import { routeTreeClick } from "../ui/treePick";
import { SKETCH_TOOLS } from "./actionTables";
import type { Engine } from "./engine";
import { busyToolHint, refuseAloud, treeClickDeps } from "./planePick";
import { createProfileAt } from "./profileAt";

const CARRY_LIMIT_MS = 10_000;
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

type CarryTool = CarrySource & { active: boolean; carry: CarryHost | null; readonly carryOffered: boolean };

export type CarryEngine = Pick<
  Engine,
  | "store"
  | "viewport"
  | "overlay"
  | "starters"
  | "toolBusy"
  | "toolOwnsScreen"
  | "dropBodyGizmo"
  | "setStatus"
  | "sketch"
> & { tools: { extrude: CarryTool; pressPull: CarryTool } };

type Starters = CarryEngine["starters"];

/** The tool commands a set value carries on into, each started resting on the step just written. */
const NEXT_TOOL: Record<string, (s: Starters, restsOn: string | null) => void> = {
  fillet: (s, id) => s.startFilletOn(id),
  chamfer: (s, id) => s.startChamferOn(id),
  presspull: (s, id) => s.startPressPullOn(id),
  extrude: (s, id) => s.startExtrude(id),
  sketch: (s) => s.startSketch(),
};

const nextTool = (action: string) =>
  NEXT_TOOL[action] ?? (SKETCH_TOOLS.has(action) ? (s: Starters) => s.startSketch(action as SketchTool) : null);

/** A tool command while Extrude or Press/Pull is open: once its value is set the step is written and the command runs
 *  on the result, as a pick carries on. True when the command was taken or refused aloud. */
export function carryCommand(e: Pick<CarryEngine, "tools" | "setStatus">, action: string): boolean {
  if (!nextTool(action)) return false;
  const tool = [e.tools.extrude, e.tools.pressPull].find((x) => x.active);
  if (!tool?.carry) return false;
  if (!tool.carryOffered) {
    refuseAloud(e, busyToolHint());
    return true;
  }
  const done = carryTo(tool, tool.carry, { kind: "action", action });
  if (done !== true) refuseAloud(e, done);
  return true;
}

export function installCarryOn(e: CarryEngine): void {
  let drop: (() => void) | null = null;
  let pressed = false;
  let afterPress: (() => void) | null = null;
  window.addEventListener("pointerdown", () => (pressed = true), true);
  const lift = () => {
    pressed = false;
    const go = afterPress;
    afterPress = null;
    // Runs after the viewport's pointerup and click, and after the finished step's press hold lets picking go
    if (go) setTimeout(go, 0);
  };
  window.addEventListener("pointerup", lift);
  window.addEventListener("pointercancel", lift);
  window.addEventListener("blur", lift);
  // A key that finishes a step means no press is holding it, whatever pointerup was missed
  window.addEventListener("keydown", (ev) => !MODIFIERS.has(ev.key) && lift(), true);

  const land = (target: CarryTarget, id: string | null) => {
    if (id && !e.store.document.features.some((f) => f.id === id)) return;
    if (e.toolOwnsScreen()) return;
    const vp = e.viewport;
    if (target.kind === "action") {
      if (e.toolBusy()) e.dropBodyGizmo();
      nextTool(target.action)?.(e.starters, id);
      return;
    }
    if (target.kind === "profile") {
      if (e.toolBusy()) e.dropBodyGizmo();
      if (!e.starters.startExtrudeOn(id, target)) refuseAloud(e, t("carry.lost", { kind: "profile" }));
      return;
    }
    if (target.kind === "face") {
      const face = vp.faceIdNear(target.point);
      if (face == null) return refuseAloud(e, t("carry.lost", { kind: "face" }));
      if (e.toolBusy()) e.dropBodyGizmo();
      vp.applyPicks([{ kind: "face", faceId: face }], { additive: false });
      e.starters.startPressPullOn(id);
      return;
    }
    const edge = vp.edgeLineByMid(target.point);
    if (!edge) return refuseAloud(e, t("carry.lost", { kind: "edge" }));
    if (e.toolBusy()) e.dropBodyGizmo();
    vp.applyPicks([{ kind: "edge", edge }], { additive: false });
    e.starters.startFilletOn(id);
  };

  let profileAt: ((x: number, y: number) => WorldRegion | null) | null = null;
  const host: CarryHost = {
    route: (pick) => routeTreeClick(pick, treeClickDeps(e)),
    profileAt: (x, y) => (profileAt ??= createProfileAt(e, { refresh: false }))(x, y),
    lightProfile: (wr) => {
      if (e.overlay.setHoverRegion(wr)) e.viewport.requestRender();
    },
    refuse: (why) => refuseAloud(e, why),
    after(done, target) {
      drop?.();
      afterPress = null;
      const id = done.kind === "added" ? done.id : null;
      const note = done.kind === "nothing" ? done.note : undefined;
      // After the take that finished the step, whose taken words dismiss the hints before them
      if (note) setTimeout(() => refuseAloud(e, note), 0);
      let started = false;
      let over = false;
      const undo: (() => void)[] = [];
      const end = () => {
        over = true;
        for (const fn of undo.splice(0)) fn();
        if (drop === end) drop = null;
      };
      drop = end;

      // The press or key that finished the step is still being dispatched, so its own listeners must not see it
      const arm = setTimeout(() => {
        const el = e.viewport.domElement;
        const onKey = (ev: KeyboardEvent) => {
          if (!MODIFIERS.has(ev.key)) end();
        };
        el.addEventListener("pointerdown", end, true);
        window.addEventListener("keydown", onKey, true);
        undo.push(() => {
          el.removeEventListener("pointerdown", end, true);
          window.removeEventListener("keydown", onKey, true);
        });
      }, 0);
      const limit = setTimeout(() => {
        end();
        refuseAloud(e, t("carry.slow"));
      }, CARRY_LIMIT_MS);
      undo.push(() => (clearTimeout(arm), clearTimeout(limit)));

      // onSessionBuild replays the state on screen, which is the model before the commit: only a build seen starting
      // is the commit's. A step that added nothing waits for its preview to leave the screen.
      const seen = (s: RebuildState) => {
        if (over) return;
        if (s.building) {
          started = true;
          return;
        }
        if ((id && !started) || !s.result || s.previewBuilt) return;
        const errored = id != null && s.errorFeatureId === id;
        end();
        if (errored) return;
        // The tool the pressed button started would get picking turned back on under it when the press ends
        if (pressed) afterPress = () => land(target, id);
        else land(target, id);
      };
      const off = e.store.onSessionBuild(seen);
      if (over) off();
      else undo.push(off);
    },
  };

  e.tools.extrude.carry = host;
  e.tools.pressPull.carry = host;
}
