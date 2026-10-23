// Settings a plugin declares, drawn under its row in Preferences > Plugins, stored under one localStorage key per id.
// Synchronous on purpose: plugins read them at module scope, and an async store would start them all on defaults.

export interface SettingBase {
  /** Stable within the plugin; the name the plugin reads the value by. */
  key: string;
  /** What the row says. Not needed for `data`, which is never drawn. */
  label?: string;
  description?: string;
  /** Rows with the same group are drawn together under that heading. */
  group?: string;
  /** Shown only while this holds for the current values. */
  visibleWhen?: (values: Readonly<Record<string, unknown>>) => boolean;
}

export interface BooleanSetting extends SettingBase {
  type: "boolean";
  default: boolean;
}

export interface NumberSetting extends SettingBase {
  type: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  /** "length" is stored in mm and shown in the display unit, "angle" in
   *  degrees; any other text is a suffix shown beside a plain number. */
  unit?: string;
}

export interface EnumSetting extends SettingBase {
  type: "enum";
  default: string;
  options: readonly { id: string; label: string }[];
}

export interface StringSetting extends SettingBase {
  type: "string";
  default: string;
  maxLength?: number;
  placeholder?: string;
}

export interface ColourSetting extends SettingBase {
  type: "colour";
  /** #rrggbb */
  default: string;
}

export interface KeySetting extends SettingBase {
  type: "key";
  /** A combination as the shortcut sheet writes it, "Ctrl+K"; "" is unbound. */
  default: string;
}

export interface FileSetting extends SettingBase {
  type: "file";
  default: string;
  extensions?: readonly string[];
}

/** A value the plugin's own component edits, kept and reset by the app but never drawn as a row. */
export interface DataSetting extends SettingBase {
  type: "data";
  default: unknown;
  /** The value made whole, or undefined to fall back to the default. */
  parse?: (v: unknown) => unknown;
}

export type SettingProp =
  BooleanSetting | NumberSetting | EnumSetting | StringSetting | ColourSetting | KeySetting | FileSetting | DataSetting;

export type SettingType = SettingProp["type"];

export type SettingValues = Record<string, unknown>;

export interface SettingsSchema {
  /** Raise it when a stored value has to be rewritten to be read. */
  version: number;
  props: readonly SettingProp[];
  /** Turns values stored under an older version into this one's. */
  migrate?: (old: SettingValues, fromVersion: number) => SettingValues;
  /** Values kept elsewhere before this store existed, read once while it holds nothing for this plugin. Old key names
   *  live only here: scripts/check-no-plugin-code.mjs fails the build if one reaches the shipped app. */
  legacy?: () => SettingValues | null;
}

const TYPES: ReadonlySet<string> = new Set(["boolean", "number", "enum", "string", "colour", "key", "file", "data"]);
const KEY_RE = /^[A-Za-z][\w.-]*$/;
const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

export const STORAGE_PREFIX = "fundacad.pluginSettings.";

export const storageKey = (pluginId: string) => STORAGE_PREFIX + pluginId;

/** Every reason a schema cannot be used, empty when it can. */
export function validateSchema(schema: SettingsSchema): string[] {
  const out: string[] = [];
  if (!Number.isInteger(schema.version) || schema.version < 1) out.push("version has to be a whole number from 1");
  const seen = new Set<string>();
  for (const p of schema.props ?? []) {
    const at = `"${p.key}"`;
    if (typeof p.key !== "string" || !KEY_RE.test(p.key)) {
      out.push(`${at} is not a usable key`);
      continue;
    }
    if (seen.has(p.key)) out.push(`${at} is declared twice`);
    seen.add(p.key);
    if (!TYPES.has(p.type)) {
      out.push(`${at} has an unknown type "${(p as { type: string }).type}"`);
      continue;
    }
    if (p.type !== "data" && !p.label) out.push(`${at} has no label`);
    if (p.type === "number") {
      if (typeof p.default !== "number" || !Number.isFinite(p.default)) out.push(`${at} needs a finite default`);
      else if (numberProblem(p, p.default)) out.push(`${at} default ${p.default}: ${numberProblem(p, p.default)}`);
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) out.push(`${at} has min above max`);
    } else if (p.type === "enum") {
      const ids = (p.options ?? []).map((o) => o.id);
      if (ids.length === 0) out.push(`${at} has no options`);
      if (new Set(ids).size !== ids.length) out.push(`${at} repeats an option`);
      if (!ids.includes(p.default)) out.push(`${at} default is not one of its options`);
    } else if (p.type === "data") {
      if (p.default === undefined) out.push(`${at} needs a default`);
    } else if (coerce(p, p.default) === undefined) {
      out.push(`${at} default is not a valid ${p.type}`);
    }
  }
  return out;
}

function numberProblem(p: NumberSetting, v: number): string | null {
  if (p.integer && !Number.isInteger(v)) return "has to be a whole number";
  if (p.min !== undefined && v < p.min) return `has to be at least ${p.min}`;
  if (p.max !== undefined && v > p.max) return `has to be at most ${p.max}`;
  return null;
}

/** Why `v` cannot be stored for `p`, or null when it can. */
export function valueProblem(p: SettingProp, v: unknown): string | null {
  switch (p.type) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return "has to be a number";
      return numberProblem(p, v);
    case "enum":
      return p.options.some((o) => o.id === v) ? null : "is not one of the choices";
    case "boolean":
      return typeof v === "boolean" ? null : "has to be on or off";
    case "colour":
      return typeof v === "string" && COLOUR_RE.test(v) ? null : "has to be a colour like #ff8800";
    case "string":
      if (typeof v !== "string") return "has to be text";
      return p.maxLength !== undefined && v.length > p.maxLength ? `has to be at most ${p.maxLength} characters` : null;
    case "key":
    case "file":
      return typeof v === "string" ? null : "has to be text";
    case "data":
      return p.parse && p.parse(v) === undefined ? "is not a value this plugin reads" : null;
  }
}

/** `v` if it can be stored for `p` (made whole for data), else undefined. */
function coerce(p: SettingProp, v: unknown): unknown {
  if (v === undefined) return undefined;
  if (p.type === "data") return p.parse ? p.parse(v) : v;
  return valueProblem(p, v) === null ? v : undefined;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface PluginSettings {
  readonly pluginId: string;
  readonly schema: SettingsSchema;
  get<T = unknown>(key: string): T;
  /** A copy of every value. */
  all(): SettingValues;
  /** Null when stored, else why not. */
  set(key: string, value: unknown): string | null;
  /** One property back to its default, or all of them. */
  reset(key?: string): void;
  isDefault(key: string): boolean;
  /** Called with the keys that changed, once per set or reset that changed any. */
  onChange(fn: (keys: string[]) => void): () => void;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

interface Stored {
  version: number;
  values: SettingValues;
  /** Remove forgot them: the plugin starts on its defaults and does not read its old keys again. */
  forgotten?: true;
}

function readStored(pluginId: string): Stored | null {
  try {
    const raw = storage()?.getItem(storageKey(pluginId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { version?: unknown; values?: unknown; forgotten?: unknown };
    if (!v || typeof v !== "object" || !v.values || typeof v.values !== "object") return null;
    return {
      version: typeof v.version === "number" ? v.version : 1,
      values: v.values as SettingValues,
      ...(v.forgotten === true ? { forgotten: true as const } : {}),
    };
  } catch {
    return null;
  }
}

const registry = new Map<string, PluginSettings>();
const registryListeners = new Set<() => void>();

/** The settings every running plugin declared, by plugin id. */
export function pluginSettingsList(): PluginSettings[] {
  return [...registry.values()];
}

export function pluginSettingsOf(pluginId: string): PluginSettings | null {
  return registry.get(pluginId) ?? null;
}

export function onPluginSettingsChange(fn: () => void): () => void {
  registryListeners.add(fn);
  return () => registryListeners.delete(fn);
}

/** What is stored for a plugin, defaults filled in when it declared a schema.
 *  The broker's settings_get, for plugins that cannot import the handle. */
export function storedSettings(pluginId: string): SettingValues {
  return registry.get(pluginId)?.all() ?? clone(readStored(pluginId)?.values ?? {});
}

/** Leaves a marker rather than no key, or the next start would read the plugin's `legacy` keys again and bring the
 *  forgotten values back. */
export function removePluginSettings(pluginId: string) {
  // Reset first: it writes the defaults, and the marker has to come after.
  registry.get(pluginId)?.reset();
  const forgotten: Stored = { version: 0, values: {}, forgotten: true };
  try {
    storage()?.setItem(storageKey(pluginId), JSON.stringify(forgotten));
  } catch {
    /* blocked storage holds nothing to forget */
  }
}

/** Calling it again for the same id (a hot reload, switched off and on) replaces the earlier handle, reading what it
 *  stored. */
export function definePluginSettings(pluginId: string, schema: SettingsSchema): PluginSettings {
  const problems = validateSchema(schema);
  if (problems.length) throw new Error(`${pluginId} settings: ${problems.join("; ")}`);
  const props = new Map(schema.props.map((p) => [p.key, p]));
  const values: SettingValues = {};
  const listeners = new Set<(keys: string[]) => void>();

  const fill = (from: SettingValues) => {
    for (const p of schema.props) {
      const v = coerce(p, from[p.key]);
      values[p.key] = v === undefined ? clone(p.default) : clone(v);
    }
  };
  const write = () => {
    try {
      storage()?.setItem(storageKey(pluginId), JSON.stringify({ version: schema.version, values }));
    } catch {
      /* no storage, the change still holds for this session */
    }
  };

  const stored = readStored(pluginId);
  if (stored?.forgotten) {
    fill({});
  } else if (stored) {
    let from = stored.values;
    if (stored.version < schema.version && schema.migrate) {
      try {
        from = schema.migrate(clone(from), stored.version);
      } catch (err) {
        console.warn(`[plugins] ${pluginId} settings migration failed, using defaults:`, err);
        from = {};
      }
    }
    fill(from);
    if (stored.version < schema.version) write();
  } else {
    let from: SettingValues | null = null;
    try {
      from = schema.legacy?.() ?? null;
    } catch (err) {
      console.warn(`[plugins] ${pluginId} could not read its old settings:`, err);
    }
    fill(from ?? {});
    if (from) write();
  }

  const prop = (key: string) => {
    const p = props.get(key);
    if (!p) throw new Error(`${pluginId} has no setting "${key}"`);
    return p;
  };
  const emit = (keys: string[]) => {
    if (!keys.length) return;
    write();
    for (const fn of [...listeners]) {
      try {
        fn(keys);
      } catch (err) {
        console.error(`[plugins] ${pluginId} settings listener:`, err);
      }
    }
  };

  const handle: PluginSettings = {
    pluginId,
    schema,
    get: <T>(key: string) => clone(values[prop(key).key]) as T,
    all: () => clone(values),
    set(key, value) {
      const p = prop(key);
      const problem = valueProblem(p, value);
      if (problem) return `${p.label ?? key} ${problem}`;
      const v = coerce(p, value);
      if (same(values[key], v)) return null;
      values[key] = clone(v);
      emit([key]);
      return null;
    },
    reset(key) {
      const changed: string[] = [];
      for (const p of key === undefined ? schema.props : [prop(key)]) {
        if (same(values[p.key], p.default)) continue;
        values[p.key] = clone(p.default);
        changed.push(p.key);
      }
      emit(changed);
    },
    isDefault: (key) => same(values[prop(key).key], prop(key).default),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  registry.set(pluginId, handle);
  for (const fn of [...registryListeners]) fn();
  return handle;
}

/** Whether a property matches a search, by its label, description or group. */
export function settingMatches(p: SettingProp, query: string): boolean {
  if (p.type === "data") return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [p.label, p.description, p.group].some((s) => s?.toLowerCase().includes(q));
}
