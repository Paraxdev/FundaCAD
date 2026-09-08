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
   *  On for the two that have always been in the app: an upgrade that silently
   *  removed a working printer connection would be a regression wearing the
   *  word "plugin". Off for the one that was already off. */
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

/** Written out rather than derived, so that a capability removed from
 *  plugins/ fails to compile at its call sites instead of quietly becoming a
 *  gate that is always false. */
export type BuiltinId =
  | "FundaCAD.MultiColor"
  | "FundaCAD.Printing"
  | "FundaCAD.SpaceMouse";

const KEY = "fundacad.plugins";
// featureFlags' key, and its own two ancestors. A value found under any of them
// is a person's answer to a question this module is still asking, so it is
// migrated rather than reset. `readSetting` copies it forward and leaves the
// original alone.
const FLAGS_KEY = "fundacad.features";
const FLAGS_LEGACY = ["neocad.features", "sindricad.features"];

type State = Record<string, boolean>;

/** What each capability was called before ids grew a publisher.
 *
 *  Read forward, not reset. These are in people's `fundacad.plugins` right now,
 *  and a rename that dropped them would put every capability back to its
 *  default: multi-material would switch itself back ON for everyone who had
 *  turned it off, which is the exact behaviour a toggle exists to prevent.
 *
 *  One-directional and never written back. The new key is what gets saved the
 *  next time anything changes, and until then the old value keeps answering. */
const RENAMED: Record<string, BuiltinId> = {
  "multi-material": "FundaCAD.MultiColor",
  printing: "FundaCAD.Printing",
  spacemouse: "FundaCAD.SpaceMouse",
};

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
  for (const [was, now] of Object.entries(RENAMED)) {
    if (now in out && typeof o[was] === "boolean") out[now] = o[was] as boolean;
  }
  for (const id of Object.keys(out)) {
    if (typeof o[id] === "boolean") out[id] = o[id] as boolean;
  }
  return out;
}

/** The one-flag map this replaced, read forward.
 *
 *  Only `multiColor` ever existed in it, and it means the multi-material
 *  capability, which has been renamed twice since. This reads straight to the
 *  current name rather than hopping through RENAMED, because a migration in two
 *  steps is a migration that can break in the middle and leave the value
 *  nowhere. The other two capabilities were not toggleable at all before this,
 *  so there is nothing stored to read for them and their defaults are on, which
 *  is what the app did. */
function fromFeatureFlags(): Partial<State> {
  try {
    const raw = readSetting(FLAGS_KEY, ...FLAGS_LEGACY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const multi = (parsed as Record<string, unknown>)["multiColor"];
    return typeof multi === "boolean" ? { "FundaCAD.MultiColor": multi } : {};
  } catch {
    // Unparseable JSON is treated as nothing stored. The capability it decided
    // is off by default, so a corrupt value costs a checkbox rather than
    // turning something on behind somebody's back.
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
export function pluginEnabled(id: BuiltinId | string): boolean {
  return current[id] === true;
}

/** Read-only. Go through setPluginEnabled so the write is persisted and
 *  subscribers are told. */
export function pluginState(): Readonly<State> {
  return current;
}

export function setPluginEnabled(id: BuiltinId | string, value: boolean): void {
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

/** The one call site shape that reads best where it is used: a gate whose name
 *  says what it gates rather than which id it looks up. */
export function multiMaterialEnabled(): boolean {
  return pluginEnabled("FundaCAD.MultiColor");
}
export function printingEnabled(): boolean {
  return pluginEnabled("FundaCAD.Printing");
}
export function spaceMouseEnabled(): boolean {
  return pluginEnabled("FundaCAD.SpaceMouse");
}
