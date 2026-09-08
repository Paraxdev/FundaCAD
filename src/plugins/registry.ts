// Which installed plugins are switched off.
//
// OFF IS THE EXCEPTION, and that is the whole shape of this file. A plugin runs
// because somebody installed it; nothing has to be recorded for that. What is
// recorded is the smaller and more surprising fact, that somebody installed one
// and then turned it off — usually to see whether it was causing something, and
// usually temporarily.
//
// This used to be the other way round. It held the on/off state of the three
// capabilities compiled into the app, with a default per capability read from
// its manifest, because "installed" was not a question those three had an answer
// to: their code was the app's code and the switch was the only control there
// was. Nothing ships inside the app now, so the switch stopped being the answer
// to "is it here" and became what it always read like: a way to stop something
// without removing it.
//
// House shape, kept: module state, a validating gate over the untrusted stored
// value, one `fundacad.*` key read at load, a listener set for live surfaces,
// and NO Vue import, which is what lets the headless suite reach it.
//
// WHAT A PLUGIN MAY NOT DO WHEN TURNED OFF: touch the document. Turning one off
// stops it running and takes its surfaces away; it deletes nothing it ever
// wrote. A toggle that ate data would not be a toggle.

import { readSetting } from "../ui/storedSetting";

const KEY = "fundacad.plugins";

/** Ids that are installed and switched off. A set rather than a map of
 *  booleans: "on" is the absence of an entry, so there is one representation of
 *  it rather than two that can disagree. */
let off: ReadonlySet<string> = read();
const listeners = new Set<() => void>();

/** Narrow untrusted JSON to a set of ids.
 *
 *  Two shapes are accepted, because the older one is in people's storage right
 *  now: a list of ids, and the `{id: boolean}` map this key used to hold. A
 *  stored `false` in the old shape means exactly what an entry in the new one
 *  means, so the migration is a read rather than a rewrite, and the next write
 *  saves the new shape. */
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
    // Unparseable is treated as nothing stored, which leaves every installed
    // plugin running. That is the right way to fail: a corrupt value costs a
    // remembered choice rather than silently stopping something somebody
    // installed on purpose.
    return new Set();
  }
}

/** Whether an installed plugin is running.
 *
 *  Says nothing about whether it is installed — that is `installedIds()` in
 *  ./index.ts, and the two together are what ./activate.ts asks. */
export function pluginEnabled(id: string): boolean {
  return !off.has(id);
}

/** The ids somebody has switched off. Read-only; go through setPluginEnabled so
 *  the write is persisted and subscribers are told. */
export function disabledPlugins(): ReadonlySet<string> {
  return off;
}

export function setPluginEnabled(id: string, value: boolean): void {
  if (typeof value !== "boolean" || pluginEnabled(id) === value) return;
  // A fresh set rather than a mutation, so a subscriber may hold the result of
  // disabledPlugins() and compare identity to decide it must redraw.
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

/** Subscribe to changes; returns the unsubscribe. */
export function onPluginChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
