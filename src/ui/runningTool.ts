// Which modelling tool holds the screen, for the rail to stand down to while it runs.

import type { EngineTools } from "../app/engine";
import { t as translate } from "../i18n";
import { toolLabel } from "./ribbonDefs";

export interface RunningTool {
  label: string;
  icon: string;
  /** The action that starts it, for its shortcut. */
  action: string;
  cancel: () => void;
}

const name = (action: string, fallback = action) => toolLabel(action) ?? fallback;

export function runningTool(t: EngineTools): RunningTool | null {
  const entry = (label: string, icon: string, action: string, cancel: () => void): RunningTool => ({
    label,
    icon,
    action,
    cancel,
  });
  if (t.extrude.active) return entry(name("extrude"), "extrude", "extrude", () => t.extrude.cancel());
  if (t.edgeFeature.active)
    return entry(translate("tool.family.filletChamfer"), "fillet", "fillet", () => t.edgeFeature.cancel());
  if (t.pressPull.active) return entry(name("presspull"), "presspull", "presspull", () => t.pressPull.cancel());
  if (t.faceOffset.active)
    return entry(name(t.faceOffset.action, t.faceOffset.label), t.faceOffset.icon, t.faceOffset.action, () =>
      t.faceOffset.cancel(),
    );
  if (t.draft.active) return entry(name("draft"), "draft", "draft", () => t.draft.cancel());
  if (t.thread.active) return entry(name("thread"), "thread", "thread", () => t.thread.cancel());
  if (t.textOnFace.active) return entry(name("text-on-face"), "text", "text-on-face", () => t.textOnFace.cancel());
  if (t.hole.active) return entry(name("hole"), "hole", "hole", () => t.hole.cancel());
  if (t.loft.active) return entry(name("loft"), "loft", "loft", () => t.loft.cancel());
  if (t.pattern.active)
    return entry(translate("tool.family.pattern"), "patternLinear", "pattern-linear", () => t.pattern.cancel());
  if (t.mirror.active) return entry(name("mirror"), "mirror", "mirror", () => t.mirror.cancel());
  return null;
}
