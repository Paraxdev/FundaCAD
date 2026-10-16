// How the viewport shades the model: Matcap (flat studio clay, the cheapest),
// Realtime (the full PBR look) or Path traced. One choice per workspace, kept
// in the render prefs, so modelling can stay on Matcap while Render opens on
// the real look.
//
// No Vue and no Three here, same as workspace.ts: the low power tier comes in
// as an argument so the headless suite can drive every case.

import { asViewMode, renderPrefs, setRenderPref, type ViewMode } from "./renderPrefs";
import { workspace, type Workspace } from "./workspace";

export type { ViewMode };
export { asViewMode };

export const VIEW_MODES: readonly { id: ViewMode; label: string; icon: string }[] = [
  { id: "matcap", label: "Matcap", icon: "view-matcap" },
  { id: "realtime", label: "Realtime", icon: "view-realtime" },
  { id: "pathtraced", label: "Path traced", icon: "view-pathtraced" },
];

/** The effective render tier: performance or potato mode, or a machine the
 *  viewport detected as weak (`auto`). */
export interface RenderTier {
  lowPower: boolean;
  auto: boolean;
}

export const PATH_TRACING_OFF =
  "To avoid crashes or unintentional freezes path tracing has been turned off. To re-enable, turn off performance mode.";
export const PATH_TRACING_AUTO =
  "This computer was detected as low powered, so turning off performance mode may not lift it.";
export const PATH_TRACING_LATER = "Path tracing arrives in a later update";

/** Why Path traced cannot be chosen, or null when it can. There is no tracer
 *  yet, so it is always blocked; the performance reason is checked first so
 *  its wording is already the one a weak machine will keep. */
export function pathTracedBlock(tier: RenderTier): { reason: "perf" | "later"; tooltip: string } | null {
  if (tier.lowPower || tier.auto) {
    return { reason: "perf", tooltip: tier.auto ? `${PATH_TRACING_OFF} ${PATH_TRACING_AUTO}` : PATH_TRACING_OFF };
  }
  return { reason: "later", tooltip: PATH_TRACING_LATER };
}

function prefKey(w: Workspace): "viewModeModel" | "viewModeRender" {
  return w === "render" ? "viewModeRender" : "viewModeModel";
}

export function savedViewMode(w: Workspace = workspace()): ViewMode {
  return renderPrefs()[prefKey(w)];
}

/** The mode the viewport draws: the saved one, or Realtime while the saved one
 *  is Path traced and that is blocked (performance mode turned on since). */
export function effectiveViewMode(tier: RenderTier, w: Workspace = workspace()): ViewMode {
  const m = savedViewMode(w);
  return m === "pathtraced" && pathTracedBlock(tier) ? "realtime" : m;
}

/** Save `m` for the workspace. Refused (false) while it is blocked. */
export function chooseViewMode(m: ViewMode, tier: RenderTier, w: Workspace = workspace()): boolean {
  if (!asViewMode(m)) return false;
  if (m === "pathtraced" && pathTracedBlock(tier)) return false;
  setRenderPref(prefKey(w), m);
  return true;
}

/** The next mode along (dir 1) or back (dir -1), skipping a blocked one. */
export function nextViewMode(cur: ViewMode, dir: 1 | -1, tier: RenderTier): ViewMode {
  const n = VIEW_MODES.length;
  let i = VIEW_MODES.findIndex((v) => v.id === cur);
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    const id = VIEW_MODES[i]!.id;
    if (id !== "pathtraced" || !pathTracedBlock(tier)) return id;
  }
  return cur;
}
