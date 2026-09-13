<script setup lang="ts">
// Left browser, MCAD-style: object-oriented, collapsible folders rather than a
// flat feature list. Origin (the three base planes, click to start a sketch on
// one), Bodies (grouped by the imported assembly tree when there is one) and
// Sketches, plus whatever the running plugins add between the two. The
// chronological operations (extrude/fillet/…) live in the bottom Timeline, as in
// mainstream MCAD.
//
// A filament palette used to be a section here, with two node kinds of its own,
// a connection dot, a one-shot printer probe and a thirty-second staleness poll,
// a panel about a machine on the network, inside the panel that lists what is
// in the document, behind checks on two capabilities. It is contributed now, by
// the capability whose subject it is, and this file does not know it exists.
//
// What the imperative class needed and this does not: a render-skip signature
// (the panel rebuilt its whole innerHTML on every doc change AND every build, so
// it had to hash everything it displayed to avoid painting twice), scroll
// save/restore around that wipe, and a per-render map of rename hooks so
// "Rename…" from the viewport could reach a row. Vue patches in place, so the
// scroll position and an open inline edit simply survive; see TreeRow/InlineLabel.
//
// The panel is a FLAT list of nodes rather than nested components. That is the
// DOM the stylesheet targets (`.tree-child` is a padding-left, not a container)
// and what the e2e suite walks, and it keeps the assembly recursion in one
// readable pass instead of a recursive component whose props thread through
// every level.

import { computed, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue } from "../../app/useDoc";
import { useSelectionStore } from "../../stores/selection";
import { useBrowserStore } from "../../stores/browser";
import TreeFolder from "./TreeFolder.vue";
import TreeRow from "./TreeRow.vue";
import Icon from "./Icon.vue";
import { useShellStore } from "../../stores/shell";
import { contextMenu } from "../../ui/menu";
import {
  bodyExtraMenu, buildBodyTree, collectGroupBodyIds, elementMoveMenu, elementPath,
  materialMenu, type BodyRef, type TreeGroup,
} from "../../ui/browserTree";
import { ancestryOf } from "../../document/elements";
import {
  BROWSER_FILTERS, asBrowserFilter, getBrowserFilter, isBrowserSection,
  onBrowserFilterChange, sectionVisible, setBrowserFilter, type BrowserSection,
} from "../../ui/browserFilter";
import type { CtxItem } from "../../ui/menu";
import { actOn as actOnSelection, EMPTY_SELECTION, modsOf, selectRow } from "../../ui/rowSelection";
import { VisibilityPaint } from "../../ui/visibilityPaint";
import { contributedBrowserSections, contributedPalette, onContribChange } from "../../plugins/contrib";
import type { Component } from "vue";
import { featuresOf } from "../../types";
import type { CadDocument, Feature, Plane3 } from "../../types";

const engine = useEngine();

/** The card's own menu: whole-document visibility verbs. */
function openMore(ev: MouseEvent) {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  const store = engine.store;
  const bodies = store.buildState.result?.bodies ?? [];
  const anyHidden = bodies.some((b) => !store.isBodyVisible(b.id));
  contextMenu(r.left, r.top - 8, [
    { label: "Hide Selected Bodies", disabled: !engine.viewport.getSelectedBodies().length, onClick: () => engine.handleAction("hide-selected") },
    { label: "Show Hidden Bodies", disabled: !anyHidden, onClick: () => engine.handleAction("show-all-bodies") },
    { label: "Invert Body Visibility", disabled: !bodies.length, onClick: () => store.setBodiesVisibility(new Map(bodies.map((b) => [b.id, !store.isBodyVisible(b.id)]))) },
  ]);
}
const store = engine.store;
const selection = useSelectionStore();
const browser = useBrowserStore();
const root = useTemplateRef<HTMLElement>("root");
const shell = useShellStore();

// The chosen filter is module state in a plain .ts, not a store, so nothing
// tracks it, the same arrangement ui/theme.ts, icons.ts and units.ts use,
// and for the same reason: ui/browserFilter.ts has to stay Vue-free for the
// headless suite.
const filter = ref(getBrowserFilter());
const offFilter = onBrowserFilterChange(() => { filter.value = getBrowserFilter(); });
onUnmounted(offFilter);

function onFilterInput(ev: Event) {
  const id = asBrowserFilter((ev.target as HTMLSelectElement).value);
  if (id) setBrowserFilter(id);
}

// --- the node model ------------------------------------------------------

/** The lists whose eyes paint together: a drag started on a sketch's eye shows
 *  or hides sketches and nothing else. Element and assembly heads are bodies. */
type VisCategory = "bodies" | "sketches" | "planes" | "datums";

/** What a row's eye stands for. `key` is the row within its category, a body or
 *  feature id, or `g:<collapse key>` for a folder head, whose eye stands for
 *  every body in `ids`. */
interface VisTag {
  category: VisCategory;
  key: string;
  ids?: readonly string[];
}

interface FolderNode {
  kind: "folder";
  k: string; // v-for key
  key: string; // collapse key
  label: string;
  icon: string;
  count: number;
  depth: number;
  collapsed: boolean;
  visible?: boolean | undefined;
  vis?: VisTag | undefined;
  eyeDown?: ((e: PointerEvent) => void) | undefined;
  toggleVis?: (() => void) | undefined;
  eyeOver?: (() => void) | undefined;
  /** An element's id: what a programmatic rename aims at, see TreeFolder. */
  id?: string | undefined;
  rename?: ((name: string) => void) | undefined;
  remove?: (() => void) | undefined;
  extraMenu?: CtxItem[] | undefined;
  dragStart?: (() => void) | undefined;
  acceptDrop?: (() => boolean) | undefined;
  dropHere?: (() => void) | undefined;
}
interface RowNode {
  kind: "row";
  k: string;
  depth: number;
  label: string;
  icon: string;
  id?: string | undefined;
  swatch?: string | undefined;
  dim?: boolean | undefined;
  selected?: boolean | undefined;
  error?: boolean | undefined;
  visible?: boolean | undefined;
  vis?: VisTag | undefined;
  eyeDown?: ((e: PointerEvent) => void) | undefined;
  toggleVis?: (() => void) | undefined;
  eyeOver?: (() => void) | undefined;
  title?: string | undefined;
  activate?: ((e: MouseEvent) => void) | undefined;
  edit?: (() => void) | undefined;
  rename?: ((name: string) => void) | undefined;
  remove?: (() => void) | undefined;
  extraMenu?: CtxItem[] | undefined;
  dragStart?: (() => void) | undefined;
  acceptDrop?: (() => boolean) | undefined;
  dropHere?: (() => void) | undefined;
}
interface EmptyNode { kind: "empty"; k: string; text: string }
/** A section some plugin contributed, drawn as its own component. The panel
 *  places it and knows nothing else about it. */
interface PluginNode { kind: "plugin"; k: string; component: Component }
type TreeNode = FolderNode | RowNode | EmptyNode | PluginNode;

// --- engine callbacks (was app/browserWiring.ts) -------------------------
// The panel reads live engine state directly rather than being handed props,
// which is why several of these consult the viewport or a tool.

function sketchOnPlane(plane: Plane3) {
  const t = engine.tools;
  if (engine.sketch.active || t.extrude.active || t.edgeFeature.active || t.pressPull.active || t.loft.active || t.planeOffset.active) return;
  // Answering "select a plane" from the Browser instead of the viewport: end the
  // interactive pick, or its planePick flag stays set and toolBusy() is true
  // forever, silently disabling every tool from here on with no error at all.
  engine.starters.cancelPlanePick();
  engine.sketch.enter(plane, store);
}

// --- showing and hiding ----------------------------------------------------
//
// Every eye in the panel goes through setVisibility, one write per gesture
// step, whether that step is a click, a stretch of a paint drag or a solo. The
// three kinds of thing are shown and hidden three different ways underneath,
// which is exactly why they meet here and nowhere else.

/** Set each row of `category` in `changes`, as ONE write. */
function setVisibility(category: string, changes: ReadonlyMap<string, boolean>) {
  if (!changes.size) return;
  if (category === "bodies") {
    // A folder head's key stands for every body under it. One batched store call
    // however many bodies: each call re-renders the whole model (setModel plus
    // the flush-seam pass), so a per-body loop would repaint it once per body.
    // Visibility, names and colours re-emit the build, so buildVersion carries
    // the refresh.
    const vis = new Map<string, boolean>();
    for (const [key, v] of changes) {
      for (const id of visIndex.value.ids.get(key) ?? [key]) vis.set(id, v);
    }
    store.setBodiesVisibility(vis);
    return;
  }
  if (category === "sketches") {
    for (const [id, v] of changes) store.setSketchVisibility(id, v);
    if (!engine.sketch.active) engine.overlay.update(store.document);
  } else {
    for (const [id, v] of changes) store.setPlaneVisibility(id, v);
    engine.syncDatumPlanes();
  }
  browser.bumpView(); // sketch and plane overrides are display-only: the store emits nothing
}

/** Every row of a category with its current state, drawn or not: a body inside a
 *  collapsed folder is still one of the bodies "show only this" hides. */
function visRows(category: VisCategory): Map<string, boolean> {
  const doc = store.document;
  if (category === "bodies") return new Map(bodyList().map((b) => [b.id, store.isBodyVisible(b.id)]));
  if (category === "sketches") {
    return new Map(featuresOf(doc.features, "sketch").map((f) => [f.id, engine.isSketchVisible(f.id)]));
  }
  const kinds = category === "planes" ? ["datumPlane"] : ["datumPoint", "datumAxis"];
  return new Map(doc.features.filter((f) => kinds.includes(f.type)).map((f) => [f.id, store.isPlaneVisible(f.id)]));
}

function showOnly(category: VisCategory, keys: readonly string[]) {
  const changes = new Map([...visRows(category).keys()].map((k) => [k, false]));
  for (const k of keys) changes.set(k, true);
  setVisibility(category, changes);
}

const paint = new VisibilityPaint(setVisibility);

function endPaint() {
  paint.end();
  browser.painting = false;
  window.removeEventListener("pointerup", endPaint);
  window.removeEventListener("pointercancel", endPaint);
  window.removeEventListener("blur", endPaint);
}
onUnmounted(endPaint);

/** A press on an eye: show or hide that row and start painting, or with Alt
 *  show only that row (and put the rest back on a second Alt-click). */
function eyeDown(tag: VisTag, visible: boolean, e: PointerEvent) {
  if (e.altKey) {
    paint.toggleSolo(tag.category, tag.key, visRows(tag.category));
    return;
  }
  paint.begin(tag.category, tag.key, visible);
  browser.painting = true;
  // On the window, not the row: the button usually comes up over some other row,
  // or outside the panel entirely, and the drag has to end wherever it does.
  window.addEventListener("pointerup", endPaint);
  window.addEventListener("pointercancel", endPaint);
  window.addEventListener("blur", endPaint);
}

function eyeOver(tag: VisTag) {
  if (paint.active) paint.over(tag.category, tag.key, visIndex.value.order.get(tag.category) ?? []);
}

/** The eye fields of a node that shows or hides as `tag`. */
function eye(tag: VisTag, visible: boolean) {
  return {
    vis: tag,
    visible,
    eyeDown: (e: PointerEvent) => eyeDown(tag, visible, e),
    eyeOver: () => eyeOver(tag),
    // A click that no pointer pressed: the keyboard, a screen reader, a script.
    // It shows or hides the one row, as a press would, and paints nothing.
    toggleVis: () => { paint.begin(tag.category, tag.key, visible); paint.end(); },
  };
}

/** The Visibility submenu for `keys`, the same for every list: show or hide the
 *  lot when there are several, show only them, or bring the whole list back. */
function visibilityMenu(category: VisCategory, keys: readonly string[], plural: string): CtxItem {
  const n = keys.length;
  const children: CtxItem[] = [];
  if (n > 1) {
    children.push({ label: `Show these ${n}`, onClick: () => setVisibility(category, new Map(keys.map((k) => [k, true]))) });
    children.push({ label: `Hide these ${n}`, onClick: () => setVisibility(category, new Map(keys.map((k) => [k, false]))) });
  }
  children.push({ label: n > 1 ? `Show only these ${n}` : "Show only this", onClick: () => showOnly(category, keys) });
  children.push({
    label: `Show all ${plural}`,
    onClick: () => setVisibility(category, new Map([...visRows(category).keys()].map((k) => [k, true]))),
  });
  return { label: "Visibility", children };
}

// --- selecting -------------------------------------------------------------

/** Click, Ctrl-click or Shift-click a body row. The run is over the body rows as
 *  drawn; the selection itself goes to the viewport, which owns it. */
function selectBody(id: string, e: MouseEvent) {
  const order = (visIndex.value.order.get("bodies") ?? []).filter((k) => !k.startsWith("g:"));
  const next = selectRow(
    { keys: engine.viewport.getSelectedBodies(), anchor: browser.bodyAnchor }, order, id, modsOf(e),
  );
  browser.bodyAnchor = next.anchor;
  engine.viewport.setSelectedBodies([...next.keys]); // fires back into browser.selectedBodyIds
}

/** Click, Ctrl-click or Shift-click a sketch row. The one feature the timeline
 *  and inspector follow is the row just clicked while it is still selected; a
 *  Ctrl-click that takes the current one out hands that role to another. */
function selectSketch(id: string, e: MouseEvent) {
  const order = featuresOf(store.document.features, "sketch").map((f) => f.id);
  const next = selectRow(browser.sketchSelection, order, id, modsOf(e));
  browser.sketchSelection = next;
  if (next.keys.includes(id)) engine.selectFeature(id);
  else if (selection.featureId === id) engine.selectFeature(next.keys.at(-1) ?? null);
}

// A feature picked anywhere else (the timeline, the viewport) replaces the
// Browser's sketch selection, unless it is one of the sketches already in it,
// which is what the line above does to itself.
watch(
  () => selection.featureId,
  (id) => {
    if (id !== null && browser.sketchSelection.keys.includes(id)) return;
    const isSketch = id !== null && store.document.features.some((f) => f.id === id && f.type === "sketch");
    browser.sketchSelection = isSketch ? { keys: [id], anchor: id } : EMPTY_SELECTION;
  },
);

// --- shaping -------------------------------------------------------------

/** The per-body list the panel renders: the rebuild's own bodies, or a single
 *  implicit body when the backend sent no body metadata but a solid exists. */
function bodyList(): { id: string; name: string; nodeRef?: string }[] {
  const result = store.buildState.result;
  if (result?.bodies?.length) {
    return result.bodies.map((b) => ({
      id: b.id, name: b.name,
      ...(b.nodeRef !== undefined ? { nodeRef: b.nodeRef } : {}),
    }));
  }
  return (result?.mesh.positions.length ?? 0) > 0 ? [{ id: "body1", name: "Body1" }] : [];
}

/** featureId → the assembly manifest an import feature carries. */
function importTrees(doc: CadDocument): Map<string, { name: string; parent: number | null }[]> {
  const trees = new Map<string, { name: string; parent: number | null }[]>();
  for (const f of doc.features) {
    const nodes = (f as { nodes?: { name: string; parent: number | null }[] }).nodes;
    if (f.type === "import" && nodes) trees.set(f.id, nodes);
  }
  return trees;
}

/** The whole body tree: the user's elements over whatever structure the imports
 *  brought with them. Elements live in the store rather than in the document
 *  object useDocValue hands out (they are a display overlay, like body names),
 *  so they are read fresh here and their setters re-emit the build. */
function bodyTree(doc: CadDocument) {
  return buildBodyTree(bodyList(), importTrees(doc), store.bodyElements, store.bodyElementMap());
}

/** body id → the folder keys enclosing it, so a programmatic rename can open the
 *  whole chain before the row is looked for. Read only when a rename is
 *  requested, so the second shaping pass costs nothing in the ordinary case. */
const bodyAncestors = useDocValue((doc) => {
  engine.bridge.buildVersion.value;
  return bodyTree(doc).ancestors;
});

// --- elements: filing bodies into folders ---------------------------------

/** The bodies one gesture acts on: the whole selection when the row that was
 *  grabbed is part of it, otherwise just that row.
 *
 *  The rule every file manager uses, and the one that makes this usable at all:
 *  organising an import means moving hundreds of parts, and a menu that silently
 *  acted on one of a selection of two hundred would be worse than no menu. */
function actOn(bodyId: string): string[] {
  return actOnSelection(browser.selectedBodyIds, bodyId);
}

/** Put `ids` in a brand new element and start naming it. The element is made
 *  first and the bodies moved into it second, two writes, because both are
 *  display overlays and neither is undoable, so there is nothing to be atomic
 *  about. */
function fileIntoNewElement(ids: readonly string[], parent: string | null = null) {
  const id = store.addElement(undefined, parent);
  if (ids.length) store.setBodiesElement(ids, id);
  browser.expand("f:Bodies");
  for (const key of ancestryOf(store.bodyElements, id)) browser.expand(`e:${key}`);
  browser.beginRename(id);
}

/** The "Move to" submenu for a set of bodies. */
function moveBodiesMenu(ids: readonly string[], from: string | undefined): CtxItem {
  return elementMoveMenu(store.bodyElements, ids, from, {
    toNew: () => fileIntoNewElement(ids),
    to: (element) => store.setBodiesElement(ids, element),
  });
}

/** The "Move to element" submenu for an element itself (reparenting a folder).
 *  Its own subtree is left out: a folder cannot go inside itself, and offering
 *  the move only to refuse it is a menu that lies. */
function moveElementMenu(id: string): CtxItem {
  const inside = store.elementSubtree(id);
  const rows: CtxItem[] = [
    {
      label: "Top level",
      disabled: store.bodyElements.find((e) => e.id === id)?.parent === undefined,
      onClick: () => store.setElementParent(id, null),
    },
  ];
  for (const e of store.bodyElements) {
    if (inside.has(e.id)) continue;
    rows.push({
      label: elementPath(store.bodyElements, e.id),
      onClick: () => store.setElementParent(id, e.id),
    });
  }
  return { label: "Move to", children: rows };
}

/** Drop the dragged bodies onto ANOTHER body to group them. If the target is
 *  already in an element, the dragged bodies join it; otherwise a fresh element
 *  is made holding the target and the dragged bodies together. This is the
 *  "parent one thing under another" gesture people reach for before they find
 *  the Move-to-element menu, so it does the sensible thing rather than nothing. */
function dropOntoBody(targetId: string) {
  const d = browser.drag;
  browser.endDrag();
  if (!d || d.kind !== "bodies") return;
  const ids = d.ids.filter((id) => id !== targetId);
  if (!ids.length) return;
  const el = store.bodyElementOf(targetId);
  if (el) store.setBodiesElement(ids, el);
  else fileIntoNewElement([targetId, ...ids]);
}

/** Would dropping the in-flight drag onto this body do anything? Only a body
 *  drag that is not just the target itself. */
function canDropOntoBody(targetId: string): boolean {
  const d = browser.drag;
  return !!d && d.kind === "bodies" && d.ids.some((id) => id !== targetId);
}

/** Take the in-flight drag into `element` (null = the top level). Both drop
 *  kinds land here so the two targets, a folder head and the Bodies head,
 *  cannot drift apart. */
function dropInto(element: string | null) {
  const d = browser.drag;
  browser.endDrag();
  if (!d) return;
  if (d.kind === "bodies") store.setBodiesElement(d.ids, element);
  else store.setElementParent(d.id, element);
}

/** Would that drop do anything? A folder onto itself or into its own subtree is
 *  refused here rather than on the drop, so the row never lights up as a target
 *  it is going to reject. */
function canDropInto(element: string | null): boolean {
  const d = browser.drag;
  if (!d) return false;
  if (d.kind === "bodies") return true;
  return element === null ? true : !store.elementSubtree(d.id).has(element);
}

/** The sections the running plugins add, mirrored into a ref so the node list
 *  re-runs when one starts or stops. The registry is deliberately Vue-free (that
 *  is what lets the headless suite import it), so nothing tracks it without
 *  this. */
const sections = shallowRef(contributedBrowserSections());
const stopContrib = onContribChange(() => { sections.value = contributedBrowserSections(); });
onUnmounted(stopContrib);

/** The whole panel, as a flat list.
 *
 *  Reads docVersion (through useDocValue), buildVersion and the view tick
 *  FIRST and unconditionally, see app/useDoc.ts for why every derived computed
 *  has to do that in its own body rather than lean on an intermediate. */
const nodes = useDocValue((doc): TreeNode[] => {
  engine.bridge.buildVersion.value; // bodies, body names, body colours
  browser.viewTick; // sketch + plane visibility, which the store does not emit

  // A hidden section is not BUILT, not built-then-dropped: under "Sketches" the
  // body list, the assembly walk and the palette are all work with no output.
  const show = (s: BrowserSection) => sectionVisible(filter.value, s);

  const errId = store.buildState.errorFeatureId;
  const bodies = bodyList();
  const sketches = featuresOf(doc.features, "sketch");
  const datums = featuresOf(doc.features, "datumPlane");
  const selectedIds = new Set(browser.selectedBodyIds);
  const out: TreeNode[] = [];
  // Whether anything claims this document's bodies have colours. The swatch on a
  // body row is drawn only when something does; see bodyRow below.
  const paintedBodies = contributedPalette().length > 0;

  /** A collapsible section head plus its rows, or an empty state. Returns
   *  nothing, everything is appended to `out` in document order. */
  const folder = (name: string, icon: string, rows: RowNode[]) => {
    const key = `f:${name}`;
    const collapsed = browser.isCollapsed(key);
    out.push({ kind: "folder", k: key, key, label: name, icon, count: rows.length, depth: 0, collapsed });
    if (collapsed) return;
    if (!rows.length) {
      out.push({ kind: "empty", k: `${key}:empty`, text: `No ${name.toLowerCase()} yet` });
      return;
    }
    out.push(...rows);
  };

  // --- Origin ---
  if (show("origin")) folder("Origin", "origin", (["XY", "XZ", "YZ"] as Plane3[]).map((p) => ({
    kind: "row" as const,
    k: `o:${p}`,
    depth: 0,
    label: `${p} plane`,
    icon: "plane",
    dim: true,
    activate: () => sketchOnPlane(p),
    title: `Start a sketch on the ${p} plane`,
  })));

  // --- Construction / datum planes (only when present) ---
  if (datums.length && show("planes")) {
    folder("Planes", "plane", datums.map((f, i) => ({
      kind: "row" as const,
      k: `p:${f.id}`,
      depth: 0,
      label: f.name || `Plane${i + 1}`,
      icon: "plane",
      selected: selection.featureId === f.id,
      error: errId === f.id,
      ...eye({ category: "planes", key: f.id }, store.isPlaneVisible(f.id)),
      activate: () => engine.selectFeature(f.id),
      extraMenu: [
        { label: "Cut all bodies", onClick: () => void engine.starters.startCutByPlane(f.id) },
        visibilityMenu("planes", [f.id], "planes"),
      ],
      rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
      remove: () => store.removeFeature(f.id),
      title: "Construction plane, select then Split Body cuts by it · right-click for Cut / Rename / Delete · eye to show/hide",
    })));
  }

  // --- Datum points and axes (only when present) ---
  // Reference geometry that builds no body, so it sits with the planes rather
  // than among the bodies, under the same "planes" filter section. Each row
  // carries its own mark (a point or an axis) so the two kinds read apart.
  const refGeom = doc.features.filter(
    (f): f is Extract<Feature, { type: "datumPoint" | "datumAxis" }> =>
      f.type === "datumPoint" || f.type === "datumAxis",
  );
  if (refGeom.length && show("planes")) {
    folder("Datums", "datumPoint", refGeom.map((f, i) => ({
      kind: "row" as const,
      k: `d:${f.id}`,
      depth: 0,
      label: f.name || (f.type === "datumAxis" ? `Axis${i + 1}` : `Point${i + 1}`),
      icon: f.type === "datumAxis" ? "datumAxis" : "datumPoint",
      selected: selection.featureId === f.id,
      error: errId === f.id,
      ...eye({ category: "datums", key: f.id }, store.isPlaneVisible(f.id)),
      activate: () => engine.selectFeature(f.id),
      extraMenu: [visibilityMenu("datums", [f.id], "datums")],
      rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
      remove: () => store.removeFeature(f.id),
      title: "Reference geometry · select to use as a mate or measure reference · right-click to Rename / Delete · eye to show/hide",
    })));
  }

  // --- what the plugins add, between the document's structure and its bodies ---
  //
  // Here rather than at the end, because the one section that exists is about
  // the bodies below it and read best above them. A section names one of the
  // panel's own filter sections to be hidden with, or none, in which case it is
  // always shown: this file cannot decide for it, and the alternative, a
  // section that vanishes under a narrow filter nobody told it about, is worse
  // than one that stays.
  for (const { key, section } of sections.value) {
    if (section.filter && isBrowserSection(section.filter) && !show(section.filter)) continue;
    out.push({ kind: "plugin", k: `x:${key}`, component: section.component });
  }

  const bodyRow = (b: BodyRef, depth: number): RowNode => {
    // The swatch is the slot assignment made visible. Drawn only while
    // something is contributing a colour menu for a body, because that is the
    // same capability that decides a body HAS a colour: a chip with no way to
    // change it, on a document whose palette is not shown anywhere, is a colour
    // nobody chose and nobody can undo. The assignment stays in the document
    // either way.
    const slot = paintedBodies ? store.bodyColorSlot(b.id) : undefined;
    // The palette slot wins the chip when there is one, for the same reason it
    // wins on the model: a slot is a deliberate choice about a real print and a
    // material is usually whatever the imported file said. With no slot the
    // chip is the material, so a row says what the body is made of.
    const chip = (slot != null ? store.colorPalette[slot]?.color : undefined)
      ?? store.bodyMaterialOf(b.id)?.color;
    return {
      kind: "row",
      k: `b:${b.id}`,
      id: b.id,
      depth,
      label: store.bodyName(b.id) ?? b.name,
      icon: "body",
      ...(chip ? { swatch: chip } : {}),
      selected: selectedIds.has(b.id),
      ...eye({ category: "bodies", key: b.id }, store.isBodyVisible(b.id)),
      activate: (e: MouseEvent) => selectBody(b.id, e),
      extraMenu: [
        moveBodiesMenu(actOn(b.id), store.bodyElementOf(b.id)),
        materialMenu(store.materialLibrary, actOn(b.id), store.bodyMaterialId(b.id),
          (m) => store.setBodiesMaterial(actOn(b.id), m)),
        visibilityMenu("bodies", actOn(b.id), "bodies"),
        ...bodyExtraMenu(b.id),
      ],
      dragStart: () => browser.startDrag({ kind: "bodies", ids: actOn(b.id) }),
      acceptDrop: () => canDropOntoBody(b.id),
      dropHere: () => dropOntoBody(b.id),
      rename: (name: string) => store.setBodyName(b.id, name),
      remove: () => store.removeBody(b.id),
      title: "Click to select (Ctrl+click adds, Shift+click takes a run) · drag onto another body to group them, or into an element · double-click to rename · right-click for Move / Material / Visibility / Rename / Delete · drag across eyes to show or hide many",
    };
  };

  /** One folder of the body tree and everything under it.
   *
   *  An ASSEMBLY node that owns exactly one body and no children is emitted as
   *  that body's ROW, not as a folder wrapping a single entry: the body already
   *  carries the product's name, so a folder there would just say everything
   *  twice. An ELEMENT is never collapsed away like that, however little it
   *  holds, because it is a folder the user made on purpose and one that
   *  disappeared when it got down to one part could not be filled again. */
  const groupNode = (g: TreeGroup, depth: number) => {
    if (g.kind === "assembly" && g.children.length === 0 && g.bodies.length === 1) {
      out.push(bodyRow(g.bodies[0]!, depth));
      return;
    }
    const ids = collectGroupBodyIds(g);
    const anyVisible = ids.some((id) => store.isBodyVisible(id));
    const collapsed = browser.isCollapsed(g.key);
    const element = g.kind === "element" ? g.id! : null;
    out.push({
      kind: "folder", k: g.key, key: g.key, label: g.label,
      icon: g.kind === "element" ? "element" : "assembly",
      count: g.total, depth, collapsed,
      // The head's eye stands for every body under it, see setVisibility.
      ...eye({ category: "bodies", key: `g:${g.key}`, ids }, anyVisible),
      // Everything below is an element's, and absent on an assembly node, which
      // is a fact about a file: it cannot be renamed, deleted or dropped into,
      // and TreeFolder renders no menu at all when given none of them.
      ...(element
        ? {
            id: element,
            rename: (name: string) => store.renameElement(element, name),
            remove: () => store.removeElement(element),
            extraMenu: [
              { label: "New element inside", onClick: () => fileIntoNewElement([], element) },
              ...(ids.length ? [moveBodiesMenu(ids, element)] : []),
              moveElementMenu(element),
              { separator: true, label: "" },
            ],
            dragStart: () => browser.startDrag({ kind: "element", id: element }),
            acceptDrop: () => canDropInto(element),
            dropHere: () => dropInto(element),
          }
        : {}),
    });
    if (collapsed) return;
    for (const c of g.children) groupNode(c, depth + 1);
    for (const b of g.bodies) out.push(bodyRow(b, depth + 1));
  };

  if (show("bodies")) {
    const tree = bodyTree(doc);
    const collapsed = browser.isCollapsed("f:Bodies");
    out.push({
      kind: "folder", k: "f:Bodies", key: "f:Bodies", label: "Bodies", icon: "body",
      count: bodies.length, depth: 0, collapsed,
      extraMenu: [{ label: "New element", onClick: () => fileIntoNewElement([]) }],
      // The head is also the way OUT of a folder: dropping onto "Bodies" is what
      // orphans a body again, and without it a part filed by mistake could be
      // moved between folders but never back to the top level by dragging.
      acceptDrop: () => canDropInto(null),
      dropHere: () => dropInto(null),
    });
    if (!collapsed) {
      if (!tree.groups.length && !tree.loose.length) {
        out.push({ kind: "empty", k: "f:Bodies:empty", text: "No bodies yet" });
      }
      for (const n of tree.groups) groupNode(n, 0);
      for (const b of tree.loose) out.push(bodyRow(b, 0));
    }
  }

  // --- Joints (only when present) ---
  // How the bodies are held together. Listed with the bodies because a joint is
  // about them, and selecting one raises its offset/angle handles on the mate
  // axis, the same as editing it from the timeline.
  const joints = doc.features.filter(
    (f): f is Extract<Feature, { type: "joint" }> => f.type === "joint",
  );
  if (joints.length && show("bodies")) {
    const nameOf = (id: string | undefined) => bodies.find((b) => b.id === id)?.name ?? id ?? "?";
    folder("Joints", "assembly", joints.map((f, i) => ({
      kind: "row" as const,
      k: `j:${f.id}`,
      depth: 0,
      label: f.name || `${nameOf(f.moving)} → ${nameOf(f.to?.body)}`,
      icon: "assembly",
      selected: selection.featureId === f.id,
      error: errId === f.id,
      activate: () => engine.selectFeature(f.id),
      edit: () => engine.editFeature(f.id),
      rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
      remove: () => store.removeFeature(f.id),
      title: `Joint ${i + 1} · select or double-click to adjust its offset/angle handles · right-click to Rename / Delete`,
    })));
  }

  // --- Sketches ---
  const pickedSketches = browser.sketchSelection.keys;
  if (show("sketches")) folder("Sketches", "sketch", sketches.map((f, i) => ({
    kind: "row" as const,
    k: `s:${f.id}`,
    depth: 0,
    label: f.name || `Sketch${i + 1}`,
    icon: "sketch",
    selected: pickedSketches.includes(f.id) || selection.featureId === f.id,
    error: errId === f.id,
    ...eye({ category: "sketches", key: f.id }, engine.isSketchVisible(f.id)),
    activate: (e: MouseEvent) => selectSketch(f.id, e),
    edit: () => engine.editFeature(f.id),
    extraMenu: [visibilityMenu("sketches", actOnSelection(pickedSketches, f.id), "sketches")],
    rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
    remove: () => store.removeFeature(f.id),
    title: "Click to select (Ctrl+click adds, Shift+click takes a run) · double-click to edit · right-click for Visibility / Edit / Rename / Delete · drag across eyes to show or hide many",
  })));

  return out;
});

/** Each category's eyes in the order they are drawn, which is what a paint drag
 *  fills across and a Shift-click measures a run over, plus the bodies behind
 *  each folder head's key. Derived from the node list itself so it can never
 *  disagree with what is on screen. */
const visIndex = computed(() => {
  const order = new Map<VisCategory, string[]>();
  const ids = new Map<string, readonly string[]>();
  for (const n of nodes.value) {
    if ((n.kind !== "row" && n.kind !== "folder") || !n.vis) continue;
    let list = order.get(n.vis.category);
    if (!list) order.set(n.vis.category, (list = []));
    list.push(n.vis.key);
    if (n.vis.ids) ids.set(n.vis.key, n.vis.ids);
  }
  return { order, ids };
});

// "Rename…" on the viewport's body menu: open the Bodies folder and every
// enclosing assembly node so the row is on screen, then let the row that owns
// the id start its own edit (TreeRow watches the same field).
watch(
  () => browser.pendingRenameId,
  (id) => {
    if (!id) return;
    browser.expand("f:Bodies");
    for (const key of bodyAncestors.value.get(id) ?? []) browser.expand(key);
  },
);

// --- lifecycle -----------------------------------------------------------

// WebKitGTK quirk, carried over verbatim from mountUi's `for (const id of
// ["browser", "inspector"])` loop: wheel events over an overflow panel don't
// reliably reach the native scroller (GTK kinetic scrolling eats them, fine in
// Chromium, dead in the webview), so drive the scroll explicitly, deltaMode-
// normalized like the viewport's zoom wheel.
//
// Attached by hand rather than with @wheel because it MUST be non-passive:
// preventDefault is the whole point, and a passive listener would silently
// no-op it. (The Parameters panel this was written alongside carried the twin
// of it; the browser is the only docked scroller left.)
function onWheel(ev: WheelEvent) {
  const el = root.value;
  if (!el || el.scrollHeight <= el.clientHeight) return;
  const step = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 100 : 1;
  el.scrollTop += ev.deltaY * step;
  ev.preventDefault();
}
onMounted(() => root.value?.addEventListener("wheel", onWheel, { passive: false }));
onUnmounted(() => root.value?.removeEventListener("wheel", onWheel));
</script>

<template>
  <aside id="browser" class="float-card">
    <div class="float-card-head">
      <span class="float-card-title">Items</span>
      <button class="float-card-close" title="Hide the items (Ctrl Alt S)" @click="shell.setItems(false)"><Icon name="close" :size="14" /></button>
    </div>
    <div class="browser-title">
      <select
        id="browser-filter"
        class="browser-filter"
        title="Show only one kind of item"
        :value="filter"
        @change="onFilterInput"
      >
        <option v-for="f in BROWSER_FILTERS" :key="f.id" :value="f.id">{{ f.label }}</option>
      </select>
    </div>
    <div ref="root" class="float-card-body">
    <template v-for="n in nodes" :key="n.k">
      <TreeFolder
        v-if="n.kind === 'folder'"
        :label="n.label"
        :icon="n.icon"
        :count="n.count"
        :depth="n.depth"
        :collapsed="n.collapsed"
        :visible="n.visible"
        :eye-down="n.eyeDown"
        :toggle-vis="n.toggleVis"
        :eye-over="n.eyeOver"
        :id="n.id"
        :rename="n.rename"
        :remove="n.remove"
        :extra-menu="n.extraMenu"
        :drag-start="n.dragStart"
        :accept-drop="n.acceptDrop"
        :drop-here="n.dropHere"
        @toggle="browser.toggle(n.key)"
      />
      <TreeRow
        v-else-if="n.kind === 'row'"
        :label="n.label"
        :icon="n.icon"
        :depth="n.depth"
        :id="n.id"
        :swatch="n.swatch"
        :dim="n.dim"
        :selected="n.selected"
        :error="n.error"
        :visible="n.visible"
        :title="n.title"
        :activate="n.activate"
        :eye-down="n.eyeDown"
        :toggle-vis="n.toggleVis"
        :eye-over="n.eyeOver"
        :edit="n.edit"
        :rename="n.rename"
        :remove="n.remove"
        :extra-menu="n.extraMenu"
        :drag-start="n.dragStart"
        :accept-drop="n.acceptDrop"
        :drop-here="n.dropHere"
      />
      <div v-else-if="n.kind === 'empty'" class="empty-state tree-child">{{ n.text }}</div>

      <!-- A section some plugin added. It draws its own rows, decides its own
           visibility and is unmounted when its capability stops. -->
      <component :is="n.component" v-else />
    </template>
    </div>
    <div class="float-card-foot">
      <span class="float-card-spacer"></span>
      <button class="float-card-more" title="More" aria-label="More" @click="openMore($event)"><Icon name="more" :size="18" /></button>
    </div>
  </aside>
</template>
