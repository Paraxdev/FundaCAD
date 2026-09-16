// Which modelling tool holds the screen, for the rail to stand down to while it runs.

import type { EngineTools } from "../app/engine";

export interface RunningTool {
  label: string;
  icon: string;
  cancel: () => void;
}

export function runningTool(t: EngineTools): RunningTool | null {
  const entry = (label: string, icon: string, cancel: () => void): RunningTool => ({ label, icon, cancel });
  if (t.extrude.active) return entry("Extrude", "extrude", () => t.extrude.cancel());
  if (t.edgeFeature.active) return entry("Fillet / Chamfer", "fillet", () => t.edgeFeature.cancel());
  if (t.pressPull.active) return entry("Press/Pull", "presspull", () => t.pressPull.cancel());
  if (t.faceOffset.active) return entry(t.faceOffset.label, t.faceOffset.icon, () => t.faceOffset.cancel());
  if (t.draft.active) return entry("Draft", "draft", () => t.draft.cancel());
  if (t.thread.active) return entry("Thread", "thread", () => t.thread.cancel());
  if (t.loft.active) return entry("Loft", "loft", () => t.loft.cancel());
  if (t.pattern.active) return entry("Pattern", "patternLinear", () => t.pattern.cancel());
  return null;
}
