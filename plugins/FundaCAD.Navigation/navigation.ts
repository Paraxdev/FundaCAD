// Pure apart from storage, so the tests can read every rule here.

import {
  bindingEntries,
  checkShortcut,
  formatShortcut,
  readSetting,
  shortcutLabel,
  type CtxItem,
  type PointerBinding,
  type SettingsSchema,
  type ShortcutOverride,
  type ShortcutProblem,
} from "fundacad";
import { t, tEnglish } from "./lines";

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
    get label() {
      return t("preset.right");
    },
    table: [
      { button: "right", shift: true, drag: "pan", click: "menu" },
      { button: "right", drag: "orbit", click: "menu" },
      { button: "middle", drag: "pan" },
    ],
  },
  {
    id: "middle-shift",
    get label() {
      return t("preset.middleShift");
    },
    table: [
      { button: "middle", shift: true, drag: "pan" },
      { button: "middle", ctrl: true, drag: "zoom" },
      { button: "middle", drag: "orbit" },
      { button: "right", click: "menu" },
    ],
  },
  {
    id: "middle-ctrl",
    get label() {
      return t("preset.middleCtrl");
    },
    table: [
      { button: "middle", ctrl: true, drag: "pan" },
      { button: "middle", shift: true, drag: "zoom" },
      { button: "middle", drag: "orbit" },
      { button: "right", click: "menu" },
    ],
  },
  {
    id: "alt-left",
    get label() {
      return t("preset.altLeft");
    },
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
  {
    id: "alt-right",
    get label() {
      return t("drag.altRight");
    },
  },
  {
    id: "right",
    get label() {
      return t("drag.right");
    },
  },
  {
    id: "middle",
    get label() {
      return t("drag.middle");
    },
  },
  {
    id: "none",
    get label() {
      return t("drag.none");
    },
  },
];

export type RadialContext = "model" | "selection" | "sketch";
export const RADIAL_CONTEXTS: { id: RadialContext; label: string }[] = [
  {
    id: "model",
    get label() {
      return t("ctx.model");
    },
  },
  {
    id: "selection",
    get label() {
      return t("ctx.selection");
    },
  },
  {
    id: "sketch",
    get label() {
      return t("ctx.sketch");
    },
  },
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
      get label() {
        return t("setting.preset");
      },
      get description() {
        return t("setting.presetHint");
      },
      default: DEFAULT_CONFIG.preset,
      options: PRESETS.map((p) => ({
        id: p.id,
        get label() {
          return p.label;
        },
      })),
    },
    {
      key: "radial",
      type: "boolean",
      get label() {
        return t("setting.radial");
      },
      get group() {
        return t("group.radial");
      },
      get description() {
        return t("setting.radialHint", { key: RADIAL_KEY.toUpperCase() });
      },
      default: DEFAULT_CONFIG.radial,
    },
    {
      key: "radialDrag",
      type: "enum",
      get label() {
        return t("setting.radialDrag");
      },
      get group() {
        return t("group.radial");
      },
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
    return {
      table,
      problem: t("radial.taken", { gesture: t("binding.gesture", { button, kind: "drag" }), action: plain.drag }),
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
    {
      ...(mine ?? { action: RADIAL_ACTION, key: RADIAL_KEY }),
      context: "global",
      get label() {
        return t("radial.name");
      },
    },
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
  return [
    ...all.slice(0, RING_SLOTS - 1),
    { label: t("ring.more"), icon: "more", children: all.slice(RING_SLOTS - 1) },
  ];
}

/** What each mouse binding of a table does, as `Right drag: orbit.` rows, one per drag and one click per button. */
export function bindingRows(table: readonly PointerBinding[]): { key: string; label: string }[] {
  return bindingEntries(table).map((e) => {
    const args = { button: e.button, kind: e.kind };
    const key = e.mods.length
      ? t("binding.gestureHeld", { ...args, mods: e.mods.join("+") })
      : t("binding.gesture", args);
    const label =
      e.what === "orbit"
        ? t("binding.orbit")
        : e.what === "pan"
          ? t("binding.pan")
          : e.what === "zoom"
            ? t("binding.zoom")
            : e.what === "gesture"
              ? t("binding.radial")
              : t("binding.context");
    return { key, label };
  });
}

// The host words these problems in English. Both sets are closed, the spec reads the host's table for drift, and a
// text not listed here shows as sent. A reserved name is matched on the plugin's English line of it, and the Alt
// refusal is asked of the host, which has no export for its text.
const altRefusal = () => (checkShortcut({ action: RADIAL_ACTION, key: "a", alt: true }) as { refused: string }).refused;
const RESERVED_LINES = [
  { say: () => t("reserved.undo"), english: () => tEnglish("reserved.undo") },
  { say: () => t("reserved.redo"), english: () => tEnglish("reserved.redo") },
  { say: () => t("reserved.save"), english: () => tEnglish("reserved.save") },
  { say: () => t("reserved.saveAs"), english: () => tEnglish("reserved.saveAs") },
  { say: () => t("reserved.new"), english: () => tEnglish("reserved.new") },
  { say: () => t("reserved.open"), english: () => tEnglish("reserved.open") },
  { say: () => t("reserved.export"), english: () => tEnglish("reserved.export") },
  { say: () => t("reserved.find"), english: () => tEnglish("reserved.find") },
  { say: () => t("reserved.palette"), english: () => tEnglish("reserved.palette") },
  { say: () => t("reserved.preferences"), english: () => tEnglish("reserved.preferences") },
  { say: () => t("reserved.items"), english: () => tEnglish("reserved.items") },
  { say: () => t("reserved.history"), english: () => tEnglish("reserved.history") },
  { say: () => t("reserved.console"), english: () => tEnglish("reserved.console") },
  { say: () => t("reserved.interfaceSize"), english: () => tEnglish("reserved.interfaceSize") },
  { say: () => t("reserved.cancel"), english: () => tEnglish("reserved.cancel") },
  { say: () => t("reserved.boxFilter"), english: () => tEnglish("reserved.boxFilter") },
  { say: () => t("reserved.delete"), english: () => tEnglish("reserved.delete") },
  { say: () => t("reserved.thisSheet"), english: () => tEnglish("reserved.thisSheet") },
];

export const RESERVED_NAMES: readonly string[] = RESERVED_LINES.map((l) => l.english());

export function problemText(p: ShortcutProblem): string {
  if ("conflict" in p) {
    return t("problem.used", { key: formatShortcut(p.conflict), label: shortcutLabel(p.conflict) });
  }
  if ("reserved" in p) {
    return t("problem.taken", { name: RESERVED_LINES.find((l) => l.english() === p.reserved)?.say() ?? p.reserved });
  }
  return p.refused === altRefusal() ? t("problem.alt") : p.refused;
}
