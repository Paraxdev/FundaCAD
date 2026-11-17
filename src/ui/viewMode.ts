// How the viewport shades the model (Matcap, Realtime, Path traced), one choice per workspace in the render prefs.
// The low power tier comes in as an argument so the headless suite can drive every case.

import { asViewMode, groundKey, renderPrefs, setRenderPref, type Ground, type ViewMode } from "./renderPrefs";
import { workspace, type Workspace } from "./workspace";
import type { OverlayKind, OverlayState } from "../viewport/overlayKinds";
import { t } from "../i18n";

export type { ViewMode };
export { asViewMode };

const viewModeEntry = (id: ViewMode, icon: string) => ({
  id,
  get label() {
    return t("viewControls.mode", { mode: id });
  },
  icon,
});

export const VIEW_MODES: readonly { readonly id: ViewMode; readonly label: string; readonly icon: string }[] = [
  viewModeEntry("matcap", "view-matcap"),
  viewModeEntry("realtime", "view-realtime"),
  viewModeEntry("pathtraced", "view-pathtraced"),
];

/** Performance or potato mode or a weak machine (`auto`), plus WebGPU adapter and native tracer availability, each
 *  undefined while its probe is out. */
export interface RenderTier {
  lowPower: boolean;
  auto: boolean;
  webgpu?: boolean | undefined;
  native?:
    | {
        available: boolean;
        path?: "rayquery" | "software" | undefined;
        /** Why the native tracer refused this computer; absent from an older app. */
        class?: string | undefined;
        storageBuffers?: number | undefined;
      }
    | undefined;
  /** The tracer hit a second GPU fault this session. */
  traceFault?: boolean;
}

export const pathTracingOff = (): string => t("viewMode.blocked.off");
export const pathTracingAuto = (): string => t("viewMode.blocked.auto");
export const pathTracingNoGpu = (): string => t("viewMode.blocked.noGpu");
export const pathTracingNoAdapter = (): string => t("viewMode.blocked.noAdapter");
export const pathTracingCpu = (): string => t("viewMode.blocked.cpu");
export const pathTracingSelfCheck = (): string => t("viewMode.blocked.selfCheck");
export const pathTracingLimits = (storageBuffers: number): string =>
  t("viewMode.blocked.limits", { n: storageBuffers });
export const pathTracingProbing = (): string => t("viewMode.blocked.probing");
export const pathTracingFault = (): string => t("viewMode.blocked.fault");
export const pathTracingAgain = (): string => t("viewMode.blocked.again");
const andThen = (first: string, then: string): string => t("viewMode.blocked.then", { first, then });

export type PathTracedBlockReason = "perf" | "nogpu" | "probing" | "fault";

const OVERRIDE_WINDOW_MS = 6000;

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
    return { reason: "perf", tooltip: tier.auto ? andThen(pathTracingOff(), pathTracingAuto()) : pathTracingOff() };
  }
  if (!tier.webgpu) {
    if (tier.webgpu === undefined || tier.native === undefined)
      return { reason: "probing", tooltip: pathTracingProbing() };
    if (!tier.native.available) return { reason: "nogpu", tooltip: refusalTooltip(tier.native) };
  }
  if (tier.traceFault) return { reason: "fault", tooltip: pathTracingFault() };
  return null;
}

function refusalTooltip(n: { class?: string | undefined; storageBuffers?: number | undefined }): string {
  switch (n.class) {
    case "noadapter":
      return pathTracingNoAdapter();
    case "cpu":
      return pathTracingCpu();
    case "limits":
      return n.storageBuffers === undefined ? pathTracingNoGpu() : pathTracingLimits(n.storageBuffers);
    case "selfcheck":
      return pathTracingSelfCheck();
    default:
      return pathTracingNoGpu();
  }
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
  return { result: "warn", message: andThen(block.tooltip, pathTracingAgain()) };
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

export function savedGround(w: Workspace = workspace()): Ground {
  return renderPrefs()[groundKey(w)];
}

export function setGround(g: Ground, w: Workspace = workspace()): void {
  setRenderPref(groundKey(w), g);
}

function overlayKey(w: Workspace): "overlaysModel" | "overlaysRender" {
  return w === "render" ? "overlaysRender" : "overlaysModel";
}

export function savedOverlays(w: Workspace = workspace()): Readonly<OverlayState> {
  return renderPrefs()[overlayKey(w)];
}

export function setOverlay(kind: OverlayKind, on: boolean, w: Workspace = workspace()): void {
  const s = savedOverlays(w);
  setRenderPref(overlayKey(w), { on: s.on, kinds: { ...s.kinds, [kind]: on } });
}

export function setOverlaysOn(on: boolean, w: Workspace = workspace()): void {
  const s = savedOverlays(w);
  setRenderPref(overlayKey(w), { on, kinds: { ...s.kinds } });
}

/** Clean view is the master switch off: every overlay goes, and turning it
 *  back on brings the set that was showing, kinds already off staying off. */
export function cleanViewOn(w: Workspace = workspace()): boolean {
  return !savedOverlays(w).on;
}

export function toggleCleanView(w: Workspace = workspace()): boolean {
  setOverlaysOn(cleanViewOn(w), w);
  return cleanViewOn(w);
}
