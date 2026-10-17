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
 *  viewport detected as weak (`auto`), whether the web view offers a real
 *  WebGPU adapter and whether the app has a native tracer (each undefined
 *  while its probe is still out). */
export interface RenderTier {
  lowPower: boolean;
  auto: boolean;
  webgpu?: boolean | undefined;
  native?: { available: boolean; path?: "rayquery" | "software" | undefined } | undefined;
  /** The tracer hit a second GPU fault this session. */
  traceFault?: boolean;
}

export const PATH_TRACING_OFF =
  "To avoid crashes or unintentional freezes path tracing has been turned off. To re-enable, turn off performance mode.";
export const PATH_TRACING_AUTO =
  "This computer was detected as low powered, so turning off performance mode may not lift it.";
export const PATH_TRACING_NO_GPU = "Path tracing needs a GPU tracer, which this system does not have";
export const PATH_TRACING_PROBING = "Checking whether this system can path trace";
export const PATH_TRACING_FAULT = "Path tracing stopped after a GPU error and stays off until FundaCAD restarts";

export type PathTracedBlockReason = "perf" | "nogpu" | "probing" | "fault";

const OVERRIDE_WINDOW_MS = 6000;
export const PATH_TRACING_AGAIN = "Click again to path trace anyway until FundaCAD restarts.";

// In memory on purpose: a restart greys Path traced again.
let perfOverride = false;
let warnedAt = -Infinity;

export function resetPathTracedOverride(): void {
  perfOverride = false;
  warnedAt = -Infinity;
}

/** Why Path traced cannot be chosen, or null when it can. The performance
 *  reason is checked first so a weak machine reads the user's wording. */
export function pathTracedBlock(tier: RenderTier): { reason: PathTracedBlockReason; tooltip: string } | null {
  if ((tier.lowPower || tier.auto) && !perfOverride) {
    return { reason: "perf", tooltip: tier.auto ? `${PATH_TRACING_OFF} ${PATH_TRACING_AUTO}` : PATH_TRACING_OFF };
  }
  if (!tier.webgpu) {
    if (tier.webgpu === undefined || tier.native === undefined) return { reason: "probing", tooltip: PATH_TRACING_PROBING };
    if (!tier.native.available) return { reason: "nogpu", tooltip: PATH_TRACING_NO_GPU };
  }
  if (tier.traceFault) return { reason: "fault", tooltip: PATH_TRACING_FAULT };
  return null;
}

/** A click on a blocked Path traced. The performance block warns on the first
 *  click and lifts for this session on a second one while that warning shows;
 *  every other block stays. */
export function requestPathTraced(
  tier: RenderTier,
  now: number = Date.now(),
): { result: "free" | "warn" | "enabled" | "blocked"; message: string } {
  const block = pathTracedBlock(tier);
  if (!block) return { result: "free", message: "" };
  if (block.reason !== "perf") return { result: "blocked", message: block.tooltip };
  const hard = pathTracedBlock({ ...tier, lowPower: false, auto: false });
  if (hard) return { result: "blocked", message: block.tooltip };
  if (now - warnedAt <= OVERRIDE_WINDOW_MS) {
    perfOverride = true;
    return { result: "enabled", message: "" };
  }
  warnedAt = now;
  return { result: "warn", message: `${block.tooltip} ${PATH_TRACING_AGAIN}` };
}

/** The mode to open with. `guardSet` reads the flag left by a tracer start
 *  that never reached its first sample, which means the app died there. */
export function bootViewMode(saved: ViewMode, guardSet: () => boolean): { mode: ViewMode; notice: boolean } {
  if (saved !== "pathtraced") return { mode: saved, notice: false };
  let died = false;
  try {
    died = guardSet();
  } catch {
    died = false;
  }
  return died ? { mode: "realtime", notice: true } : { mode: saved, notice: false };
}

function prefKey(w: Workspace): "viewModeModel" | "viewModeRender" {
  return w === "render" ? "viewModeRender" : "viewModeModel";
}

export function savedViewMode(w: Workspace = workspace()): ViewMode {
  return renderPrefs()[prefKey(w)];
}

/** The mode the viewport draws: the saved one, or Realtime while the saved one
 *  is Path traced and that is blocked (performance mode turned on since, or the
 *  probe is still out). The saved choice is kept either way. */
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
