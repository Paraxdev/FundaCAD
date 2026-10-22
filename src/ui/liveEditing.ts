// Whether this window shares its open document with an assistant: off (an MCP assistant works on its own copy), read
// (see and measure) or edit (each edit one undo step). Default edit: the token file is only readable by this account,
// which can already rewrite the documents on disk, and nothing happens invisibly.

import { readSetting } from "./storedSetting";

export type LiveEditingMode = "off" | "read" | "edit";

export const LIVE_MODES: readonly LiveEditingMode[] = ["off", "read", "edit"];

export const DEFAULT_LIVE_MODE: LiveEditingMode = "edit";

const KEY = "fundacad.liveEditing";
// No legacy keys: this setting is newer than either rename.

/** Anything unrecognised is the default, as in every other setting module. */
export function asLiveEditingMode(v: unknown): LiveEditingMode | null {
  return typeof v === "string" && (LIVE_MODES as readonly string[]).includes(v) ? (v as LiveEditingMode) : null;
}

let current: LiveEditingMode = asLiveEditingMode(readSetting(KEY)) ?? DEFAULT_LIVE_MODE;
const listeners = new Set<() => void>();

export function liveEditingMode(): LiveEditingMode {
  return current;
}

export function liveSharingEnabled(): boolean {
  return current !== "off";
}

/** Read by the host loop before it takes a proposal, so switching to `read` mid-session stops the next one. */
export function liveEditsAllowed(): boolean {
  return current === "edit";
}

export function setLiveEditingMode(mode: LiveEditingMode): void {
  if (mode === current) return;
  current = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // A blocked or full store costs the user the setting next launch, not now.
  }
  for (const fn of listeners) fn();
}

export function onLiveEditingChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
