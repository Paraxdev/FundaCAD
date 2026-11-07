// Safe mode (src-tauri/src/safe_mode.rs). Rust decides before the webview
// exists and says so through an init script that runs before any of ours, the
// same script that swaps localStorage for an in memory one.

export type SafeModeReason = "failedStarts" | "crashes" | "flag" | "env";

export interface SafeModeInfo {
  reason: SafeModeReason;
  failedStarts: number;
  /** For "crashes": how many times it closed unexpectedly soon after the interface came up. */
  crashes?: number;
  /** The person picked Start in safe mode from Rust's start question. */
  chosen?: boolean;
}

declare global {
  interface Window {
    __FUNDACAD_SAFE_MODE__?: SafeModeInfo;
  }
}

export function safeMode(): SafeModeInfo | null {
  return typeof window === "undefined" ? null : (window.__FUNDACAD_SAFE_MODE__ ?? null);
}

export function safeModeWhy(info: SafeModeInfo): string {
  switch (info.reason) {
    case "flag":
      return "it was started with --safe-mode";
    case "env":
      return "FUNDACAD_SAFE_MODE is set";
    case "crashes":
      return `you chose it after FundaCAD closed unexpectedly ${info.crashes ?? 0} times soon after starting`;
    default:
      return info.chosen
        ? `you chose it after the last ${info.failedStarts} starts did not finish`
        : `the last ${info.failedStarts} starts did not finish`;
  }
}

/** What a restart cannot undo for the person, or null. */
export function safeModeLeaveNote(info: SafeModeInfo): string | null {
  switch (info.reason) {
    case "flag":
      return "A shortcut or launcher that adds --safe-mode starts it again, take the switch out of it.";
    case "env":
      return "Remove FUNDACAD_SAFE_MODE from your shell profile or launcher, or the next start is safe again.";
    default:
      return null;
  }
}

export async function leaveSafeMode(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("safe_mode_exit");
}
