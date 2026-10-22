// Which installed plugins are switched off. Off is the exception, so only it is stored. Vue-free for the headless
// suite. Turning a plugin off stops it and takes its surfaces away, but never deletes anything it wrote.

import { readSetting } from "../ui/storedSetting";

const KEY = "fundacad.plugins";

/** A set, not a map of booleans: "on" is the absence of an entry, so it has only one representation. */
let off: ReadonlySet<string> = read();
const listeners = new Set<() => void>();

/** Accepts a list of ids, or the older `{id: boolean}` map still in people's storage, where `false` means off.
 *  The next write saves the new shape. */
export function asDisabledSet(v: unknown): ReadonlySet<string> {
  if (Array.isArray(v)) {
    return new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0));
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return new Set(Object.keys(o).filter((k) => o[k] === false));
  }
  return new Set();
}

function read(): ReadonlySet<string> {
  try {
    const raw = readSetting(KEY);
    return raw ? asDisabledSet(JSON.parse(raw)) : new Set();
  } catch {
    // Unparseable means nothing stored: a corrupt value costs a remembered choice, never a stopped plugin.
    return new Set();
  }
}

/** Says nothing about whether it is installed. ./activate.ts asks that of `installedIds()` as well. */
export function pluginEnabled(id: string): boolean {
  return !off.has(id);
}

/** Read-only: write through setPluginEnabled so the choice is persisted and subscribers are told. */
export function disabledPlugins(): ReadonlySet<string> {
  return off;
}

export function setPluginEnabled(id: string, value: boolean): void {
  if (typeof value !== "boolean" || pluginEnabled(id) === value) return;
  // A fresh set, so a subscriber can compare identity with disabledPlugins() to decide to redraw.
  const next = new Set(off);
  if (value) next.delete(id);
  else next.add(id);
  off = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next].sort()));
  } catch {
    /* private mode / no storage: the choice just does not survive the session */
  }
  for (const fn of listeners) fn();
}

export function onPluginChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
