// The capabilities that ship inside the app and are only turned on and off.
//
// This is what used to be ui/featureFlags.ts, generalised. That module already
// had the right idea in its first line, "capabilities the app can be built with
// and shipped without", and the right rule underneath it: a capability hides,
// it never deletes. What it did not have was a way to say what a capability
// TOUCHES, and that turns out to be the interesting half. "Multi-material" as a
// checkbox is a name; "reads and changes your document, sends jobs to your
// printer" is a thing somebody can have an opinion about.
//
// So a built-in capability carries the same manifest a downloaded plugin does,
// goes through the same parser, and is described on the same screen by the same
// two lists. It carries it IN THE SAME PLACE, too: plugins/<id>/manifest.json,
// the file that would sit at the top of its zip if it had one. This module used
// to hold its own copy of those manifests and no longer does; it reads what
// ./shipped.ts globs off disk, which is the byte-for-byte file the packager
// would ship. Two copies of a permission list is two lists that can disagree,
// and the copy that would have won is the one nobody could see.
//
// What a built-in does NOT get is the language of enforcement: nothing
// sandboxes the app's own code, `sandboxNote("builtin")` says exactly that, and
// this module holds no check that could be mistaken for one. Turning a built-in
// off stops it running. That is the whole of its guarantee, and it is worth
// having on its own: the surfaces it owns disappear, its code is never
// imported, and on the Rust side its device reader is never started.
//
// THIS MODULE NAMES NO CAPABILITY. Not in a type, not in a helper, not in a
// migration table. It used to name all three: a `BuiltinId` union, three
// one-line `xEnabled()` helpers, and a map of what each had been called before.
// Every one of those was a place the core had to be edited to add a fourth
// capability, and the last of them was the subtlest — a rename table in the app
// is the app remembering the history of plugins it does not otherwise know
// exist. A plugin's former names are in its own manifest now (`formerIds`), so
// this module reads a general rule where it used to hold three specific facts.
//
// House shape, kept from featureFlags: module state, a validating gate over the
// untrusted stored value, one `fundacad.*` key read at load, a listener set for
// live surfaces, and NO Vue import, which is what lets the headless suite reach
// it.
//
// WHAT A BUILT-IN MAY NOT DO WHEN TURNED OFF: touch the document. Turning
// multi-material off hides the palette, the slot assignments and the paint they
// produce; it does not delete any of them. They are saved, loaded and exported
// exactly as before, so turning it back on finds the work still there. A toggle
// that ate data would not be a toggle.

import { type PluginManifest } from "./manifest";
import { shippedBuiltins } from "./shipped";
import { readSetting } from "../ui/storedSetting";

export interface BuiltinPlugin {
  manifest: PluginManifest;
  /** Whether it is on before anybody has said anything, as the plugin's own
   *  manifest declares it.
   *
   *  The manifest decides, not this module: an upgrade that silently switched
   *  off something that had always worked would be a regression wearing the
   *  word "plugin", and the plugin is what knows whether it is that kind. */
  defaultEnabled: boolean;
}

/** The built-in capabilities, in the order the Plugins screen lists them,
 *  which is the order their directories sort in. */
export function builtinPlugins(): BuiltinPlugin[] {
  return shippedBuiltins().map(({ manifest }) => ({
    manifest,
    defaultEnabled: manifest.enabledByDefault,
  }));
}

const KEY = "fundacad.plugins";
// featureFlags' key, and its own two ancestors. A value found under any of them
// is a person's answer to a question this module is still asking, so it is
// migrated rather than reset. `readSetting` copies it forward and leaves the
// original alone.
const FLAGS_KEY = "fundacad.features";
const FLAGS_LEGACY = ["neocad.features", "sindricad.features"];

type State = Record<string, boolean>;

/** Old id -> current id, as the plugins themselves declare it.
 *
 *  Derived, not written down. Every entry comes from a `formerIds` in some
 *  plugin's own manifest, so a capability that has never been renamed
 *  contributes nothing and a capability that has is not something this module
 *  had to be told about. */
function renamed(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of builtinPlugins()) {
    for (const was of p.manifest.formerIds) out[was] = p.manifest.id;
  }
  return out;
}

function defaults(): State {
  const out: State = {};
  for (const p of builtinPlugins()) out[p.manifest.id] = p.defaultEnabled;
  return out;
}

/** Narrow untrusted JSON to a complete state, field by field.
 *
 *  Per field rather than all-or-nothing, so a capability added in a later
 *  version cannot cost somebody the setting they chose for an older one. */
export function asPluginState(v: unknown): State {
  const out = defaults();
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  // The old name first, so the new one wins when a value has been written under
  // it since. A state holding both is a session that toggled something after
  // upgrading, and what it did then is more recent than what it did before.
  for (const [was, now] of Object.entries(renamed())) {
    if (now in out && typeof o[was] === "boolean") out[now] = o[was] as boolean;
  }
  for (const id of Object.keys(out)) {
    if (typeof o[id] === "boolean") out[id] = o[id] as boolean;
  }
  return out;
}

/** The one-flag map this replaced, read forward.
 *
 *  One flag ever existed in it. Which one, and which capability it belongs to,
 *  is not this module's business: it is a former id like any other, declared by
 *  the plugin that used to answer to it, and read through the same table the
 *  newer rename goes through. A capability that was not toggleable before this
 *  simply has nothing stored, and keeps the default its manifest asks for. */
function fromFeatureFlags(): Partial<State> {
  try {
    const raw = readSetting(FLAGS_KEY, ...FLAGS_LEGACY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const o = parsed as Record<string, unknown>;
    const out: Partial<State> = {};
    for (const [was, now] of Object.entries(renamed())) {
      if (typeof o[was] === "boolean") out[now] = o[was] as boolean;
    }
    return out;
  } catch {
    // Unparseable JSON is treated as nothing stored. A corrupt value costs a
    // checkbox rather than turning something on behind somebody's back.
    return {};
  }
}

function readStored(): State {
  try {
    const raw = readSetting(KEY);
    if (raw) return asPluginState(JSON.parse(raw));
  } catch {
    /* unparseable: fall through to the older key, then to the defaults */
  }
  const state = defaults();
  for (const [id, on] of Object.entries(fromFeatureFlags())) {
    if (typeof on === "boolean") state[id] = on;
  }
  return state;
}

let current = readStored();
const listeners = new Set<() => void>();

/** Whether a built-in capability is running.
 *
 *  An id this build does not have is false, not a throw: a stored state from a
 *  newer version, or a stale call site, should cost a feature rather than the
 *  session. */
export function pluginEnabled(id: string): boolean {
  return current[id] === true;
}

/** Read-only. Go through setPluginEnabled so the write is persisted and
 *  subscribers are told. */
export function pluginState(): Readonly<State> {
  return current;
}

export function setPluginEnabled(id: string, value: boolean): void {
  if (typeof value !== "boolean" || current[id] === value) return;
  if (!(id in current)) return;
  // A fresh object rather than a mutation, so a subscriber may hold the result
  // of pluginState() and compare identity to decide it must redraw.
  const next: State = { ...current };
  next[id] = value;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
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
