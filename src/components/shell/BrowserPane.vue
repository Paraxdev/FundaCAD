<script setup lang="ts">
import { fmtKeys } from "../../input/platform";
// A flat list of nodes, not nested components: the stylesheet targets that DOM (`.tree-child` is a padding, not a
// container) and the e2e suite walks it.

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
  bodyExtraMenu,
  buildBodyTree,
  collectGroupBodyIds,
  elementMoveMenu,
  elementPath,
  importColorMenu,
  importTrees,
  materialMenu,
  type BodyRef,
  type TreeGroup,
} from "../../ui/browserTree";
import { adoptImportedColors, exportModel, sketchFlatSource } from "../../io/files";
import { ancestryOf } from "../../document/elements";
import {
  BROWSER_FILTERS,
  asBrowserFilter,
  getBrowserFilter,
  isBrowserSection,
  onBrowserFilterChange,
  sectionVisible,
  setBrowserFilter,
  type BrowserSection,
} from "../../ui/browserFilter";
import type { CtxItem } from "../../ui/menu";
import { actOn as actOnSelection, EMPTY_SELECTION, modsOf, selectGroup, selectRow } from "../../ui/rowSelection";
import { VisibilityPaint } from "../../ui/visibilityPaint";
import { routeTreeClick, treePickWaiting, type TreePick } from "../../ui/treePick";
import { featurePick } from "../../app/featurePick";
import { switchEdit } from "../../app/selection";
import { contributedBrowserSections, contributedPalette, onContribChange } from "../../plugins/contrib";
import type { Component } from "vue";
import { featuresOf } from "../../types";
import type { CadDocument, Feature, Plane3 } from "../../types";
import { bodyLabels } from "../../ui/bodyLabels";

const engine = useEngine();

/** The card's own menu: whole-document visibility verbs. */
function openMore(ev: MouseEvent) {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  const store = engine.store;
  const bodies = store.buildState.result?.bodies ?? [];
  const anyHidden = bodies.some((b) => !store.isBodyVisible(b.id));
  contextMenu(r.left, r.top - 8, [
    {
      label: "Hide Selected Bodies",
      disabled: !engine.viewport.getSelectedBodies().length,
      onClick: () => engine.handleAction("hide-selected"),
    },
    { label: "Show Hidden Bodies", disabled: !anyHidden, onClick: () => engine.handleAction("show-all-bodies") },
    {
      label: "Invert Body Visibility",
      disabled: !bodies.length,
      onClick: () => store.setBodiesVisibility(new Map(bodies.map((b) => [b.id, !store.isBodyVisible(b.id)]))),
    },
  ]);
}
const store = engine.store;
const selection = useSelectionStore();
const browser = useBrowserStore();
const root = useTemplateRef<HTMLElement>("root");
const shell = useShellStore();

// The filter is plain module state (ui/browserFilter.ts stays Vue-free for the headless suite), so it is mirrored here.
const filter = ref(getBrowserFilter());
const offFilter = onBrowserFilterChange(() => {
  filter.value = getBrowserFilter();
});
onUnmounted(offFilter);

function onFilterInput(ev: Event) {
  const id = asBrowserFilter((ev.target as HTMLSelectElement).value);
  if (id) setBrowserFilter(id);
}

/** The lists whose eyes paint together: a drag started on a sketch's eye shows
 *  or hides sketches and nothing else. Element and assembly heads are bodies. */
type VisCategory = "bodies" | "sketches" | "planes" | "datums";

/** What a row's eye stands for. `key` is a body or feature id, or `g:<collapse key>` for a folder head standing for
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
  activate?: ((e: MouseEvent) => void) | undefined;
  selected?: boolean | undefined;
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
interface EmptyNode {
  kind: "empty";
  k: string;
  text: string;
}
/** A section some plugin contributed, drawn as its own component. The panel
 *  places it and knows nothing else about it. */
interface PluginNode {
  kind: "plugin";
  k: string;
  component: Component;
}
type TreeNode = FolderNode | RowNode | EmptyNode | PluginNode;

// The panel reads live engine state directly rather than taking props, so several callbacks consult the viewport or a
// tool.

function sketchOnPlane(plane: Plane3) {
  if (engine.sketch.active) {
    engine.setStatus("Finish this sketch before starting another", "");
    return;
  }
  engine.sketch.enter(plane, store);
}

// A tool waiting for a pick takes the row first.

/** A tool holds the screen but takes no rows (Extrude aiming, a gizmo up, a
 *  plugin's pick). A sketch is left out: the rows keep working inside one. */
function busyHint(): string | null {
  if (!engine.toolOwnsScreen() || engine.sketch.active) return null;
  return "The active tool takes its pick in the view, finish it or press Esc";
}

const treeClick = { busyHint, hint: (text: string) => engine.setStatus(text, "") };

/** The row's own action, unless a waiting tool takes the click or refuses it.
 *  `pick` is a thunk so a datum is resolved where it stands at click time. */
function viaTool(pick: () => TreePick, own: (e: MouseEvent) => void) {
  return (e: MouseEvent) => {
    if (routeTreeClick(pick(), treeClick) === "row") own(e);
  };
}

/** Double-click: a tool waiting for a pick already took the click before it.
 *  Any other open edit is closed and the row's feature edited instead. */
function editRow(id: string) {
  return () => {
    if (treePickWaiting()) return;
    switchEdit(engine, id);
  };
}

// Every eye goes through setVisibility, one write per gesture step: bodies, sketches and planes hide three different
// ways underneath, so they meet only here.

/** Set each row of `category` in `changes`, as ONE write. */
function setVisibility(category: string, changes: ReadonlyMap<string, boolean>) {
  if (!changes.size) return;
  if (category === "bodies") {
    // One batched store call however many bodies, each call re-renders the whole model. Visibility re-emits the build,
    // so buildVersion carries the refresh.
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
    toggleVis: () => {
      paint.begin(tag.category, tag.key, visible);
      paint.end();
    },
  };
}

function exportSketch(id: string, format: "dxf" | "svg") {
  void exportModel(store, engine.geometry, [], sketchFlatSource(store, id), format);
}

/** The Visibility submenu for `keys`, the same for every list: show or hide the
 *  lot when there are several, show only them, or bring the whole list back. */
function visibilityMenu(category: VisCategory, keys: readonly string[], plural: string): CtxItem {
  const n = keys.length;
  const children: CtxItem[] = [];
  if (n > 1) {
    children.push({
      label: `Show these ${n}`,
      onClick: () => setVisibility(category, new Map(keys.map((k) => [k, true]))),
    });
    children.push({
      label: `Hide these ${n}`,
      onClick: () => setVisibility(category, new Map(keys.map((k) => [k, false]))),
    });
  }
  children.push({ label: n > 1 ? `Show only these ${n}` : "Show only this", onClick: () => showOnly(category, keys) });
  children.push({
    label: `Show all ${plural}`,
    onClick: () => setVisibility(category, new Map([...visRows(category).keys()].map((k) => [k, true]))),
  });
  return { label: "Visibility", children };
}

/** Click, Ctrl-click or Shift-click a body row. The run is over the body rows as
 *  drawn; the selection itself goes to the viewport, which owns it. */
function selectBody(id: string, e: MouseEvent) {
  const order = (visIndex.value.order.get("bodies") ?? []).filter((k) => !k.startsWith("g:"));
  const next = selectRow(
    { keys: engine.viewport.getSelectedBodies(), anchor: browser.bodyAnchor },
    order,
    id,
    modsOf(e),
  );
  browser.bodyAnchor = next.anchor;
  engine.viewport.setSelectedBodies([...next.keys]); // fires back into browser.selectedBodyIds
}

/** Click a folder: its bodies and everything nested under it, see selectGroup. */
function selectFolder(ids: readonly string[], e: MouseEvent) {
  const next = selectGroup(engine.viewport.getSelectedBodies(), ids, modsOf(e));
  browser.bodyAnchor = null;
  engine.viewport.setSelectedBodies(next);
}

/** Click, Ctrl-click or Shift-click a sketch row. The timeline and inspector follow the row just clicked, a Ctrl-click
 *  removing it hands that role to another. */
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

/** The per-body list the panel renders: the rebuild's own bodies, or a single
 *  implicit body when the backend sent no body metadata but a solid exists. */
function bodyList(): { id: string; name: string; nodeRef?: string }[] {
  const result = store.buildState.result;
  if (result?.bodies?.length) {
    return result.bodies.map((b) => ({
      id: b.id,
      name: b.name,
      ...(b.nodeRef !== undefined ? { nodeRef: b.nodeRef } : {}),
    }));
  }
  return (result?.mesh.positions.length ?? 0) > 0 ? [{ id: "body1", name: "Body1" }] : [];
}

/** Elements live in the store, not the document useDocValue hands out (a display overlay like body names), so they are
 *  read fresh here and their setters re-emit the build. */
function bodyTree(doc: CadDocument) {
  return buildBodyTree(bodyList(), importTrees(doc), store.bodyElements, store.bodyElementMap());
}

/** body id -> enclosing folder keys, so a programmatic rename can open the chain first. Read only on a rename. */
const bodyAncestors = useDocValue((doc) => {
  engine.bridge.buildVersion.value;
  return bodyTree(doc).ancestors;
});

/** The whole selection when the grabbed row is in it, else just that row, as in every file manager: organising an
 *  import moves hundreds of parts. */
function actOn(bodyId: string): string[] {
  return actOnSelection(browser.selectedBodyIds, bodyId);
}

/** Puts `ids` in a new element and starts naming it. Two writes, both display overlays and not undoable, so nothing
 *  needs to be atomic. */
function fileIntoNewElement(ids: readonly string[], parent: string | null = null) {
  const id = store.addElement(undefined, parent);
  if (ids.length) store.setBodiesElement(ids, id);
  browser.expand("f:Bodies");
  for (const key of ancestryOf(store.bodyElements, id)) browser.expand(`e:${key}`);
  browser.beginRename(id);
}

function moveBodiesMenu(ids: readonly string[], from: string | undefined): CtxItem {
  return elementMoveMenu(store.bodyElements, ids, from, {
    toNew: () => fileIntoNewElement(ids),
    to: (element) => store.setBodiesElement(ids, element),
  });
}

/** The menu on an imported assembly's folder head, keyed "n:<featureId>/<node>". */
function assemblyMenu(key: string): CtxItem[] {
  const slash = key.lastIndexOf("/");
  if (!key.startsWith("n:") || slash < 0) return [];
  const featureId = key.slice(2, slash);
  const feature = store.document.features.find(
    (f): f is Extract<Feature, { type: "import" }> => f.id === featureId && f.type === "import",
  );
  if (!feature) return [];
  return [
    importColorMenu(store.importColorSource(featureId), (source) => {
      store.setImportColorSource(featureId, source);
      void adoptImportedColors(store, featureId, feature);
    }),
  ];
}

/** "Move to element" for an element itself. Its own subtree is left out, offering a move only to refuse it lies. */
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

/** Dropping bodies onto another body groups them: into the target's element if it has one, else a new element holding
 *  both. People reach for this before they find Move to element. */
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

/** Takes the in-flight drag into `element` (null is the top level). Both drop targets land here so they cannot drift
 *  apart. */
function dropInto(element: string | null) {
  const d = browser.drag;
  browser.endDrag();
  if (!d) return;
  if (d.kind === "bodies") store.setBodiesElement(d.ids, element);
  else store.setElementParent(d.id, element);
}

/** Refuses a folder onto itself or its own subtree here, not on the drop, so the row never lights up as a target it
 *  will reject. */
function canDropInto(element: string | null): boolean {
  const d = browser.drag;
  if (!d) return false;
  if (d.kind === "bodies") return true;
  return element === null ? true : !store.elementSubtree(d.id).has(element);
}

/** The plugin sections, mirrored so the node list re-runs when one starts or stops: the registry is Vue-free for the
 *  headless suite. */
const sections = shallowRef(contributedBrowserSections());
const stopContrib = onContribChange(() => {
  sections.value = contributedBrowserSections();
});
onUnmounted(stopContrib);

/** The whole panel as a flat list. Reads docVersion, buildVersion and the view tick first and unconditionally, see
 *  app/useDoc.ts. */
const nodes = useDocValue((doc): TreeNode[] => {
  engine.bridge.buildVersion.value; // bodies, body names, body colours
  browser.viewTick; // sketch + plane visibility, which the store does not emit

  // A hidden section is not BUILT, not built-then-dropped: under "Sketches" the
  // body list, the assembly walk and the palette are all work with no output.
  const show = (s: BrowserSection) => sectionVisible(filter.value, s);

  const errId = store.buildState.heldRefusal ? null : store.buildState.errorFeatureId;
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

  if (show("origin"))
    folder(
      "Origin",
      "origin",
      (["XY", "XZ", "YZ"] as Plane3[]).map((p) => ({
        kind: "row" as const,
        k: `o:${p}`,
        depth: 1,
        label: `${p} plane`,
        icon: "plane",
        dim: true,
        activate: viaTool(
          () => ({ kind: "basePlane", plane: p }),
          () => sketchOnPlane(p),
        ),
        title: `Start a sketch on the ${p} plane`,
      })),
    );

  if (datums.length && show("planes")) {
    folder(
      "Planes",
      "plane",
      datums.map((f, i) => ({
        kind: "row" as const,
        k: `p:${f.id}`,
        depth: 1,
        label: f.name || `Plane${i + 1}`,
        icon: "plane",
        selected: selection.featureId === f.id,
        error: errId === f.id,
        ...eye({ category: "planes", key: f.id }, store.isPlaneVisible(f.id)),
        activate: viaTool(
          () => featurePick(engine, f),
          () => engine.selectFeature(f.id),
        ),
        extraMenu: [
          { label: "Cut all bodies", onClick: () => void engine.starters.startCutByPlane(f.id) },
          visibilityMenu("planes", [f.id], "planes"),
        ],
        rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
        remove: () => store.removeFeature(f.id),
        title:
          "Construction plane, select then Split Body cuts by it · right-click for Cut / Rename / Delete · eye to show/hide",
      })),
    );
  }

  // Datum points and axes build no body, so they sit with the planes under the same filter, each with its own mark.
  const refGeom = doc.features.filter(
    (f): f is Extract<Feature, { type: "datumPoint" | "datumAxis" }> =>
      f.type === "datumPoint" || f.type === "datumAxis",
  );
  if (refGeom.length && show("planes")) {
    folder(
      "Datums",
      "datumPoint",
      refGeom.map((f, i) => ({
        kind: "row" as const,
        k: `d:${f.id}`,
        depth: 1,
        label: f.name || (f.type === "datumAxis" ? `Axis${i + 1}` : `Point${i + 1}`),
        icon: f.type === "datumAxis" ? "datumAxis" : "datumPoint",
        selected: selection.featureId === f.id,
        error: errId === f.id,
        ...eye({ category: "datums", key: f.id }, store.isPlaneVisible(f.id)),
        activate: viaTool(
          () => featurePick(engine, f),
          () => engine.selectFeature(f.id),
        ),
        extraMenu: [visibilityMenu("datums", [f.id], "datums")],
        rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
        remove: () => store.removeFeature(f.id),
        title:
          "Reference geometry · select to use as a mate or measure reference · right-click to Rename / Delete · eye to show/hide",
      })),
    );
  }

  // Plugin sections go between the structure and the bodies, the one that exists is about the bodies. A section with no
  // filter section of its own is always shown, rather than vanishing under a filter nobody told it about.
  for (const { key, section } of sections.value) {
    if (section.filter && isBrowserSection(section.filter) && !show(section.filter)) continue;
    out.push({ kind: "plugin", k: `x:${key}`, component: section.component });
  }

  const scanIds = new Set((store.buildState.result?.bodies ?? []).filter((b) => b.scan).map((b) => b.id));
  const labels = bodyLabels(store.buildState.result?.bodies ?? [], (id) => store.bodyName(id));
  const bodyRow = (b: BodyRef, depth: number): RowNode => {
    // The slot swatch shows only while something contributes a body colour menu, a chip nobody can change is a colour
    // nobody chose. The assignment stays in the document either way.
    const slot = paintedBodies ? store.bodyColorSlot(b.id) : undefined;
    // The palette slot wins for the chip, as on the model: a slot is a deliberate print choice, a material is usually
    // what the import said.
    const chip = (slot != null ? store.colorPalette[slot]?.color : undefined) ?? store.bodyMaterialOf(b.id)?.color;
    return {
      kind: "row",
      k: `b:${b.id}`,
      id: b.id,
      depth,
      label: labels.get(b.id) ?? store.bodyName(b.id) ?? b.name,
      icon: scanIds.has(b.id) ? "scan" : "body",
      ...(chip ? { swatch: chip } : {}),
      selected: selectedIds.has(b.id),
      ...eye({ category: "bodies", key: b.id }, store.isBodyVisible(b.id)),
      activate: viaTool(
        () => ({ kind: "body", id: b.id }),
        (e) => selectBody(b.id, e),
      ),
      extraMenu: [
        moveBodiesMenu(actOn(b.id), store.bodyElementOf(b.id)),
        materialMenu(store.materialLibrary, actOn(b.id), store.bodyMaterialId(b.id), (m) =>
          store.setBodiesMaterial(actOn(b.id), m),
        ),
        visibilityMenu("bodies", actOn(b.id), "bodies"),
        ...bodyExtraMenu(b.id),
      ],
      dragStart: () => browser.startDrag({ kind: "bodies", ids: actOn(b.id) }),
      acceptDrop: () => canDropOntoBody(b.id),
      dropHere: () => dropOntoBody(b.id),
      rename: (name: string) => store.setBodyName(b.id, name),
      remove: () => store.removeBody(b.id),
      title: fmtKeys(
        "Click to select (Ctrl+click adds, Shift+click takes a run) · drag onto another body to group them, or into an element · double-click to rename · right-click for Move / Material / Visibility / Rename / Delete · drag across eyes to show or hide many",
      ),
    };
  };

  /** One folder and everything under it. An assembly node with one body and no children is emitted as that body's
   *  row, but an element never collapses, it is a folder the user made on purpose. */
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
      kind: "folder",
      k: g.key,
      key: g.key,
      label: g.label,
      icon: g.kind === "element" ? "element" : "assembly",
      count: g.total,
      depth,
      collapsed,
      activate: viaTool(
        () => ({ kind: "bodies", ids }),
        (e) => selectFolder(ids, e),
      ),
      selected: ids.length > 0 && ids.every((id) => selectedIds.has(id)),
      // The head's eye stands for every body under it, see setVisibility.
      ...eye({ category: "bodies", key: `g:${g.key}`, ids }, anyVisible),
      // The rest is an element's. An assembly node is a fact about a file, so it gets none of it and TreeFolder draws no
      // menu.
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
        : { extraMenu: assemblyMenu(g.key) }),
    });
    if (collapsed) return;
    for (const c of g.children) groupNode(c, depth + 1);
    for (const b of g.bodies) out.push(bodyRow(b, depth + 1));
  };

  if (show("bodies")) {
    const tree = bodyTree(doc);
    const collapsed = browser.isCollapsed("f:Bodies");
    out.push({
      kind: "folder",
      k: "f:Bodies",
      key: "f:Bodies",
      label: "Bodies",
      icon: "body",
      count: bodies.length,
      depth: 0,
      collapsed,
      extraMenu: [{ label: "New element", onClick: () => fileIntoNewElement([]) }],
      // Dropping onto Bodies is the way out of a folder, or a misfiled part could never return to the top level by drag.
      acceptDrop: () => canDropInto(null),
      dropHere: () => dropInto(null),
    });
    if (!collapsed) {
      if (!tree.groups.length && !tree.loose.length) {
        out.push({ kind: "empty", k: "f:Bodies:empty", text: "No bodies yet" });
      }
      for (const n of tree.groups) groupNode(n, 1);
      for (const b of tree.loose) out.push(bodyRow(b, 1));
    }
  }

  // Joints sit with the bodies they hold together, and selecting one raises its handles on the mate axis.
  const joints = doc.features.filter((f): f is Extract<Feature, { type: "joint" }> => f.type === "joint");
  if (joints.length && show("bodies")) {
    const nameOf = (id: string | undefined) => bodies.find((b) => b.id === id)?.name ?? id ?? "?";
    folder(
      "Joints",
      "assembly",
      joints.map((f, i) => ({
        kind: "row" as const,
        k: `j:${f.id}`,
        depth: 1,
        label: f.name || `${nameOf(f.moving)} → ${nameOf(f.to?.body)}`,
        icon: "assembly",
        selected: selection.featureId === f.id,
        error: errId === f.id,
        activate: viaTool(
          () => ({ kind: "feature", id: f.id }),
          () => engine.selectFeature(f.id),
        ),
        edit: editRow(f.id),
        rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
        remove: () => store.removeFeature(f.id),
        title: `Joint ${i + 1} · select or double-click to adjust its offset/angle handles · right-click to Rename / Delete`,
      })),
    );
  }

  // Mechanisms follow the joints, and double-click raises the drive's handle as from the timeline.
  const mechanisms = doc.features.filter((f): f is Extract<Feature, { type: "mechanism" }> => f.type === "mechanism");
  if (mechanisms.length && show("bodies")) {
    const nameOf = (id: string | undefined) => bodies.find((b) => b.id === id)?.name ?? id ?? "?";
    folder(
      "Mechanisms",
      "mechanism",
      mechanisms.map((f, i) => ({
        kind: "row" as const,
        k: `m:${f.id}`,
        depth: 1,
        label: f.name || `Mechanism ${i + 1}`,
        icon: "mechanism",
        selected: selection.featureId === f.id,
        error: errId === f.id,
        activate: viaTool(
          () => ({ kind: "feature", id: f.id }),
          () => engine.selectFeature(f.id),
        ),
        edit: editRow(f.id),
        rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
        remove: () => store.removeFeature(f.id),
        title: `Mechanism ${i + 1} on ${nameOf(f.ground)} · double-click to drag its drive · right-click to Rename / Delete`,
      })),
    );
  }

  const pickedSketches = browser.sketchSelection.keys;
  if (show("sketches"))
    folder(
      "Sketches",
      "sketch",
      sketches.map((f, i) => ({
        kind: "row" as const,
        k: `s:${f.id}`,
        depth: 1,
        label: f.name || `Sketch${i + 1}`,
        icon: "sketch",
        selected: pickedSketches.includes(f.id) || selection.featureId === f.id,
        error: errId === f.id,
        ...eye({ category: "sketches", key: f.id }, engine.isSketchVisible(f.id)),
        activate: viaTool(
          () => ({ kind: "sketch", id: f.id }),
          (e) => selectSketch(f.id, e),
        ),
        edit: editRow(f.id),
        extraMenu: [
          visibilityMenu("sketches", actOnSelection(pickedSketches, f.id), "sketches"),
          { label: "Export as DXF…", onClick: () => exportSketch(f.id, "dxf") },
          { label: "Export as SVG…", onClick: () => exportSketch(f.id, "svg") },
        ],
        rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
        remove: () => store.removeFeature(f.id),
        title: fmtKeys(
          "Click to select (Ctrl+click adds, Shift+click takes a run) · double-click to edit · right-click for Visibility / Edit / Rename / Delete · drag across eyes to show or hide many",
        ),
      })),
    );

  return out;
});

/** Each category's eyes in drawn order (what a paint drag fills and a Shift-click run measures), plus the bodies behind
 *  each folder head. Derived from the node list so it cannot disagree with the screen. */
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

// WebKitGTK quirk: wheel events over an overflow panel do not reliably reach the native scroller (kinetic scrolling
// eats them), so the scroll is driven here, deltaMode-normalized. Bound by hand because it must be non-passive.
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
      <button class="float-card-close" :title="fmtKeys('Hide the items (Ctrl+Alt+S)')" @click="shell.setItems(false)"
        ><Icon name="close" :size="14"
      /></button>
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
          :data-key="n.key"
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
          :activate="n.activate"
          :selected="n.selected"
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
      <button class="float-card-more" title="More" aria-label="More" @click="openMore($event)"
        ><Icon name="more" :size="18"
      /></button>
    </div>
  </aside>
</template>
