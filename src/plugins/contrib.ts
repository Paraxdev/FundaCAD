// What a plugin adds to the app, and the only way in. It names no plugin. `contribute` returns the removal, so a
// plugin switched off mid-session loses its rows, overlays and paint. Vue-free: the headless suite imports it.

import type { Component } from "vue";
import type { MenuItem } from "../ui/menu";
import type { CtxItem } from "../stores/contextMenu";
import type { EntityKind, EntitySource } from "../features/toolCapabilities";
import type { ChoiceField, FileField, ToggleField } from "../document/optionFields";
import type { FeatureMeta } from "../ui/featureMeta";
import type { FieldKind } from "../document/numFields";
import type { TargetField } from "../features/selectionTargets";
import type { PluginSettings } from "./settings";
import type { MaterialDef } from "../document/materials";
import { setPointerBindings, type PointerBinding, type PointerGesture } from "../viewport/navigator/bindings";
import { setShortcutOverrides, type ShortcutOverride } from "../input/shortcuts";

/** Undo a `contribute`. Idempotent: calling it twice is not an error. */
export type Unregister = () => void;

/** `menu` matches a core menu by label. An unmatched label becomes a new menu before Help. */
export interface MenuContribution {
  menu: string;
  items: MenuItem[];
  /** Where an unmatched `menu` is placed. Ignored when it matched. */
  before?: string;
}

/** The core's own three fields, so downstream, like the command palette, cannot tell it from a built-in button. */
export interface RibbonEntry {
  action: string;
  label: string;
  iconName: string;
}

export interface RibbonContribution {
  /** Group heading, in the ribbon's own upper-case style. */
  group: string;
  /** Collapse priority, lower folds into the overflow first. Defaults to the bottom, so a plugin's group folds
   *  first. */
  priority?: number;
  items: RibbonEntry[];
}

/** Colours a plugin puts on the model. Contributed as a function, re-read at every rebuild and progressive load
 *  chunk. */
export interface Paint {
  /** body id -> "#rrggbb" */
  bodies: Record<string, string>;
  /** global face index -> "#rrggbb" */
  faces: Record<number, string>;
}

/** Fine parallel ridges drawn across a body, through its shading only. */
export interface Relief {
  /** The direction the ridges stack along, in world space. */
  axis: [number, number, number];
  /** Ridge spacing, mm. */
  pitch: number;
  /** Ridge depth as a fraction of the pitch: 0 is flat, 0.5 a half round. */
  depth: number;
  /** Shade variation from ridge to ridge, 0..1. */
  tintJitter?: number;
  /** Darkening in the seam between ridges, 0..1. */
  cavity?: number;
}

/** Ridges a plugin puts on the model, resolved fresh on every read like Paint.
 *  A body's entry is preferred over `all`, and a null takes `all` off it. */
export interface ReliefMap {
  all?: Relief;
  bodies?: Record<string, Relief | null>;
}

/** A named colour a tool may offer. The core knows only the three fields it has
 *  to render; what a slot MEANS is the contributing plugin's business. */
export interface PaletteEntry {
  name: string;
  color: string;
  material?: string;
}

/** A browser panel drawn by the plugin's own component. The core places it and gets out of the way. */
export interface BrowserSection {
  /** Stable within the contributing plugin; used as the render key. */
  key: string;
  component: Component;
  /** The browser filter section it is hidden with. One the core does not have means always shown. */
  filter?: string;
}

export interface MaterialPresetGroup {
  group: string;
  materials: MaterialDef[];
}

export type RenderTab = "material" | "environment" | "camera";

/** A block a plugin adds to the end of one Render dock tab, drawn as its own
 *  component. `fundacad/ui` has the rows the dock itself is made of. */
export interface RenderSection {
  /** Stable within the contributing plugin; used as the render key. */
  key: string;
  component: Component;
  tab: RenderTab;
}

/** Settings under the plugin's row in Preferences > Plugins. Declared `settings` are drawn from their schema
 *  (./settings.ts), `component` is for what a schema cannot express and is drawn below them. */
export interface SettingsSection {
  /** Stable within the contributing plugin; used as the render key. */
  key: string;
  /** A heading over this block, when a plugin has more than one. */
  title?: string;
  settings?: PluginSettings;
  component?: Component;
}

/** What the app must know of a plugin's tool beyond its button and action: what it consumes, so a selection offers it
 *  like a core tool, and whether it is busy, which app/toolBusy.ts gates other commands and Escape on. */
export interface ToolContribution {
  /** Stable id, and the action id the ribbon and palette dispatch. The plugin must claim it under `actions`. */
  id: string;
  /** Human name, for prompts, menus and the selection toolbar. */
  label: string;
  /** Resolved like every icon in the app. A plugin that draws its own mark contributes it under `icons`. */
  iconName: string;
  /** Entity kinds this tool acts on, MOST SPECIFIC FIRST, as in the core's own table. */
  consumes: readonly EntityKind[];
  source: EntitySource;
  /** Entities needed before the tool can run. Defaults to 1. */
  min?: number;
  /** Read at event time only, so a plain function is enough and nothing has to be reactive. */
  busy?: () => boolean;
  /** Stand the tool down, called when New or Open replaces its document. */
  cancel?: () => void;
}

/** How a feature type is drawn and edited: history mark, property rows, reopening its tool. One point, not five, since
 *  most missing pieces fail silently. A feature whose plugin is gone still opens, saves and keeps its numbers. */
export interface FeatureTypeContribution {
  /** The `type` field of the feature in the document. */
  type: string;
  /** Mark and word for the history and the browser tree. */
  meta?: FeatureMeta;
  /** Fixed-choice rows (a dropdown). */
  choiceFields?: readonly ChoiceField[];
  /** On/off rows (a switch). */
  toggleFields?: readonly ToggleField[];
  /** Rows whose value is a path on disk, edited through the native dialog. No core feature reads a file, so this is for
   *  plugins; `fieldApplies` gates it like every other row. */
  fileFields?: readonly FileField[];
  /** Whether a field means anything given the other fields. Absent means every field always applies. */
  fieldApplies?: (field: string, values: Record<string, unknown>) => boolean;
  /** A row label that depends on the feature's own values. Null means use the inventory's label. */
  fieldLabel?: (field: string, values: Record<string, unknown>) => { text: string; title?: string } | null;
  /** Reopen a committed feature in its tool. False means not tool-editable, and the app falls back to the value
   *  rows. */
  edit?: (featureId: string, done: (id: string | null) => void) => boolean;
  /** Parameter-drivable numeric rows as `[field, label, kind]`. A function when rows depend on values; a field may then
   *  be a path into a list, `nodes.n3.sx`, naming the entry by `id`, never index, so a binding follows the node. */
  numFields?:
    | readonly [string, string, FieldKind][]
    | ((values: Record<string, unknown>) => readonly [string, string, FieldKind][]);
  /** The feature's editable geometry selections (the Faces/Edges/Bodies rows). */
  targets?: readonly TargetField[];
}

export interface Contribution {
  menus?: MenuContribution[];
  ribbon?: RibbonContribution[];
  /** Action id to handler, reached from the ribbon, palette, keymap and context menus like a core action.
   *  app/actions.ts asks this table only after its own switch declined. */
  actions?: Record<string, () => void>;
  /** Mounted for the capability's whole life at the end of the overlay stack. Each decides its own visibility. */
  overlays?: Component[];
  /** Extra rows on a body's right-click menu, in the browser and the viewport. */
  bodyMenu?: (bodyId: string) => CtxItem[];
  browserSections?: BrowserSection[];
  /** Blocks at the end of a Render dock tab. */
  renderSections?: RenderSection[];
  /** Starting points for the Render dock's New material menu, one submenu per group. A pick adds a plain copy, so the
   *  file opens without the plugin. Entries are normalised like a file's materials; non-materials are skipped. */
  materialPresets?: () => MaterialPresetGroup[];
  /** Blocks in Preferences. Contributed, so they appear and disappear with their plugin. */
  settings?: SettingsSection[];
  /** Modeling tools, joined to the app's own inventory. */
  tools?: ToolContribution[];
  /** How the feature types a plugin's tools produce are drawn and edited. */
  features?: FeatureTypeContribution[];
  /** Icon name to inner SVG markup inside the shared 24x24 stroke wrapper, resolved after both icon packs. It reaches
   *  the DOM through v-html, so no document data, file name or network payload may be interpolated into it. */
  icons?: Record<string, string>;
  paint?: () => Paint;
  relief?: () => ReliefMap;
  palette?: () => PaletteEntry[];
  /** A mesh import carried its own colour ("#rrggbb"). The core has no use for it, so it names the feature and
   *  listeners decide. Awaited, so a listener's rebuild and body lookup finish before the import does. */
  importedBody?: (featureId: string, color: string) => void | Promise<void>;
  /** Values offered to other plugins by name. Opaque to the core: two plugins agreeing on a name is their contract. */
  provides?: Record<string, unknown>;
  /** The mouse binding table (viewport/navigator/bindings.ts), replacing the default. Needs input.remap, one plugin at
   *  a time, a second is refused. Selection stays on the left button whatever the table says. */
  pointerBindings?: readonly PointerBinding[];
  /** Called when a binding's "gesture" drag starts. */
  onPointerGesture?: (g: PointerGesture) => void;
  /** Keys moved to other actions (input/shortcuts.ts). Same grant, same one plugin rule. */
  keymap?: readonly ShortcutOverride[];
}

interface Entry {
  plugin: string;
  c: Contribution;
}

let entries: Entry[] = [];
const listeners = new Set<() => void>();

let grantsOf: (plugin: string) => readonly string[] | undefined = () => undefined;

/** Set by plugins/activate.ts. Ids name themselves, so this keeps an honest plugin inside what its install screen said;
 *  a guardrail, not a security boundary. */
export function setGrantLookup(fn: (plugin: string) => readonly string[] | undefined) {
  grantsOf = fn;
}

let appliedBindings: Entry | null = null;
let appliedKeymap: Entry | null = null;

function applyRemap() {
  const b = entries.find((e) => e.c.pointerBindings) ?? null;
  if (b !== appliedBindings) {
    appliedBindings = b;
    try {
      setPointerBindings(b?.c.pointerBindings ?? null, b?.c.onPointerGesture);
    } catch (err) {
      console.error(`[plugins] ${b!.plugin}:`, err);
      setPointerBindings(null);
    }
  }
  const k = entries.find((e) => e.c.keymap) ?? null;
  if (k !== appliedKeymap) {
    appliedKeymap = k;
    const problems = setShortcutOverrides(k?.c.keymap ?? []);
    if (problems.length) console.warn(`[plugins] ${k!.plugin} keymap:`, problems);
  }
}

function changed() {
  applyRemap();
  for (const fn of listeners) fn();
}

/** One call per plugin rather than per point, so turning a capability off cannot half succeed. Returns the removal. */
export function contribute(plugin: string, c: Contribution): Unregister {
  for (const point of ["pointerBindings", "keymap"] as const) {
    if (!c[point]) continue;
    if (!grantsOf(plugin)?.includes("input.remap")) {
      throw new Error(`${plugin} contributes ${point} without the input.remap grant`);
    }
    const other = entries.find((e) => e.c[point] && e.plugin !== plugin);
    if (other) throw new Error(`${plugin} contributes ${point}, which ${other.plugin} already does`);
  }
  for (const section of c.settings ?? []) {
    // No grant for a plugin's own settings, so the one rule is that they are its own.
    if (section.settings && section.settings.pluginId !== plugin) {
      throw new Error(`${plugin} contributes the settings of ${section.settings.pluginId}`);
    }
  }
  const entry: Entry = { plugin, c };
  entries = [...entries, entry];
  changed();
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    entries = entries.filter((e) => e !== entry);
    changed();
  };
}

/** Coarse on purpose: a needless redraw costs once, a missed one is wrong until the next unrelated event. */
export function onContribChange(fn: () => void): Unregister {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function all<K extends keyof Contribution>(key: K): NonNullable<Contribution[K]>[] {
  const out: NonNullable<Contribution[K]>[] = [];
  for (const e of entries) {
    const v = e.c[key];
    if (v !== undefined) out.push(v as NonNullable<Contribution[K]>);
  }
  return out;
}

export function contributedMenus(): MenuContribution[] {
  return all("menus").flat();
}

export function contributedRibbon(): RibbonContribution[] {
  return all("ribbon").flat();
}

export function contributedOverlays(): { key: string; component: Component }[] {
  const out: { key: string; component: Component }[] = [];
  for (const e of entries) {
    (e.c.overlays ?? []).forEach((component, i) => {
      out.push({ key: `${e.plugin}:${i}`, component });
    });
  }
  return out;
}

export function contributedSettings(): { key: string; plugin: string; section: SettingsSection }[] {
  const out: { key: string; plugin: string; section: SettingsSection }[] = [];
  for (const e of entries) {
    for (const section of e.c.settings ?? []) {
      out.push({ key: `${e.plugin}:${section.key}`, plugin: e.plugin, section });
    }
  }
  return out;
}

export function contributedBrowserSections(): { key: string; section: BrowserSection }[] {
  const out: { key: string; section: BrowserSection }[] = [];
  for (const e of entries) {
    for (const section of e.c.browserSections ?? []) {
      out.push({ key: `${e.plugin}:${section.key}`, section });
    }
  }
  return out;
}

export function contributedRenderSections(tab: RenderTab): { key: string; section: RenderSection }[] {
  const out: { key: string; section: RenderSection }[] = [];
  for (const e of entries) {
    for (const section of e.c.renderSections ?? []) {
      if (section.tab === tab) out.push({ key: `${e.plugin}:${section.key}`, section });
    }
  }
  return out;
}

export function contributedMaterialPresets(): MaterialPresetGroup[] {
  const out: MaterialPresetGroup[] = [];
  for (const e of entries) {
    let groups: MaterialPresetGroup[] = [];
    try {
      groups = e.c.materialPresets?.() ?? [];
    } catch {
      continue;
    }
    for (const g of groups) {
      if (!g || typeof g.group !== "string" || !Array.isArray(g.materials)) continue;
      const materials = g.materials.filter((m) => m && typeof m.name === "string" && typeof m.color === "string");
      if (materials.length) out.push({ group: g.group, materials });
    }
  }
  return out;
}

/** The first claim wins. Two claims are a mistake, but an exception thrown from a click handler would not improve
 *  it. */
export function contributedAction(action: string): (() => void) | null {
  for (const e of entries) {
    const fn = e.c.actions?.[action];
    if (fn) return fn;
  }
  return null;
}

/** What the ribbon and the command palette need to decide a button exists. */
export function contributedActionIds(): string[] {
  const out: string[] = [];
  for (const e of entries) out.push(...Object.keys(e.c.actions ?? {}));
  return out;
}

export function contributedBodyMenu(bodyId: string): CtxItem[] {
  const out: CtxItem[] = [];
  for (const e of entries) out.push(...(e.c.bodyMenu?.(bodyId) ?? []));
  return out;
}

export function contributedTools(): ToolContribution[] {
  return all("tools").flat();
}

/** Null when the app owns the tool. The selection rail groups a plugin's tools under its own heading with this. */
export function contributedToolOwner(toolId: string): string | null {
  for (const e of entries) {
    for (const t of e.c.tools ?? []) if (t.id === toolId) return e.plugin;
  }
  return null;
}

/** Added to app/toolBusy.ts. A plugin that does not answer counts as idle: one stuck busy would freeze every
 *  command. */
export function anyToolBusy(): boolean {
  return contributedTools().some((t) => t.busy?.() === true);
}

export function cancelContributedTools(run: (cancel: () => void) => void = (c) => c()) {
  for (const t of contributedTools()) if (t.busy?.() === true) run(() => t.cancel?.());
}

/** The first claim wins, as in `contributedAction`: an exception thrown mid-render would not improve a duplicate. */
export function contributedFeature(type: string): FeatureTypeContribution | null {
  for (const e of entries) {
    for (const f of e.c.features ?? []) if (f.type === type) return f;
  }
  return null;
}

export function contributedFeatureTypes(): string[] {
  const out: string[] = [];
  for (const e of entries) for (const f of e.c.features ?? []) out.push(f.type);
  return out;
}

/** The first contribution of a name wins, so a plugin cannot quietly redraw another's mark by loading second. */
export function contributedIcons(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    for (const [name, markup] of Object.entries(e.c.icons ?? {})) {
      if (!(name in out)) out[name] = markup;
    }
  }
  return out;
}

/** Later contributions win a collision, arbitrarily: nothing here can tell which capability is more entitled to a
 *  body. */
export function contributedPaint(): Paint {
  const bodies: Record<string, string> = {};
  const faces: Record<number, string> = {};
  for (const fn of all("paint")) {
    const p = fn();
    Object.assign(bodies, p.bodies);
    Object.assign(faces, p.faces);
  }
  return { bodies, faces };
}

/** Every contributed relief, merged like paint: later contributions are preferred. */
export function contributedRelief(): ReliefMap {
  let base: Relief | undefined;
  const bodies: Record<string, Relief | null> = {};
  for (const fn of all("relief")) {
    const r = fn();
    if (r.all !== undefined) base = r.all;
    Object.assign(bodies, r.bodies);
  }
  const out: ReliefMap = {};
  if (base) out.all = base;
  if (Object.keys(bodies).length) out.bodies = bodies;
  return out;
}

/** Empty is meaningful: a tool that gets nothing shows no colour row, as a document without a palette always has. */
export function contributedPalette(): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const fn of all("palette")) out.push(...fn());
  return out;
}

export async function announceImportedBody(featureId: string, color: string): Promise<void> {
  for (const fn of all("importedBody")) await fn(featureId, color);
}

/** The core cannot check the type: the caller names it and the two plugins agree. The value vanishes when its provider
 *  is switched off, so "is that capability running" needs no second question. */
export function service<T>(name: string): T | null {
  for (const e of entries) {
    const v = e.c.provides?.[name];
    if (v !== undefined) return v as T;
  }
  return null;
}

/** For tests and diagnostics. */
export function contributors(): string[] {
  return entries.map((e) => e.plugin);
}

/** Tests only: a suite that leaves a contribution behind changes what the next one renders. */
export function resetContributions(): void {
  entries = [];
  changed();
}
