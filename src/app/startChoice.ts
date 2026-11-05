// The start choice Rust asks before the webview opens (src-tauri/src/safe_mode.rs). Reset settings is carried out
// here, because the settings live in this page's localStorage. It runs from src/entry.ts before main.ts loads, since
// most settings modules read their value once, when they are imported.

import { RECENT_FILES_KEYS } from "../io/recentFiles";

/** What Rust hands over for Reset settings. `plugins` is the "Also turn off plugins" box. */
export interface StartChoice {
  reset: true;
  plugins: boolean;
}

declare global {
  interface Window {
    /** Set by Rust's init script on the start the person chose Reset settings for. */
    __FUNDACAD_START_CHOICE__?: { reset: true };
  }
}

/** Not imported from ../plugins/registry.ts, which reads it and tells the engine the moment it loads. */
export const PLUGINS_OFF_KEY = "fundacad.plugins";

export const BACKUP_FORMAT = "fundacad-settings-backup";

export interface StartChoiceDeps {
  storage: Storage;
  /** One shot: the choice the first time, null after, so a reload of the page does not reset again. */
  take(): Promise<StartChoice | null>;
  /** Writes the backup and returns where it went. */
  backUp(text: string): Promise<string>;
  installedPluginIds(): Promise<string[]>;
  now(): Date;
}

export type StartChoiceOutcome =
  | { kind: "reset"; backup: string; plugins: "off" | "kept" | { failed: string } }
  | { kind: "backupFailed"; error: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startChoicePending(): boolean {
  return typeof window !== "undefined" && !!window.__FUNDACAD_START_CHOICE__;
}

export function settingsSnapshot(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    const v = k === null ? null : storage.getItem(k);
    if (k !== null && v !== null) out[k] = v;
  }
  return out;
}

export function backupText(snapshot: Record<string, string>, savedAt: Date): string {
  return JSON.stringify(
    { format: BACKUP_FORMAT, version: 1, savedAt: savedAt.toISOString(), localStorage: snapshot },
    null,
    2,
  );
}

/** Everything goes but the recent files list and the plugins switched off, since a reset never turns a plugin on. */
export function clearSettings(storage: Storage, keys: readonly string[]): void {
  for (const k of keys) if (k !== PLUGINS_OFF_KEY && !RECENT_FILES_KEYS.includes(k)) storage.removeItem(k);
}

function offIds(storage: Storage): string[] {
  try {
    const v: unknown = JSON.parse(storage.getItem(PLUGINS_OFF_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A failed backup leaves every setting as it was. */
export async function runStartChoice(deps: StartChoiceDeps | null = tauriDeps()): Promise<StartChoiceOutcome | null> {
  if (!deps || !startChoicePending()) return null;
  const choice = await deps.take().catch(() => null);
  if (!choice?.reset) return null;
  let pluginIds: string[] | { failed: string } | null = null;
  if (choice.plugins) pluginIds = await deps.installedPluginIds().catch((e: unknown) => ({ failed: errText(e) }));
  const snapshot = settingsSnapshot(deps.storage);
  let backup: string;
  try {
    backup = await deps.backUp(backupText(snapshot, deps.now()));
  } catch (e) {
    return { kind: "backupFailed", error: errText(e) };
  }
  clearSettings(deps.storage, Object.keys(snapshot));
  let plugins: "off" | "kept" | { failed: string } = "kept";
  if (Array.isArray(pluginIds)) {
    try {
      const off = new Set([...offIds(deps.storage), ...pluginIds]);
      deps.storage.setItem(PLUGINS_OFF_KEY, JSON.stringify([...off].sort()));
      plugins = "off";
    } catch (e) {
      plugins = { failed: errText(e) };
    }
  } else if (pluginIds) plugins = pluginIds;
  return { kind: "reset", backup, plugins };
}

export function startChoiceNotice(o: StartChoiceOutcome): { text: string; kind: "info" | "warning" } {
  if (o.kind === "backupFailed") {
    return {
      text: `Settings were not reset, because their backup could not be written: ${o.error}`,
      kind: "warning",
    };
  }
  const saved = `The old settings are saved in ${o.backup}.`;
  if (o.plugins === "off") {
    return {
      text: `Settings were reset and plugins turned off. ${saved} Turn plugins back on in Preferences, Plugins.`,
      kind: "info",
    };
  }
  if (o.plugins === "kept") return { text: `Settings were reset. ${saved}`, kind: "info" };
  return {
    text: `Settings were reset, but plugins could not be turned off: ${o.plugins.failed}. ${saved}`,
    kind: "warning",
  };
}

function tauriDeps(): StartChoiceDeps | null {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  const call = async <T>(cmd: string, args?: Record<string, unknown>) =>
    (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);
  return {
    storage: localStorage,
    take: () => call<StartChoice | null>("start_choice_take"),
    backUp: (text) => call<string>("settings_backup_write", { text }),
    installedPluginIds: async () => (await call<{ id: string }[]>("plugin_list")).map((p) => p.id),
    now: () => new Date(),
  };
}
