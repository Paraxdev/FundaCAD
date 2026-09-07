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
// two lists. What it does NOT get is the language of enforcement: nothing
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

import { parseManifest, type PluginManifest } from "./manifest";
import { readSetting } from "../ui/storedSetting";

export interface BuiltinPlugin {
  manifest: PluginManifest;
  /** Whether it is on before anybody has said anything.
   *
   *  On for the two that have always been in the app: an upgrade that silently
   *  removed a working printer connection would be a regression wearing the
   *  word "plugin". Off for the one that was already off. */
  defaultEnabled: boolean;
}

/** Written as untrusted JSON and parsed, exactly like a downloaded bundle's
 *  manifest. Not ceremony: it is the same parser, so a built-in cannot describe
 *  itself in terms the install screen would refuse to render, and the grant
 *  names cannot drift apart from the table that spells them out. */
const BUILTIN_RAW: { defaultEnabled: boolean; manifest: unknown }[] = [
  {
    defaultEnabled: false,
    manifest: {
      id: "multi-material",
      name: "Multi-material",
      version: "1.0.0",
      kind: "builtin",
      summary: "Filament slots, per body and per texture colour, and the toolhead mapping a multi-colour print needs.",
      // Reading and writing the document is the whole feature: a slot
      // assignment is stored on the body. It is off by default because all of
      // it answers to hardware, and on a single-material machine every surface
      // it adds is a control with nothing on the other end.
      grants: ["document.read", "document.write"],
    },
  },
  {
    defaultEnabled: true,
    manifest: {
      id: "printing",
      name: "Printer connection",
      version: "1.0.0",
      kind: "builtin",
      summary: "Sends jobs to a printer on your network, reads its status, and opens a model in your slicer.",
      // process.spawn is not padding. Opening a model in a slicer starts
      // another program on the machine, and that is the single most consequential
      // thing anything in this app does on the user's behalf.
      //
      // Not `network`: it reaches the printers configured in this app, over the
      // local network, and "connect to the internet" would be a worse
      // description rather than a more cautious one. printer.control is where
      // that reach is declared, and it says which machines it means.
      grants: [
        "document.read",
        "files.write",
        "printer.control",
        "process.spawn",
      ],
    },
  },
  {
    defaultEnabled: true,
    manifest: {
      id: "spacemouse",
      name: "3D mouse",
      version: "1.0.0",
      kind: "builtin",
      summary: "Navigates the view, and moves what you have selected, with a 3D mouse.",
      // document.write because the object mode moves the selected body, and a
      // move is an edit like any other. A grant list that quietly omitted it
      // because the edit arrives through a knob rather than a dialog would be
      // describing the input device instead of the effect.
      grants: ["device.input", "document.read", "document.write"],
    },
  },
];

/** The built-in capabilities, in the order the Plugins screen lists them.
 *
 *  Throws on an entry its own parser refuses, rather than skipping it. A
 *  built-in that cannot be described is a mistake in this file, and a silent
 *  skip would ship an app whose Plugins list is quietly one short and whose
 *  feature is quietly always off. */
export function builtinPlugins(): BuiltinPlugin[] {
  return BUILTIN_RAW.map((entry) => {
    const parsed = parseManifest(entry.manifest);
    if (!parsed.ok) {
      throw new Error(`built-in capability is not describable: ${parsed.why}`);
    }
    return { manifest: parsed.manifest, defaultEnabled: entry.defaultEnabled };
  });
}

export type BuiltinId = "multi-material" | "printing" | "spacemouse";

const KEY = "fundacad.plugins";
// featureFlags' key, and its own two ancestors. A value found under any of them
// is a person's answer to a question this module is still asking, so it is
// migrated rather than reset. `readSetting` copies it forward and leaves the
// original alone.
const FLAGS_KEY = "fundacad.features";
const FLAGS_LEGACY = ["neocad.features", "sindricad.features"];

type State = Record<string, boolean>;

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
  for (const id of Object.keys(out)) {
    if (typeof o[id] === "boolean") out[id] = o[id] as boolean;
  }
  return out;
}

/** The one-flag map this replaced, read forward.
 *
 *  Only `multiColor` ever existed in it, and it maps to `multi-material`. The
 *  other two capabilities were not toggleable at all before this, so there is
 *  nothing stored to read for them and their defaults are on, which is what the
 *  app did. */
function fromFeatureFlags(): Partial<State> {
  try {
    const raw = readSetting(FLAGS_KEY, ...FLAGS_LEGACY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const multi = (parsed as Record<string, unknown>)["multiColor"];
    return typeof multi === "boolean" ? { "multi-material": multi } : {};
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
  return pluginEnabled("multi-material");
}
export function printingEnabled(): boolean {
  return pluginEnabled("printing");
}
export function spaceMouseEnabled(): boolean {
  return pluginEnabled("spacemouse");
}
