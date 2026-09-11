// What a plugin adds to the app, and the only way it gets in.
//
// The core has surfaces: a menubar, a ribbon, one action dispatcher, a stack of
// overlays, the right-click menu on a body, the paint on a body, the colours a
// tool may offer. A plugin has things to put on them. This module is the table
// in between, and the whole of its design is one sentence: IT NAMES NO PLUGIN,
// AND NO PLUGIN REACHES A SURFACE IT DID NOT COME THROUGH HERE.
//
// That is what the word "plugin" was doing no work for until now. Three
// capabilities lived under plugins/ with a manifest each while their code sat in
// src/print/, src/input/ and src/components/overlays/, and the core imported it
// by name: App.vue mounted a camera panel, the ribbon held a PRINT group behind
// an `if (printingEnabled())`, the menubar cached the 3D mouse's module. Every
// one of those was the core knowing what a capability IS, which is exactly the
// knowledge a plugin boundary exists to remove. A fourth capability could not
// have been added without editing all of them.
//
// WHAT IS AND IS NOT HERE. A contribution point exists because a surface in the
// core needs filling from outside and the core cannot fill it. There is no
// generic "do something on event X" hook, no way to replace a core behaviour,
// and no way to read another plugin's contributions except through `service()`,
// which hands back an opaque value the core never looks inside. A plugin that
// wants more than this needs a new point added on purpose, in the open, with
// the surface that reads it.
//
// LIFETIME. `contribute` returns the removal, and the removal is not decoration:
// a capability can be switched off mid-session and off has to mean its menu rows
// are gone, its overlays are unmounted and its paint is off the model. Each
// plugin's activate() calls this and its teardown calls what came back, which is
// the same discipline plugins/activate.ts already holds the loaders to.
//
// VUE-FREE AT RUNTIME, like ./registry.ts beside it and for the same reason: the
// headless suite imports this. `Component` below is an `import type` and is
// erased before anything runs.

import type { Component } from "vue";
import type { MenuItem } from "../ui/menu";
import type { CtxItem } from "../stores/contextMenu";
import type { EntityKind, EntitySource } from "../features/toolCapabilities";
import type { ChoiceField, FileField, ToggleField } from "../document/optionFields";
import type { FeatureMeta } from "../ui/featureMeta";
import type { FieldKind } from "../document/numFields";
import type { TargetField } from "../features/selectionTargets";

/** Undo a `contribute`. Idempotent: calling it twice is not an error. */
export type Unregister = () => void;

/** Rows added to one top-level menu.
 *
 *  `menu` is matched by label against what the core built, and a label that
 *  matches nothing becomes a new menu appended before Help. Both cases are
 *  wanted: the printer adds to File, and the 3D mouse owns the whole of View. */
export interface MenuContribution {
  menu: string;
  items: MenuItem[];
  /** Where an unmatched `menu` is placed. Ignored when it matched. */
  before?: string;
}

/** One ribbon button. The same three fields the core's own tables carry, so a
 *  contributed group is indistinguishable from a built-in one downstream, the
 *  command palette lists both without knowing which is which. */
export interface RibbonEntry {
  action: string;
  label: string;
  iconName: string;
}

export interface RibbonContribution {
  /** Group heading, in the ribbon's own upper-case style. */
  group: string;
  /** Collapse priority; lower folds into the overflow first. Defaults to the
   *  bottom of the order, because a plugin's group is the one the person is
   *  least likely to be reaching for when the window is too narrow for it. */
  priority?: number;
  items: RibbonEntry[];
}

/** Colours a plugin puts on the model, resolved fresh on every read.
 *
 *  A function rather than a value: this is asked at every rebuild and every
 *  chunk of a progressive load, and what it depends on (the document, the
 *  capability's own state) changes underneath it. */
export interface Paint {
  /** body id -> "#rrggbb" */
  bodies: Record<string, string>;
  /** global face index -> "#rrggbb" */
  faces: Record<number, string>;
}

/** A named colour a tool may offer. The core knows only the three fields it has
 *  to render; what a slot MEANS is the contributing plugin's business. */
export interface PaletteEntry {
  name: string;
  color: string;
  material?: string;
}

/** A panel a plugin adds to the browser, drawn as its own component.
 *
 *  A component rather than a description of rows, because the two sections that
 *  wanted this are an editable colour list and a connection indicator, and no
 *  row vocabulary that could express both would be smaller than the components
 *  themselves. The core places it and gets out of the way. */
export interface BrowserSection {
  /** Stable within the contributing plugin; used as the render key. */
  key: string;
  component: Component;
  /** Which of the browser's own filter sections it is hidden with, if any. A
   *  section naming one the core does not have is always shown. */
  filter?: string;
}

/** A block of settings a plugin adds to Preferences.
 *
 *  A component, for the same reason a browser section is one: what a plugin
 *  needs to ask is its own business, and no row vocabulary the app could invent
 *  would fit the next one. The app supplies the heading and the place. */
export interface SettingsSection {
  /** Stable within the contributing plugin; used as the render key. */
  key: string;
  /** The heading, in the dialog's own style. */
  title: string;
  component: Component;
}

/** A modeling tool a plugin adds, as the app has to know it.
 *
 *  A tool is not one thing to the app, it is five: a row in the capability
 *  inventory ("a face could feed this"), a mark in the selection toolbar, a
 *  button on the ribbon, an entry in the action dispatcher, and a claim on the
 *  window while it is running. The last three already had a way in, `ribbon`
 *  and `actions` below, and the plugin's own code for the gesture, so this
 *  point is the two that did not: WHAT THE TOOL CONSUMES, and WHETHER IT IS
 *  RUNNING.
 *
 *  Consuming is what makes a plugin's tool a peer of the app's own. Without it
 *  a contributed tool has a ribbon button and nothing else: selecting a face
 *  offers Fillet, Press/Pull and Delete Face and stays silent about the tool
 *  that is the whole reason a face is selected. `features/toolCapabilities.ts`
 *  merges these into the inventory it already keeps, and every reader of that
 *  inventory gets the answer without knowing a plugin exists.
 *
 *  Running is the smaller half and the one with teeth. `app/toolBusy.ts` gates
 *  every other command and every Escape handler in the app on "is a modal
 *  gesture in progress". A tool that could not answer it would leave a window
 *  where the app thinks it is idle, dispatches a second tool over the top of
 *  the first, and the user has two prompts and one Escape key. */
export interface ToolContribution {
  /** Stable id, and the action id the ribbon and the palette dispatch. The
   *  plugin must claim the same string under `actions`. */
  id: string;
  /** Human name, for prompts, menus and the selection toolbar. */
  label: string;
  /** Icon name, resolved the way every other icon in the app is. A plugin that
   *  draws its own mark contributes it under `icons` below. */
  iconName: string;
  /** Entity kinds this tool acts on, MOST SPECIFIC FIRST, the same ordering
   *  rule the core's own table documents. */
  consumes: readonly EntityKind[];
  source: EntitySource;
  /** Entities needed before the tool can run. Defaults to 1. */
  min?: number;
  /** Is the tool holding the window right now? Read at event time only, so a
   *  plain function is enough and nothing has to be reactive. */
  busy?: () => boolean;
}

/** How a feature TYPE in the document is drawn and edited.
 *
 *  A plugin that adds a tool usually adds a feature the tool makes, and that
 *  feature then outlives the gesture: it sits in the history with a mark and a
 *  name, its values are edited in the properties panel long after the panel
 *  that created it closed, and double-clicking it should reopen the tool. Every
 *  one of those is a core surface that used to answer from a table with the
 *  feature's name typed into it.
 *
 *  ONE point rather than five, because they are all the same sentence, how
 *  this feature type is presented, and five would be five things to remember
 *  to contribute, four of which fail silently: a missing `meta` is a grey dot
 *  in the tree, a missing `numFields` is a feature whose numbers cannot be
 *  edited, and neither throws.
 *
 *  WHAT THIS IS NOT. It does not add a feature type to the document, and it
 *  cannot: the document's schema and the geometry that builds it stay in the
 *  app, because a file must open and rebuild on a machine where the plugin was
 *  never installed. Uninstalling may cost you the ability to CREATE and EDIT
 *  one of these features. It may not cost you the ones you already made.
 *
 *  NOR DOES IT OWN THE NUMERIC ROWS, which is the same rule read twice.
 *  `document/numFields.ts` is not a list of labels, it is the inventory of what
 *  a PARAMETER can drive, and `resolveTarget` reads it to answer what
 *  `texture1.depth` refers to. A parameter has to keep meaning the same thing
 *  on a machine where the plugin is switched off, so that table stays in the
 *  app. What a plugin owns is which of those rows are worth showing and what
 *  they are called, `fieldApplies` and `fieldLabel` below, which is
 *  presentation, and changes nothing about what the document means. */
export interface FeatureTypeContribution {
  /** The `type` field of the feature in the document. */
  type: string;
  /** Mark and word for the history and the browser tree. */
  meta?: FeatureMeta;
  /** Fixed-choice rows (a dropdown). */
  choiceFields?: readonly ChoiceField[];
  /** On/off rows (a switch). */
  toggleFields?: readonly ToggleField[];
  /** Rows whose value is a path on disk (a button that opens the native
   *  dialog). The app ships no feature that reads a file, so this point exists
   *  entirely for plugins; `fieldApplies` gates it like every other row. */
  fileFields?: readonly FileField[];
  /** Does this field mean anything, given what the feature's other fields say?
   *  Absent means every field always applies, which is the honest default. */
  fieldApplies?: (field: string, values: Record<string, unknown>) => boolean;
  /** A row label that depends on the feature's own values, for the rare field
   *  whose name is not a constant. Null for "use the inventory's label". */
  fieldLabel?: (
    field: string,
    values: Record<string, unknown>,
  ) => { text: string; title?: string } | null;
  /** Re-open a committed feature in the tool that made it. False means "not
   *  tool-editable", a parameter-bound value, say, and the app falls back to
   *  the value rows, exactly as it does for its own tools. */
  edit?: (featureId: string, done: (id: string | null) => void) => boolean;
  /** The feature's parameter-drivable numeric rows, as
   *  `[field, label, kind]`, the same shape the app's own inventory uses.
   *
   *  A plugin that OWNS a feature type owns these too, because the app can no
   *  longer know them: the type is not in its union and the geometry that reads
   *  the fields is in the plugin's own directory. What the app keeps is the
   *  guarantee underneath, a feature type nobody describes still round-trips
   *  with its values intact and its parameter bindings unbroken (see
   *  document/numFields.ts), so uninstalling a plugin cannot cost you the
   *  numbers you typed. */
  numFields?: readonly [string, string, FieldKind][];
  /** The feature's editable geometry selections (the Faces/Edges/Bodies rows).
   *  Owned by the plugin for the same reason as `numFields`. */
  targets?: readonly TargetField[];
}

export interface Contribution {
  menus?: MenuContribution[];
  ribbon?: RibbonContribution[];
  /** Action id -> what to do. The id reaches here from the ribbon, the command
   *  palette, the keymap and every context menu, exactly as a core action does;
   *  app/actions.ts asks this table only after its own switch has declined. */
  actions?: Record<string, () => void>;
  /** Components mounted for the whole life of the capability, at the end of the
   *  overlay stack. Each is responsible for its own visibility: mounting one
   *  does not show it, and there is no `show` predicate here because every one
   *  of them already has state of its own that decides. */
  overlays?: Component[];
  /** Extra rows on a body's right-click menu, in the browser and the viewport. */
  bodyMenu?: (bodyId: string) => CtxItem[];
  browserSections?: BrowserSection[];
  /** Blocks in Preferences.
   *
   *  A settings block that outlives the thing it configures is worse than a
   *  missing one: it offers a choice that decides nothing, about a feature that
   *  is not there. Contributing it is what makes it appear and disappear with
   *  its plugin, with no check anywhere naming that plugin. */
  settings?: SettingsSection[];
  /** Modeling tools, joined to the app's own inventory. */
  tools?: ToolContribution[];
  /** How the feature types a plugin's tools produce are drawn and edited. */
  features?: FeatureTypeContribution[];
  /** Icon name -> inner SVG markup, drawn inside the app's shared 24x24 stroke
   *  wrapper. Resolved AFTER both icon packs, so a pack the user chose keeps
   *  the last word over a plugin's idea of how a mark should look.
   *
   *  THIS MARKUP REACHES THE DOM THROUGH v-html, which is the one sanctioned
   *  v-html in the app and was safe because every path in ui/icons.ts is a
   *  compile-time constant. A contributed path is a constant in a bundle whose
   *  code already runs with the whole of the app's reach, it could call
   *  innerHTML itself, so this widens the surface without lowering the bar.
   *  What must still hold: no document data, file name or network payload is
   *  interpolated into it, here any more than there. */
  icons?: Record<string, string>;
  paint?: () => Paint;
  palette?: () => PaletteEntry[];
  /** A mesh import landed, and the file carried a colour of its own ("#rrggbb").
   *
   *  The core has no use for that colour: it has nothing to match it against,
   *  and inventing something would be a colour scheme nobody asked for. So it
   *  says what happened, names the feature it happened to, and whoever cares
   *  decides. Awaited, because what a listener does about it (rebuild, then find
   *  the bodies that feature owns) has to finish before the import is over. */
  importedBody?: (featureId: string, color: string) => void | Promise<void>;
  /** Values offered to OTHER plugins, by name.
   *
   *  Opaque here on purpose, in the same way the installer compares grant
   *  strings without knowing what a grant means: the core stores it, hands it
   *  back to whoever asks for that name, and has no opinion about what is in it.
   *  Two plugins agreeing on a name is a contract between them. */
  provides?: Record<string, unknown>;
}

interface Entry {
  plugin: string;
  c: Contribution;
}

let entries: Entry[] = [];
const listeners = new Set<() => void>();

function changed() {
  for (const fn of listeners) fn();
}

/** Add a plugin's contributions. Returns the removal.
 *
 *  One call per plugin rather than one per point, so that "everything this
 *  capability adds" is a single object in a single file, and so that turning it
 *  off cannot half-succeed. */
export function contribute(plugin: string, c: Contribution): Unregister {
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

/** Subscribe to any change in what is contributed; returns the unsubscribe.
 *
 *  Coarse on purpose. A surface that redraws when an unrelated capability
 *  starts has redrawn once for nothing; a surface that does not redraw when its
 *  own capability starts is wrong until the next unrelated event. */
export function onContribChange(fn: () => void): Unregister {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every contribution of one kind, in registration order. */
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

export function contributedSettings(): { key: string; section: SettingsSection }[] {
  const out: { key: string; section: SettingsSection }[] = [];
  for (const e of entries) {
    for (const section of e.c.settings ?? []) {
      out.push({ key: `${e.plugin}:${section.key}`, section });
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

/** The handler for an action id, or null when nobody claimed it.
 *
 *  First claim wins, and a second claim is not an error worth throwing over: two
 *  capabilities that both answer to "print-send" is a mistake in this repository
 *  and a broken button in somebody else's, and the second is not improved by an
 *  exception thrown out of a click handler. */
export function contributedAction(action: string): (() => void) | null {
  for (const e of entries) {
    const fn = e.c.actions?.[action];
    if (fn) return fn;
  }
  return null;
}

/** Every action id anything has claimed. What the ribbon and the command
 *  palette need to decide a button exists. */
export function contributedActionIds(): string[] {
  const out: string[] = [];
  for (const e of entries) out.push(...Object.keys(e.c.actions ?? {}));
  return out;
}

/** Extra rows for a body's right-click menu, from everyone who has some. */
export function contributedBodyMenu(bodyId: string): CtxItem[] {
  const out: CtxItem[] = [];
  for (const e of entries) out.push(...(e.c.bodyMenu?.(bodyId) ?? []));
  return out;
}

/** Every contributed tool, in registration order. */
export function contributedTools(): ToolContribution[] {
  return all("tools").flat();
}

/** Is any contributed tool holding the window?
 *
 *  What app/toolBusy.ts adds to its list of eleven `.active` fields. A plugin
 *  that does not answer counts as idle, which is the only safe default: one
 *  stuck reporting busy would freeze every command in the app. */
export function anyToolBusy(): boolean {
  return contributedTools().some((t) => t.busy?.() === true);
}

/** What a plugin says about one feature type, or null.
 *
 *  First claim wins, for the same reason `contributedAction` gives it to the
 *  first: two plugins describing the same feature type is a mistake in this
 *  repository and a confusing properties panel in somebody else's, and the
 *  second is not improved by an exception thrown mid-render. */
export function contributedFeature(type: string): FeatureTypeContribution | null {
  for (const e of entries) {
    for (const f of e.c.features ?? []) if (f.type === type) return f;
  }
  return null;
}

/** Every feature type anything has described. */
export function contributedFeatureTypes(): string[] {
  const out: string[] = [];
  for (const e of entries) for (const f of e.c.features ?? []) out.push(f.type);
  return out;
}

/** Icon name -> markup, merged. First contribution of a name wins, so a plugin
 *  cannot quietly redraw another plugin's mark by loading second. */
export function contributedIcons(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    for (const [name, markup] of Object.entries(e.c.icons ?? {})) {
      if (!(name in out)) out[name] = markup;
    }
  }
  return out;
}

/** Every contributed colour, merged.
 *
 *  Later contributions win a collision, which is arbitrary and has to be:
 *  nothing here can tell which of two capabilities is more entitled to paint a
 *  body. Today exactly one contributes paint at all. */
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

/** The colours a tool may offer, or an empty list when nobody has any.
 *
 *  Empty is the meaningful answer and not a degenerate one: a tool that asks
 *  this and gets nothing shows no colour row, which is what a document with no
 *  palette has always looked like. */
export function contributedPalette(): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const fn of all("palette")) out.push(...fn());
  return out;
}

/** Tell whoever cares that an imported mesh carried its own colour. */
export async function announceImportedBody(featureId: string, color: string): Promise<void> {
  for (const fn of all("importedBody")) await fn(featureId, color);
}

/** A value another plugin offered under `name`, or null.
 *
 *  Unsafely typed by design, in the sense that the core cannot check it: the
 *  caller names the type it expects and the two plugins are what agree. The
 *  core's job is to make the lookup possible and to make it disappear when the
 *  provider is switched off, so that "is that capability running" needs no
 *  second question. */
export function service<T>(name: string): T | null {
  for (const e of entries) {
    const v = e.c.provides?.[name];
    if (v !== undefined) return v as T;
  }
  return null;
}

/** Every plugin id with something registered. For tests and diagnostics. */
export function contributors(): string[] {
  return entries.map((e) => e.plugin);
}

/** Drop everything. Tests only: a suite that leaves a contribution behind
 *  changes what the next one renders. */
export function resetContributions(): void {
  entries = [];
  changed();
}
