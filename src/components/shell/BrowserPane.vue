<script setup lang="ts">
// Left browser, MCAD-style: object-oriented, collapsible folders rather than a
// flat feature list. Origin (the three base planes — click to start a sketch on
// one), the filament Palette, Bodies (grouped by the imported assembly tree when
// there is one) and Sketches. The chronological operations (extrude/fillet/…)
// live in the bottom Timeline, as in mainstream MCAD.
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

import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { useBuildValue, useDocValue } from "../../app/useDoc";
import { useSelectionStore } from "../../stores/selection";
import { useBrowserStore } from "../../stores/browser";
import Icon from "./Icon.vue";
import InlineLabel from "./InlineLabel.vue";
import TreeFolder from "./TreeFolder.vue";
import TreeRow from "./TreeRow.vue";
import {
  bodyColorMenu, buildAssemblyGroups, collectBodyIds, type AsmGroup,
} from "../../ui/browserTree";
import {
  BROWSER_FILTERS, asBrowserFilter, getBrowserFilter, onBrowserFilterChange,
  sectionVisible, setBrowserFilter, type BrowserSection,
} from "../../ui/browserFilter";
import type { CtxItem } from "../../ui/menu";
import { multiColorEnabled, onFeatureFlagsChange } from "../../ui/featureFlags";
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
interface PaletteHeadNode { kind: "palette-head"; k: string; count: number; collapsed: boolean }
interface PaletteSlotNode {
  kind: "palette-slot";
  k: string;
  index: number;
  name: string;
  color: string;
  material: string;
}
type TreeNode = FolderNode | RowNode | EmptyNode | PaletteHeadNode | PaletteSlotNode;

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

/** Whether a printer answered the last probe. null = never asked, or asked and
 *  the answer has not come back. Declared up here rather than beside the rest of
 *  the palette code below because the node list gates a whole section on it. */
const printerOnline = ref<boolean | null>(null);

/** Multi-material, mirrored into a ref so the node list re-runs when it is
 *  toggled. The module is deliberately Vue-free (that is what lets the headless
 *  suite import it), so nothing tracks it without this. */
const multiColor = ref(multiColorEnabled());
const stopFlags = onFeatureFlagsChange(() => { multiColor.value = multiColorEnabled(); });
onUnmounted(stopFlags);

/** The whole panel, as a flat list.
 *
 *  Reads docVersion (through useDocValue), buildVersion and the view tick
 *  FIRST and unconditionally — see app/useDoc.ts for why every derived computed
 *  has to do that in its own body rather than lean on an intermediate. */
const nodes = useDocValue((doc): TreeNode[] => {
  engine.bridge.buildVersion.value; // bodies, body names/colours, the palette
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

  // --- Palette + Bodies ---
  // The palette is the printer's filament slots, not a document colour scheme:
  // every slot means "the material loaded in toolhead N", and the sync button
  // and staleness dot only mean anything against a machine that answers. With
  // no printer it was four fixed rows of nothing, permanently at the top of the
  // browser, so it waits for one — the same rule the Images filter follows, that
  // a control which cannot do its job is worse present than absent.
  if (bodies.length && show("palette") && multiColor.value && printerOnline.value === true) {
    const collapsed = browser.isCollapsed("Palette");
    out.push({ kind: "palette-head", k: "palette", count: store.colorPalette.length, collapsed });
    if (!collapsed) {
      store.colorPalette.forEach((slot, i) => {
        out.push({
          kind: "palette-slot", k: `pal:${i}`, index: i,
          name: slot.name, color: slot.color, material: slot.material ?? "",
        });
      });
    }
  }

  const bodyRow = (b: { id: string; name: string }, depth: number): RowNode => {
    // The swatch is the slot assignment made visible, so it goes with the rest
    // of the feature. The assignment itself stays in the document either way.
    const slot = multiColor.value ? store.bodyColorSlot(b.id) : undefined;
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
      extraMenu: bodyColorMenu(store, b.id),
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

// --- filament palette ----------------------------------------------------
// Editable colour slots (≤4 → the U1's toolheads). Click a swatch to recolor a
// slot; double-click its name to rename. Bodies are assigned to a slot, so
// editing one recolors everything using it. The header carries a connection dot
// and a "sync from printer" button.

const hasBodies = useBuildValue(() => bodyList().length > 0);

const staleSlots = ref<number[]>([]); // palette slots that differ from the printer

const stale = computed(() => printerOnline.value === true && staleSlots.value.length > 0);
const dotStyle = computed(() => ({
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  background:
    printerOnline.value == null ? "#888"
      : !printerOnline.value ? "#d23b30"
        : stale.value ? "#d2a83b" : "#3ba55d",
  display: "inline-block",
  marginRight: "6px",
}));
const dotTitle = computed(() =>
  stale.value
    ? `Printer filaments changed since sync (slot${staleSlots.value.length > 1 ? "s" : ""} ${staleSlots.value.map((i) => i + 1).join(", ")}), click the sync button to re-sync`
    : "Printer connection",
);

// Passive printer checks, armed ONCE the first time bodies (and so the palette)
// appear: a one-shot probe that lights the dot without a sync click, and a
// single 30s staleness poll that re-diffs the printer's filaments against the
// palette WITHOUT applying anything. Both guarded, because the old version armed
// them from inside render() — where an unguarded re-arm probed the LAN per
// keystroke. The watcher is a transition, so that hazard is structural now, but
// the guards stay: hasBodies flips on every New/Open too.
let probedOnce = false;
let pollTimer: number | null = null;

function armPrinterChecks() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (!probedOnce) {
    probedOnce = true;
    void (async () => {
      try {
        const { activePrinterId, printerProbe } = await import("../../print/printerClient");
        const info = await printerProbe(activePrinterId());
        printerOnline.value = info.online;
      } catch {
        printerOnline.value = false; // passive — no toast
      }
    })();
  }
  if (pollTimer == null) pollTimer = window.setInterval(() => void pollStaleness(), 30_000);
}

async function pollStaleness() {
  if (document.visibilityState !== "visible" || browser.isCollapsed("Palette")) return;
  try {
    const { activePrinterId, printerFilaments } = await import("../../print/printerClient");
    const filaments = await printerFilaments(activePrinterId());
    printerOnline.value = true;
    staleSlots.value = filamentDiffSlots(filaments);
  } catch {
    printerOnline.value = false;
    staleSlots.value = [];
  }
}

/** Slots where the printer's loaded filament differs from the palette — the same
 *  name/color criteria the sync-confirm dialog diffs on. */
function filamentDiffSlots(
  filaments: { index: number; present: boolean; vendor: string; material: string; color: string }[],
): number[] {
  const cur = store.colorPalette;
  const out: number[] = [];
  filaments.forEach((f, i) => {
    if (!f.present || i >= cur.length) return;
    const name = `${f.vendor} ${f.material}`.trim() || `Toolhead ${f.index + 1}`;
    if (cur[i]?.name !== name || cur[i]?.color !== f.color) out.push(i);
  });
  return out;
}

/** Pull the printer's loaded filaments into the palette, 1:1 by toolhead index.
 *  Read-only sync (printer → palette); the printer is the source of truth for
 *  what's physically loaded. Confirms before overwriting a customized palette. */
async function syncFilamentsFromPrinter() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { activePrinterId, printerFilaments, asPrinterError } = await import("../../print/printerClient");
  const { toast } = await import("../../ui/toast");
  let filaments;
  try {
    filaments = await printerFilaments(activePrinterId());
  } catch (e) {
    printerOnline.value = false;
    const pe = asPrinterError(e);
    toast(pe ? `Can't reach the printer: ${pe.message}` : `Printer error: ${String(e)}`, { kind: "error" });
    return;
  }
  printerOnline.value = true;

  // one proposed slot per loaded toolhead; empty toolheads leave the slot alone.
  const proposed = filaments.map((f) =>
    f.present
      ? { name: `${f.vendor} ${f.material}`.trim() || `Toolhead ${f.index + 1}`, color: f.color, material: f.material }
      : undefined,
  );
  if (!proposed.some(Boolean)) {
    toast("No filament loaded on the printer.", { kind: "info" });
    return;
  }

  if (!store.paletteIsDefault()) {
    const { choose } = await import("../../ui/choice");
    const cur = store.colorPalette;
    const diff = proposed
      .map((p, i) => (p && (cur[i]?.name !== p.name || cur[i]?.color !== p.color) ? `Slot ${i + 1}: ${cur[i]?.name ?? "—"} → ${p.name}` : null))
      .filter(Boolean) as string[];
    const go = await choose<"apply" | "cancel">(
      diff.length ? `Overwrite palette from printer?\n${diff.join("\n")}` : "Sync palette from printer?",
      [
        { value: "apply", label: "Overwrite", hint: `${diff.length} slot${diff.length === 1 ? "" : "s"}` },
        { value: "cancel", label: "Cancel" },
      ],
    );
    if (go !== "apply") return;
  }

  store.applyFilamentSync(proposed);
  staleSlots.value = []; // palette now matches the printer by construction
  toast("Palette synced from printer.", { kind: "info" });
}

// --- lifecycle -----------------------------------------------------------

watch(hasBodies, (v) => { if (v) armPrinterChecks(); }, { immediate: true });
onUnmounted(() => { if (pollTimer != null) clearInterval(pollTimer); });

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

      <!-- The palette head keeps its own markup: a connection dot and the sync
           button sit where a folder's eye would, and its label deliberately has
           no .tree-label class (the e2e panel dump reads that). -->
      <div v-else-if="n.kind === 'palette-head'" class="tree-folder" @click="browser.toggle('Palette')">
        <span class="tree-caret"><Icon :name="n.collapsed ? 'caretRight' : 'caretDown'" :size="11" /></span>
        <span class="feature-icon"><Icon name="filament" :size="14" /></span>
        <span>Palette</span>
        <span style="flex: 1"></span>
        <span class="pal-dot" :title="dotTitle" :style="dotStyle"></span>
        <!-- .stop: the button lives in the header but must not also toggle it -->
        <button
          class="pal-sync"
          title="Sync filaments from printer"
          style="background: none; border: none; color: inherit; cursor: pointer; font-size: 13px; padding: 0 4px; margin-right: 6px"
          @click.stop="syncFilamentsFromPrinter()"
        ><Icon name="sync" :size="14" /></button>
        <span class="tree-count">{{ n.count }}</span>
      </div>

      <div
        v-else
        class="feature-row tree-child"
        :title="`Filament slot ${n.index + 1} → toolhead ${n.index + 1}${n.material ? ` (${n.material})` : ''}`"
      >
        <input
          type="color"
          class="pal-swatch"
          style="width: 18px; height: 18px; border: none; background: none; padding: 0; cursor: pointer; vertical-align: middle"
          :value="n.color"
          @change="store.setPaletteSlot(n.index, { color: ($event.target as HTMLInputElement).value })"
        />
        <InlineLabel
          :text="n.name"
          :label-style="{ marginLeft: '7px' }"
          rename-on-dblclick
          :rename="(name: string) => store.setPaletteSlot(n.index, { name })"
        />
        <span
          v-if="n.material"
          class="pal-material"
          style="margin-left: 6px; opacity: 0.55; font-size: 11px"
        >{{ n.material }}</span>
      </div>
    </template>
  </aside>
</template>
