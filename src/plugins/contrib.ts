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
 *  contributed group is indistinguishable from a built-in one downstream — the
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
