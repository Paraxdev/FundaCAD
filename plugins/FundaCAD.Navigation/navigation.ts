// Pure apart from storage, so the tests can read every rule here.

import { readSetting, type CtxItem, type PointerBinding, type SettingsSchema, type ShortcutOverride } from "fundacad";

export const PLUGIN_ID = "FundaCAD.Navigation";
/** Not "fundacad.navigation": the core's own navigation preferences use it. */
export const STORAGE_KEY = "fundacad.navigation.plugin";
export const RADIAL_ACTION = "navigation.radial";
export const RADIAL_KEY = "w";

export interface Preset {
  id: string;
  label: string;
  table: PointerBinding[];
}

export const PRESETS: Preset[] = [
  {
    id: "right",
    label: "Right orbits (default)",
    table: [
      { button: "right", shift: true, drag: "pan", click: "menu" },
      { button: "right", drag: "orbit", click: "menu" },
      { button: "middle", drag: "pan" },
    ],
  },
  {
    id: "middle-shift",
    label: "Middle orbits, Shift+middle pans",
    table: [
      { button: "middle", shift: true, drag: "pan" },
      { button: "middle", ctrl: true, drag: "zoom" },
      { button: "middle", drag: "orbit" },
      { button: "right", click: "menu" },
    ],
  },
  {
    id: "middle-ctrl",
    label: "Middle orbits, Ctrl+middle pans",
    table: [
      { button: "middle", ctrl: true, drag: "pan" },
      { button: "middle", shift: true, drag: "zoom" },
      { button: "middle", drag: "orbit" },
      { button: "right", click: "menu" },
    ],
  },
  {
    id: "alt-left",
    label: "Alt+left orbits",
    table: [
      { button: "left", alt: true, shift: true, drag: "pan" },
      { button: "left", alt: true, ctrl: true, drag: "zoom" },
      { button: "left", alt: true, drag: "orbit" },
      { button: "right", shift: true, drag: "pan", click: "menu" },
      { button: "right", drag: "orbit", click: "menu" },
      { button: "middle", drag: "pan" },
    ],
  },
];

export type RadialDrag = "none" | "alt-right" | "right" | "middle";
export const RADIAL_DRAGS: { id: RadialDrag; label: string }[] = [
  { id: "alt-right", label: "Alt+right drag" },
  { id: "right", label: "Right drag" },
  { id: "middle", label: "Middle drag" },
  { id: "none", label: "No mouse trigger, the key only" },
];

export type RadialContext = "model" | "selection" | "sketch";
export const RADIAL_CONTEXTS: { id: RadialContext; label: string }[] = [
  { id: "model", label: "Nothing selected" },
  { id: "selection", label: "Something selected" },
  { id: "sketch", label: "In a sketch" },
];

/** More than this and the rest go in a "More" ring. */
export const RING_SLOTS = 8;

export interface NavConfig {
  preset: string;
  radial: boolean;
  radialDrag: RadialDrag;
  items: Record<RadialContext, string[]>;
  keys: ShortcutOverride[];
}

export const DEFAULT_CONFIG: NavConfig = {
  preset: "right",
  radial: false,
  radialDrag: "alt-right",
  items: {
    model: ["sketch", "extrude", "presspull", "measure", "fit", "reset-camera", "toggle-wireframe", "show-all-bodies"],
    selection: ["fillet", "chamfer", "move", "presspull", "split", "hide-selected", "measure", "fit"],
    sketch: ["line", "rectangle", "circle", "arc", "dimension", "trim", "offset", "extrude"],
  },
  keys: [],
};

export const ICONS: Record<string, string> = {
  sketch: "sketch",
  extrude: "extrude",
  presspull: "presspull",
  measure: "measure",
  fit: "view-fit",
  "reset-camera": "view-reset",
  "toggle-wireframe": "wireframe",
  "show-all-bodies": "visible",
  fillet: "fillet",
  chamfer: "chamfer",
  move: "move",
  split: "split",
  "hide-selected": "hidden",
  line: "line",
  rectangle: "rectangle",
  circle: "circle",
  arc: "arc",
  dimension: "dimension",
  trim: "trim",
  offset: "offset",
  "boolean-union": "booleanUnion",
  "boolean-subtract": "booleanSubtract",
  "boolean-intersect": "booleanIntersect",
  hole: "hole",
  shell: "shell",
  "fillet-sketch": "fillet",
  project: "project",
  undo: "undo",
  redo: "redo",
  section: "section",
};

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : null;

function parseKey(v: unknown): ShortcutOverride | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.action !== "string" || typeof o.key !== "string") return null;
  return {
    action: o.action,
    key: o.key,
    ...(o.shift === true ? { shift: true } : {}),
    ...(o.ctrl === true ? { ctrl: true } : {}),
  };
}

/** Whatever was stored, made whole: anything missing or malformed is the default. */
export function parseConfig(raw: string | null): NavConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (!raw) return cfg;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw);
  } catch {
    return cfg;
  }
  if (!v || typeof v !== "object") return cfg;
  if (typeof v.preset === "string" && PRESETS.some((p) => p.id === v.preset)) cfg.preset = v.preset;
  if (typeof v.radial === "boolean") cfg.radial = v.radial;
  if (RADIAL_DRAGS.some((d) => d.id === v.radialDrag)) cfg.radialDrag = v.radialDrag as RadialDrag;
  const items = v.items as Record<string, unknown> | undefined;
  for (const c of RADIAL_CONTEXTS) {
    const list = strings(items?.[c.id]);
    if (list) cfg.items[c.id] = list;
  }
  if (Array.isArray(v.keys)) cfg.keys = v.keys.map(parseKey).filter((k): k is ShortcutOverride => !!k);
  return cfg;
}

/** The config the app's settings store holds, made whole. */
export function configOf(values: Record<string, unknown>): NavConfig {
  return parseConfig(JSON.stringify(values));
}

export const SETTINGS: SettingsSchema = {
  version: 1,
  props: [
    {
      key: "preset",
      type: "enum",
      label: "Mouse buttons",
      description:
        "The left button alone always selects. On Linux the window manager may take Alt+drag to move the window before the app sees it; the middle button presets avoid that.",
      default: DEFAULT_CONFIG.preset,
      options: PRESETS.map((p) => ({ id: p.id, label: p.label })),
    },
    {
      key: "radial",
      type: "boolean",
      label: "Radial menu",
      group: "Radial menu",
      description: `A ring of commands at the cursor, chosen by what you are doing. Hold the trigger, move towards a command and let go, or tap the key and click. Its key is ${RADIAL_KEY.toUpperCase()} unless you move it below.`,
      default: DEFAULT_CONFIG.radial,
    },
    {
      key: "radialDrag",
      type: "enum",
      label: "Mouse trigger",
      group: "Radial menu",
      default: DEFAULT_CONFIG.radialDrag,
      options: RADIAL_DRAGS,
      visibleWhen: (v) => v.radial === true,
    },
    { key: "items", type: "data", default: DEFAULT_CONFIG.items, parse: (v) => configOf({ items: v }).items },
    { key: "keys", type: "data", default: DEFAULT_CONFIG.keys, parse: (v) => configOf({ keys: v }).keys },
  ],
  legacy: () => {
    const raw = readSetting(STORAGE_KEY);
    return raw ? { ...parseConfig(raw) } : null;
  },
};

export function presetOf(cfg: NavConfig): Preset {
  return PRESETS.find((p) => p.id === cfg.preset) ?? PRESETS[0]!;
}

/** The mouse table for a config, and why the radial trigger could not be
 *  added to it when it could not. */
export function tableFor(cfg: NavConfig): { table: PointerBinding[]; problem: string | null } {
  const table = presetOf(cfg).table.map((b) => ({ ...b }));
  if (!cfg.radial || cfg.radialDrag === "none") return { table, problem: null };
  if (cfg.radialDrag === "alt-right") {
    return { table: [{ button: "right", alt: true, drag: "gesture", click: "menu" }, ...table], problem: null };
  }
  const button = cfg.radialDrag;
  const plain = table.find(
    (b) => b.button === button && b.shift === undefined && b.ctrl === undefined && b.alt === undefined,
  );
  if (plain?.drag) {
    const name = button === "right" ? "Right" : "Middle";
    return {
      table,
      problem: `${name} drag already does ${plain.drag} in this preset, so the radial menu is on its key only`,
    };
  }
  if (plain) plain.drag = "gesture";
  else table.push({ button, drag: "gesture" });
  return { table, problem: null };
}

/** The moved keys, plus the radial key while the radial menu is on. */
export function keymapFor(cfg: NavConfig): ShortcutOverride[] {
  const keys = cfg.keys.filter((k) => k.action !== RADIAL_ACTION);
  if (!cfg.radial) return keys;
  const mine = cfg.keys.find((k) => k.action === RADIAL_ACTION);
  return [
    ...keys,
    { ...(mine ?? { action: RADIAL_ACTION, key: RADIAL_KEY }), context: "global", label: "Radial menu" },
  ];
}

export function contextOf(sketching: boolean, selected: number): RadialContext {
  return sketching ? "sketch" : selected > 0 ? "selection" : "model";
}

/** A ring of items, the overflow under "More". */
export function radialItems(
  ids: readonly string[],
  run: (id: string) => void,
  label: (id: string) => string,
  hint: (id: string) => string | undefined,
): CtxItem[] {
  const item = (id: string): CtxItem => {
    const it: CtxItem = { label: label(id), onClick: () => run(id), shortcut: hint(id) };
    const icon = ICONS[id];
    if (icon) it.icon = icon;
    return it;
  };
  const all = ids.filter(Boolean).map(item);
  if (all.length <= RING_SLOTS) return all;
  return [...all.slice(0, RING_SLOTS - 1), { label: "More", icon: "more", children: all.slice(RING_SLOTS - 1) }];
}
