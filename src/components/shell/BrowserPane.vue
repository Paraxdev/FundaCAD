<script setup lang="ts">
// Left browser, MCAD-style: object-oriented, collapsible folders rather than a
// flat feature list. Origin (the three base planes — click to start a sketch on
// one), Bodies (grouped by the imported assembly tree when there is one) and
// Sketches, plus whatever the running plugins add between the two. The
// chronological operations (extrude/fillet/…) live in the bottom Timeline, as in
// mainstream MCAD.
//
// A filament palette used to be a section here, with two node kinds of its own,
// a connection dot, a one-shot printer probe and a thirty-second staleness poll
// — a panel about a machine on the network, inside the panel that lists what is
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

import { onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue } from "../../app/useDoc";
import { useSelectionStore } from "../../stores/selection";
import { useBrowserStore } from "../../stores/browser";
import TreeFolder from "./TreeFolder.vue";
import TreeRow from "./TreeRow.vue";
import {
  bodyExtraMenu, buildAssemblyGroups, collectBodyIds, type AsmGroup,
} from "../../ui/browserTree";
import {
  BROWSER_FILTERS, asBrowserFilter, getBrowserFilter, isBrowserSection,
  onBrowserFilterChange, sectionVisible, setBrowserFilter, type BrowserSection,
} from "../../ui/browserFilter";
import type { CtxItem } from "../../ui/menu";
import { contributedBrowserSections, contributedPalette, onContribChange } from "../../plugins/contrib";
import type { Component } from "vue";
import type { CadDocument, Feature, Plane3 } from "../../types";

const engine = useEngine();
const store = engine.store;
const selection = useSelectionStore();
const browser = useBrowserStore();
const root = useTemplateRef<HTMLElement>("root");

// The chosen filter is module state in a plain .ts, not a store, so nothing
// tracks it — the same arrangement ui/theme.ts, icons.ts and layoutPrefs.ts use,
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
  toggleVis?: (() => void) | undefined;
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
  title?: string | undefined;
  activate?: ((e: MouseEvent) => void) | undefined;
  toggleVis?: (() => void) | undefined;
  edit?: (() => void) | undefined;
  rename?: ((name: string) => void) | undefined;
  remove?: (() => void) | undefined;
  extraMenu?: CtxItem[] | undefined;
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

function toggleSketchVis(id: string) {
  store.setSketchVisibility(id, !engine.isSketchVisible(id));
  if (!engine.sketch.active) engine.overlay.update(store.document);
  browser.bumpView(); // sketch overrides are display-only: the store emits nothing
}

function togglePlaneVis(id: string) {
  store.setPlaneVisibility(id, !store.isPlaneVisible(id));
  engine.syncDatumPlanes();
  browser.bumpView(); // ditto — a plane toggle just re-syncs the quads
}

// Body visibility, names and colours all re-emit the build, so they need no
// explicit refresh: buildVersion carries them.
function toggleBodyVis(id: string) {
  store.setBodyVisibility(id, !store.isBodyVisible(id));
}

function selectBody(id: string, additive: boolean) {
  const cur = new Set(engine.viewport.getSelectedBodies());
  if (additive) cur.has(id) ? cur.delete(id) : cur.add(id);
  else { cur.clear(); cur.add(id); }
  engine.viewport.setSelectedBodies([...cur]); // fires back into browser.selectedBodyIds
}

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

/** body id → the assembly node keys enclosing it, so a programmatic rename can
 *  open the whole chain before the row is looked for. Read only when a rename is
 *  requested, so the second buildAssemblyGroups pass costs nothing in the
 *  ordinary case. */
const bodyAncestors = useDocValue((doc) => {
  engine.bridge.buildVersion.value;
  return buildAssemblyGroups(bodyList(), importTrees(doc))?.ancestors ?? new Map<string, string[]>();
});

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
 *  FIRST and unconditionally — see app/useDoc.ts for why every derived computed
 *  has to do that in its own body rather than lean on an intermediate. */
const nodes = useDocValue((doc): TreeNode[] => {
  engine.bridge.buildVersion.value; // bodies, body names, body colours
  browser.viewTick; // sketch + plane visibility, which the store does not emit

  // A hidden section is not BUILT, not built-then-dropped: under "Sketches" the
  // body list, the assembly walk and the palette are all work with no output.
  const show = (s: BrowserSection) => sectionVisible(filter.value, s);

  const errId = store.buildState.errorFeatureId;
  const bodies = bodyList();
  const sketches = doc.features.filter((f) => f.type === "sketch");
  const datums = doc.features.filter((f) => f.type === "datumPlane");
  const selectedIds = new Set(browser.selectedBodyIds);
  const out: TreeNode[] = [];
  // Whether anything claims this document's bodies have colours. The swatch on a
  // body row is drawn only when something does; see bodyRow below.
  const paintedBodies = contributedPalette().length > 0;

  /** A collapsible section head plus its rows, or an empty state. Returns
   *  nothing — everything is appended to `out` in document order. */
  const folder = (name: string, icon: string, rows: RowNode[]) => {
    const key = `f:${name}`;
    const collapsed = browser.isCollapsed(key);
    out.push({ kind: "folder", k: key, key, label: name, icon, count: rows.length, depth: 0, collapsed });
    if (collapsed) return;
    if (!rows.length) {
      out.push({
        kind: "empty",
        k: `${key}:empty`,
        text: name === "Bodies" ? "No bodies yet" : `No ${name.toLowerCase()} yet`,
      });
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
      visible: store.isPlaneVisible(f.id),
      activate: () => engine.selectFeature(f.id),
      toggleVis: () => togglePlaneVis(f.id),
      extraMenu: [{ label: "Cut all bodies", onClick: () => void engine.starters.startCutByPlane(f.id) }],
      rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
      remove: () => store.removeFeature(f.id),
      title: "Construction plane, select then Split Body cuts by it · right-click for Cut / Rename / Delete · eye to show/hide",
    })));
  }

  // --- what the plugins add, between the document's structure and its bodies ---
  //
  // Here rather than at the end, because the one section that exists is about
  // the bodies below it and read best above them. A section names one of the
  // panel's own filter sections to be hidden with, or none, in which case it is
  // always shown: this file cannot decide for it, and the alternative — a
  // section that vanishes under a narrow filter nobody told it about — is worse
  // than one that stays.
  for (const { key, section } of sections.value) {
    if (section.filter && isBrowserSection(section.filter) && !show(section.filter)) continue;
    out.push({ kind: "plugin", k: `x:${key}`, component: section.component });
  }

  const bodyRow = (b: { id: string; name: string }, depth: number): RowNode => {
    // The swatch is the slot assignment made visible. Drawn only while
    // something is contributing a colour menu for a body, because that is the
    // same capability that decides a body HAS a colour: a chip with no way to
    // change it, on a document whose palette is not shown anywhere, is a colour
    // nobody chose and nobody can undo. The assignment stays in the document
    // either way.
    const slot = paintedBodies ? store.bodyColorSlot(b.id) : undefined;
    const chip = slot != null ? store.colorPalette[slot]?.color : undefined;
    return {
      kind: "row",
      k: `b:${b.id}`,
      id: b.id,
      depth,
      label: store.bodyName(b.id) ?? b.name,
      icon: "body",
      ...(chip ? { swatch: chip } : {}),
      selected: selectedIds.has(b.id),
      visible: store.isBodyVisible(b.id),
      activate: (e: MouseEvent) => selectBody(b.id, e.ctrlKey || e.metaKey),
      toggleVis: () => toggleBodyVis(b.id),
      extraMenu: bodyExtraMenu(b.id),
      rename: (name: string) => store.setBodyName(b.id, name),
      remove: () => store.removeBody(b.id),
      title: "Click to select (Ctrl+click adds) · double-click to rename · right-click for Color / Rename / Delete · eye to show/hide",
    };
  };

  /** One assembly node and everything under it.
   *
   *  A node that owns exactly one body and no children is emitted as that body's
   *  ROW, not as a folder wrapping a single entry — the body already carries the
   *  product's name, so a folder there would just say everything twice. */
  const assemblyNode = (g: AsmGroup, depth: number) => {
    if (g.children.length === 0 && g.bodies.length === 1) {
      out.push(bodyRow(g.bodies[0]!, depth));
      return;
    }
    const ids = collectBodyIds(g);
    const anyVisible = ids.some((id) => store.isBodyVisible(id));
    const collapsed = browser.isCollapsed(g.key);
    out.push({
      kind: "folder", k: g.key, key: g.key, label: g.label, icon: "assembly",
      count: g.total, depth, collapsed, visible: anyVisible,
      // ONE batched write: a per-body loop would re-render the whole model once
      // per body (setModel plus the flush-seam pass each time).
      toggleVis: () => store.setBodiesVisibility(new Map(ids.map((id) => [id, !anyVisible]))),
    });
    if (collapsed) return;
    for (const c of g.children) assemblyNode(c, depth + 1);
    for (const b of g.bodies) out.push(bodyRow(b, depth + 1));
  };

  const groups = show("bodies") ? buildAssemblyGroups(bodies, importTrees(doc)) : null;
  if (!show("bodies")) {
    // nothing: the filter is narrowed to something else
  } else if (!groups) {
    // no imported assembly tree in this document — exactly the flat list as before
    folder("Bodies", "body", bodies.map((b) => bodyRow(b, 0)));
  } else {
    const collapsed = browser.isCollapsed("f:Bodies");
    out.push({
      kind: "folder", k: "f:Bodies", key: "f:Bodies", label: "Bodies", icon: "body",
      count: bodies.length, depth: 0, collapsed,
    });
    if (!collapsed) {
      for (const b of groups.loose) out.push(bodyRow(b, 0));
      for (const n of groups.roots) assemblyNode(n, 0);
    }
  }

  // --- Sketches ---
  if (show("sketches")) folder("Sketches", "sketch", sketches.map((f, i) => ({
    kind: "row" as const,
    k: `s:${f.id}`,
    depth: 0,
    label: f.name || `Sketch${i + 1}`,
    icon: "sketch",
    selected: selection.featureId === f.id,
    error: errId === f.id,
    visible: engine.isSketchVisible(f.id),
    activate: () => engine.selectFeature(f.id),
    edit: () => engine.editFeature(f.id),
    toggleVis: () => toggleSketchVis(f.id),
    rename: (name: string) => store.updateFeature(f.id, { name } as Partial<Feature>),
    remove: () => store.removeFeature(f.id),
    title: "Double-click to edit · right-click for Edit / Rename / Delete · eye to show/hide",
  })));

  return out;
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
// reliably reach the native scroller (GTK kinetic scrolling eats them — fine in
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
  <aside id="browser" ref="root">
    <div class="panel-title browser-title">
      <span>Browser</span>
      <!-- In the title row rather than above it: the panel is 232px and a
           filter on its own line would cost a whole row of tree for a control
           that is usually left on "All items". -->
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
    <template v-for="n in nodes" :key="n.k">
      <TreeFolder
        v-if="n.kind === 'folder'"
        :label="n.label"
        :icon="n.icon"
        :count="n.count"
        :depth="n.depth"
        :collapsed="n.collapsed"
        :visible="n.visible"
        :toggle-vis="n.toggleVis"
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
        :toggle-vis="n.toggleVis"
        :edit="n.edit"
        :rename="n.rename"
        :remove="n.remove"
        :extra-menu="n.extraMenu"
      />
      <div v-else-if="n.kind === 'empty'" class="empty-state tree-child">{{ n.text }}</div>

      <!-- A section some plugin added. It draws its own rows, decides its own
           visibility and is unmounted when its capability stops. -->
      <component :is="n.component" v-else />
    </template>
  </aside>
</template>
