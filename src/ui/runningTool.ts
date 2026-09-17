// Which modelling tool holds the screen, for the rail to stand down to while it runs.

import type { EngineTools } from "../app/engine";

export interface RunningTool {
  label: string;
  icon: string;
  /** The action that starts it, for its shortcut. */
  action: string;
  cancel: () => void;
}

export function runningTool(t: EngineTools): RunningTool | null {
  const entry = (label: string, icon: string, action: string, cancel: () => void): RunningTool =>
    ({ label, icon, action, cancel });
  if (t.extrude.active) return entry("Extrude", "extrude", "extrude", () => t.extrude.cancel());
  if (t.edgeFeature.active) return entry("Fillet / Chamfer", "fillet", "fillet", () => t.edgeFeature.cancel());
  if (t.pressPull.active) return entry("Press/Pull", "presspull", "presspull", () => t.pressPull.cancel());
  if (t.faceOffset.active) return entry(t.faceOffset.label, t.faceOffset.icon, t.faceOffset.action, () => t.faceOffset.cancel());
  if (t.draft.active) return entry("Draft", "draft", "draft", () => t.draft.cancel());
  if (t.thread.active) return entry("Thread", "thread", "thread", () => t.thread.cancel());
  if (t.hole.active) return entry("Hole", "hole", "hole", () => t.hole.cancel());
  if (t.loft.active) return entry("Loft", "loft", "loft", () => t.loft.cancel());
  if (t.pattern.active) return entry("Pattern", "patternLinear", "pattern-linear", () => t.pattern.cancel());
  return null;
}
