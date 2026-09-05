// Whether this window shares its open document with an assistant.
//
// The house shape for a user setting (ui/theme.ts, ui/units.ts,
// layoutPrefs.ts): module state, a gate over the untrusted stored value, one
// `fundacad.*` key read at load, and a listener set so live surfaces re-render.
// No Vue import — that is what keeps the headless suite able to reach it.
//
// Three values rather than a checkbox, because "let an assistant read the part
// I have open" and "let it change the part I have open" are different questions
// and a person can reasonably answer yes to the first and no to the second:
//
//   off    nothing is shared. An assistant working through MCP starts its own
//          engine and works on a copy, which is what it always did.
//   read   it can see the document and measure it, and cannot change it.
//   edit   it can also offer edits, which arrive as one undo step each.
//
// DEFAULT: `edit`. This was the harder call of the two settings and it is worth
// writing down. Against it: a local program can now change the document on
// screen. For it: the token that reaches this engine is published in a file only
// this user account can read, so anything that can use it can already read and
// rewrite the user's documents on disk directly; the marginal reach is real but
// small. What makes it acceptable is not the size of the risk, it is that
// nothing happens invisibly — every edit is one Ctrl+Z, the window says who is
// attached while they are, and this setting turns it off in one click. A default
// of `off` would mean the feature does not work until you find a checkbox, which
// for the thing this was built for is not a safer default, only a quieter one.

import { readSetting } from "./storedSetting";

export type LiveEditingMode = "off" | "read" | "edit";

export const LIVE_MODES: readonly LiveEditingMode[] = ["off", "read", "edit"];

export const DEFAULT_LIVE_MODE: LiveEditingMode = "edit";

const KEY = "fundacad.liveEditing";
// No legacy keys: this setting is newer than either rename.

/** Narrow an untrusted stored value. Anything unrecognised is the default, the
 *  same way every other setting module treats a corrupt value. */
export function asLiveEditingMode(v: unknown): LiveEditingMode | null {
  return typeof v === "string" && (LIVE_MODES as readonly string[]).includes(v)
    ? (v as LiveEditingMode)
    : null;
}

let current: LiveEditingMode = asLiveEditingMode(readSetting(KEY)) ?? DEFAULT_LIVE_MODE;
const listeners = new Set<() => void>();

export function liveEditingMode(): LiveEditingMode {
  return current;
}

/** Is anything published at all? `read` and `edit` both share the document; only
 *  `off` withholds it. */
export function liveSharingEnabled(): boolean {
  return current !== "off";
}

/** May an assistant's edit be applied? Read by the host loop before it takes a
 *  proposal, so flipping this to `read` mid-session stops the next one. */
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
