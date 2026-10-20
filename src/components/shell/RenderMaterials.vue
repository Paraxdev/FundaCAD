<script setup lang="ts">
import RenderSections from "./RenderSections.vue";
// The material half of the Render workspace: what this document can be made of,
// what it IS made of, and the editor for one of them.
//
// It replaces a modal dialog, and the change is not cosmetic. A library is
// something you work from with the model in view: you pick a plastic, look at
// the part, decide it is too shiny, and pull the roughness. A dialog covers the
// thing being judged, which meant every adjustment was made against a memory of
// what the part looked like a second ago. Docked beside the viewport, the part
// changes while the slider moves.
//
// Editing is LIVE and there is no OK. Every change here is undoable in the
// ordinary sense (change it back) and none of it is on the undo stack, so a
// buffered copy would only be a second version of the library that the model was
// not wearing.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useBrowserStore } from "../../stores/browser";
import { useBuildValue } from "../../app/useDoc";
import Icon from "./Icon.vue";
import { toast } from "../../ui/toast";
import { exportMaterialLibrary, importMaterialLibrary } from "../../io/files";
import { finishLabel, finishOf, type MaterialDef, type SurfaceSpec } from "../../document/materials";
import { materialPreview, onPreviewsChanged } from "../../viewport/materialPreview";
import { FALLBACK_THICKNESS } from "../../viewport/glassThickness";
import { isRenderLowPower } from "../../viewport/render";
import { beginMaterialDrag, endMaterialDrag, MATERIAL_MIME } from "../../ui/materialDrag";
import { onRenderPrefsChange, renderPrefs } from "../../ui/renderPrefs";
import { emissionProgress, onEmissionProgress } from "../../ui/emissionProgress";
import SurfaceNodeEditor from "./SurfaceNodeEditor.vue";
import { contextMenu, type CtxItem } from "../../ui/menu";
import { choose } from "../../ui/choice";
import { contributedMaterialPresets } from "../../plugins/contrib";
import { modsOf, selectRow } from "../../ui/rowSelection";

const engine = useEngine();
const store = engine.store;
const browser = useBrowserStore();

/** Bumped when the preview renderer has something new to say, which is once:
 *  the reflections arrive a beat after the panel opens (they are a dynamic
 *  import plus a cubemap) and every swatch is worth asking for again. */
const previewTick = ref(0);
const bloomOn = ref(renderPrefs().bloom > 0);
const emitting = ref(emissionProgress());
let offPreview: (() => void) | null = null;
let offPrefs: (() => void) | null = null;
let offEmission: (() => void) | null = null;
onMounted(() => {
  offPreview = onPreviewsChanged(() => { previewTick.value++; });
  offPrefs = onRenderPrefsChange(() => { bloomOn.value = renderPrefs().bloom > 0; });
  offEmission = onEmissionProgress((p) => { emitting.value = p; });
});
onUnmounted(() => { flushNumbers(); offPreview?.(); offPrefs?.(); offEmission?.(); });

function preview(m: MaterialDef): string | null {
  previewTick.value; // dependency: re-ask once the reflections land
  return materialPreview(m);
}

/** The picked materials, as ids and not objects: the store hands back fresh
 *  objects on every edit, and holding one would freeze the editor on the
 *  material as it was before the last keystroke. The editor shows the one
 *  picked when exactly one is. */
const selectedIds = ref<string[]>([]);
const anchorId = ref<string | null>(null);
const selectedSet = computed(() => new Set(selectedIds.value));
const selectedId = computed(() => (selectedIds.value.length === 1 ? selectedIds.value[0]! : null));
const search = ref("");

const library = useBuildValue(() => [...store.materialLibrary]);

/** How many bodies and how many faces wear each material. Two numbers because
 *  they are two different facts: a material on six bodies is the part's plastic,
 *  and one on two faces is a detail somebody dressed. */
const usage = useBuildValue((b) => {
  const out = new Map<string, { bodies: number; faces: number }>();
  const bump = (id: string, k: "bodies" | "faces") => {
    const row = out.get(id) ?? { bodies: 0, faces: 0 };
    row[k]++;
    out.set(id, row);
  };
  for (const body of b.result?.bodies ?? []) {
    const m = store.bodyMaterialId(body.id);
    if (m) bump(m, "bodies");
  }
  for (const [, id] of store.faceMaterialEntries()) bump(id, "faces");
  return out;
});

const matches = (m: MaterialDef) => {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  return `${m.name} ${finishLabel(m)} ${m.color}`.toLowerCase().includes(q);
};

/** The ones actually on the model, first, because they are the ones this
 *  document is about. An imported assembly arrives wearing fifteen of them and
 *  the library holds thirty; scrolling past twenty-nine unused rows to find the
 *  board's red is the whole problem this section solves. */
const used = computed(() => library.value.filter((m) => usage.value.has(m.id) && matches(m)));
const all = computed(() => library.value.filter(matches));

const selected = computed<MaterialDef | null>(
  () => library.value.find((m) => m.id === selectedId.value) ?? null,
);

/** What an Apply would land on. Bodies come from the browser's selection;
 *  faces from the viewport's, which is the only place a face can be picked. */
const selectionCount = computed(() => {
  engine.bridge.buildVersion.value;
  return browser.selectedBodyIds.length;
});
const faceCount = ref(0);
/** The material the selection wears right now, or null when it wears none or
 *  several. A single click only picks a tile to look at and applies nothing,
 *  so this is what tells the tile on the model apart from the one picked. */
const wornId = ref<string | null>(null);
let facePoll: number | null = null;
onMounted(() => {
  // Polled rather than subscribed, because the face selection lives on the
  // renderer's highlighter and emits nothing: it is changed by a click, by a
  // box, by a rebuild remapping it, and by four tools. Four times a second is
  // imperceptible for a button label and is one array length.
  facePoll = window.setInterval(() => {
    faceCount.value = engine.viewport.getSelectedFaceIds().length;
    // A face with nothing of its own wears its body's material, and that is
    // the one it looks like (FI-6 saw no mark at all on a freshly picked face).
    const faces = selectedFaceTargets();
    const worn = faces.length
      ? faces.map((f) => store.faceMaterialId(f.body, f.face) ?? store.bodyMaterialId(f.body))
      : browser.selectedBodyIds.map((id) => store.bodyMaterialId(id));
    wornId.value = worn.length && worn.every((w) => w === worn[0]) ? worn[0] ?? null : null;
  }, 250);
});
onUnmounted(() => { if (facePoll !== null) window.clearInterval(facePoll); });

function selectOnly(id: string | null) {
  selectedIds.value = id ? [id] : [];
  anchorId.value = id;
}

/** Click, Ctrl-click or Shift-click a material in `order`, the list it is in. A
 *  plain click on the one material already picked puts it down again. */
function pick(id: string, e: MouseEvent, order: readonly MaterialDef[]) {
  const mods = modsOf(e);
  if (!mods.toggle && !mods.range && selectedId.value === id) {
    selectOnly(null);
    return;
  }
  const next = selectRow({ keys: selectedIds.value, anchor: anchorId.value }, order.map((m) => m.id), id, mods);
  selectedIds.value = [...next.keys];
  anchorId.value = next.anchor;
}

async function deleteSelected() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  const worn = ids.filter((id) => usage.value.has(id)).length;
  if (worn) {
    const what = ids.length === 1 ? "this material" : `these ${ids.length} materials`;
    const answer = await choose(`Delete ${what}? What wears ${worn === 1 && ids.length === 1 ? "it" : "them"} goes back to the default grey.`, [
      { value: "delete", label: "Delete" },
      { value: "cancel", label: "Cancel" },
    ]);
    if (answer !== "delete") return;
  }
  store.removeMaterials(ids);
  selectOnly(null);
}

function openMenu(e: MouseEvent, m: MaterialDef) {
  e.preventDefault();
  if (!selectedSet.value.has(m.id)) selectOnly(m.id);
  const ids = [...selectedIds.value];
  const n = ids.length;
  const items: CtxItem[] = [];
  const target = faceCount.value
    ? `${faceCount.value} ${faceCount.value === 1 ? "face" : "faces"}`
    : selectionCount.value
      ? `${selectionCount.value} ${selectionCount.value === 1 ? "body" : "bodies"}`
      : "";
  if (n === 1) {
    items.push({ label: target ? `Apply to ${target}` : "Apply to selection", disabled: !target, onClick: () => applyToSelection() });
    items.push({ label: "Duplicate", onClick: () => addMaterial() });
  }
  const worn = ids.filter((id) => usage.value.has(id));
  items.push({
    label: n === 1 ? "Remove from the model" : `Remove ${n} from the model`,
    disabled: !worn.length,
    onClick: () => store.unassignMaterials(worn),
  });
  items.push({ separator: true, label: "" });
  items.push({ label: n === 1 ? "Delete" : `Delete ${n} materials`, danger: true, shortcut: "Del", onClick: () => void deleteSelected() });
  contextMenu(e.clientX, e.clientY, items);
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
  if (!selectedIds.value.length) return;
  e.preventDefault();
  // The window's own Delete removes a selected face or feature; this one is the
  // panel's.
  e.stopPropagation();
  void deleteSelected();
}

function addMaterial() {
  // Seeded from whatever is selected, because the way a library grows is "like
  // that one, but darker", and starting from the app's default grey every time
  // means dialling in a whole material to make a variant of one.
  const from = selected.value;
  const id = store.addMaterial({
    ...(from ? { ...from, name: `${from.name} copy` } : {}),
    id: undefined as unknown as string,
  });
  selectOnly(id);
}

function newMaterialMenu(e: MouseEvent) {
  const groups = contributedMaterialPresets();
  if (!groups.length) return addMaterial();
  const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const items: CtxItem[] = [{ label: "Blank", onClick: () => addMaterial() }];
  for (const g of groups) {
    items.push({
      label: g.group,
      children: g.materials.map((m) => ({ label: m.name, swatch: m.color, onClick: () => addPreset(m) })),
    });
  }
  contextMenu(at.left, at.bottom, items);
}

function addPreset(raw: unknown) {
  const id = store.addMaterialPreset(raw);
  if (id) selectOnly(id);
}

/** Push one edited field. Every control calls this, so there is one place where
 *  a value becomes a document change. */
function set(
  field: "name" | "color" | "metalness" | "roughness" | "opacity" | "emissive" | "clearcoat"
    | "ior" | "thickness" | "attenuationDistance" | "dispersion" | "iridescence"
    | "sheen" | "anisotropy" | "flakes" | "flakeSize" | "scatterDistance"
    | "attenuationColor" | "specularColor",
  raw: string,
) {
  const m = selected.value;
  if (!m) return;
  if (field === "name") {
    const name = raw.trim();
    if (name) store.updateMaterial(m.id, { name });
    return;
  }
  if (field === "color") {
    store.updateMaterial(m.id, { color: raw });
    return;
  }
  if (field === "attenuationColor") {
    // A tint with no depth would do nothing, so the first pick brings one along.
    const depth = finishOf(m).attenuationDistance > 0 ? {} : { attenuationDistance: TINT_DEPTH };
    store.updateMaterial(m.id, { attenuationColor: raw || undefined, ...(raw ? depth : {}) } as MaterialPatch);
    return;
  }
  if (field === "specularColor") {
    store.updateMaterial(m.id, { specularColor: raw || undefined } as MaterialPatch);
    return;
  }
  if (field === "thickness" && raw === "") {
    store.updateMaterial(m.id, { thickness: undefined } as unknown as MaterialPatch);
    return;
  }
  const n = Number.parseFloat(raw);
  if (Number.isFinite(n)) store.updateMaterial(m.id, { [field]: n });
}

// A slider fires input faster than frames, and an emission edit restyles every
// body wearing the material, so a drag lands as at most one edit per frame.
function slide(field: "emissive", raw: string) {
  const m = selected.value;
  const n = Number.parseFloat(raw);
  if (m && Number.isFinite(n)) setNumber(m.id, field, n);
}
let pendingNumbers: { id: string; patch: Record<string, number> } | null = null;
let numbersFrame = 0;
function setNumber(id: string, field: string, n: number) {
  if (pendingNumbers && pendingNumbers.id !== id) flushNumbers();
  pendingNumbers ??= { id, patch: {} };
  pendingNumbers.patch[field] = n;
  numbersFrame ||= requestAnimationFrame(flushNumbers);
}
function flushNumbers() {
  if (numbersFrame) cancelAnimationFrame(numbersFrame);
  numbersFrame = 0;
  const p = pendingNumbers;
  pendingNumbers = null;
  if (p) store.updateMaterial(p.id, p.patch);
}

// Transmission is how the panel names the see-through amount; the document keeps it as opacity.
function transmissionOf(m: MaterialDef): number {
  return Math.round((1 - finishOf(m).opacity) * 100) / 100;
}
function setTransmission(raw: string) {
  const t = Number.parseFloat(raw);
  if (Number.isFinite(t)) set("opacity", String(Math.round((1 - t) * 100) / 100));
}

const IOR_PRESETS = [
  { label: "Water", ior: 1.33 },
  { label: "Glass", ior: 1.5 },
  { label: "Crystal", ior: 2.0 },
  { label: "Diamond", ior: 2.42 },
] as const;
const TINT_DEPTH = 20;
// An undefined field is how a patch removes it, which exactOptionalPropertyTypes does not allow.
type MaterialPatch = Partial<Omit<MaterialDef, "id">>;

/** Glass controls only where the viewport draws glass: see-through and not metal. */
const ADVANCED_SLIDERS = [
  { field: "sheen", label: "Sheen" },
  { field: "anisotropy", label: "Anisotropy" },
  { field: "flakes", label: "Flakes" },
] as const;

function isGlass(m: MaterialDef): boolean {
  const f = finishOf(m);
  return f.opacity < 1 && f.metalness < 0.5;
}

// --- procedural surface: pick a generator, then tune it. A separate path from
// `set` above because the surface is one nested object, not a flat field: the
// picker builds a fresh one with sensible defaults, and the sliders merge into
// the one already there. "None" removes it, so the material reads back plain.
const SURFACE_KINDS = ["none", "noise", "scratches", "brushed", "voronoi", "wave"] as const;
const SURFACE_LABEL: Record<string, string> = {
  none: "None", noise: "Noise", scratches: "Scratches", brushed: "Brushed", voronoi: "Wear", wave: "Bands",
};

function pickSurface(kind: string) {
  const m = selected.value;
  if (!m) return;
  if (kind === "none") {
    store.updateMaterial(m.id, { surface: undefined } as unknown as Partial<Omit<MaterialDef, "id">>);
    return;
  }
  const k = kind as SurfaceSpec["kind"];
  const cur = m.surface;
  const next: SurfaceSpec = cur ? { ...cur, kind: k } : { kind: k, scale: 6, amount: 0.5, bump: 0.4 };
  store.updateMaterial(m.id, { surface: next });
}

function setSurface(field: "scale" | "amount" | "bump" | "angle" | "colorAmount", raw: string) {
  const m = selected.value;
  if (!m?.surface) return;
  const n = Number.parseFloat(raw);
  if (Number.isFinite(n)) store.updateMaterial(m.id, { surface: { ...m.surface, [field]: n } });
}

function setSurfaceColor(raw: string) {
  const m = selected.value;
  if (!m?.surface) return;
  store.updateMaterial(m.id, {
    surface: { ...m.surface, color: raw, colorAmount: m.surface.colorAmount || 0.5 },
  });
}

// The full node graph: opens the canvas editor over the app. A material with a
// graph ignores the single-generator picker above it (the graph is preferred).
const editingGraph = ref(false);

/** The faces the viewport has selected, as the store addresses them. Goes
 *  through the viewport's band expansion so that dressing a cylinder the kernel
 *  split into two faces dresses both halves, which is what "this face" means to
 *  the person who picked it. */
function selectedFaceTargets(): { body: string; face: number }[] {
  const out = new Map<string, { body: string; face: number }>();
  for (const fid of engine.viewport.getSelectedFaceIds()) {
    const band = engine.viewport.localFaceBand(fid);
    if (!band) continue;
    for (const f of band.faces) out.set(`${band.bodyId}#${f}`, { body: band.bodyId, face: f });
  }
  return [...out.values()];
}

function applyToSelection() {
  const m = selected.value;
  if (!m) return;
  const faces = selectedFaceTargets();
  if (faces.length) {
    store.setFacesMaterial(faces, m.id);
    return;
  }
  if (browser.selectedBodyIds.length) store.setBodiesMaterial([...browser.selectedBodyIds], m.id);
}

function clearOnSelection() {
  const faces = selectedFaceTargets();
  if (faces.length) {
    store.setFacesMaterial(faces, null);
    return;
  }
  if (browser.selectedBodyIds.length) store.setBodiesMaterial([...browser.selectedBodyIds], null);
}

function onDragStart(e: DragEvent, m: MaterialDef) {
  beginMaterialDrag({ id: m.id, name: m.name, color: m.color });
  e.dataTransfer?.setData(MATERIAL_MIME, m.id);
  // text/plain as well, so dropping one into a text field somewhere says its
  // name rather than nothing at all.
  e.dataTransfer?.setData("text/plain", m.name);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
}

async function doImport() {
  const res = await importMaterialLibrary(store);
  if (!res) return; // cancelled
  const { added, updated, problem } = res;
  const said = added || updated ? `${added} added, ${updated} updated` : "nothing usable in it";
  toast(problem ? `Materials: ${said}, ${problem}` : `Materials: ${said}`, {
    kind: added || updated ? "info" : "error",
  });
}
</script>

<template>
  <div class="rd-scroll" @keydown="onKey">
    <label class="rd-search">
      <Icon name="search" :size="13" />
      <input
        id="rd-material-search"
        v-model="search"
        class="sm-input"
        type="search"
        placeholder="Search materials"
        aria-label="Search materials"
      />
    </label>

    <!-- what the model is actually made of -->
    <section v-if="used.length" class="rd-section">
      <h3 class="rd-head">In this document <span class="tree-count">{{ used.length }}</span></h3>
      <button
        v-for="m in used"
        :key="m.id"
        class="rd-used"
        :class="{ 'is-selected': selectedSet.has(m.id) }"
        draggable="true"
        :title="`${m.name}, ${finishLabel(m)}. Drag onto a face. Ctrl or Shift click picks several, right-click for Delete.`"
        @click="pick(m.id, $event, used)"
        @contextmenu="openMenu($event, m)"
        @dragstart="onDragStart($event, m)"
        @dragend="endMaterialDrag()"
      >
        <img v-if="preview(m)" class="rd-ball sm" :src="preview(m)!" alt="" />
        <span v-else class="rd-ball sm flat" :style="{ background: m.color }"></span>
        <span class="rd-used-text">
          <span class="rd-used-name">{{ m.name }}</span>
          <span class="rd-sub">{{ finishLabel(m) }}</span>
        </span>
        <span class="rd-used-count">
          <template v-if="usage.get(m.id)?.bodies">{{ usage.get(m.id)!.bodies }}
            {{ usage.get(m.id)!.bodies === 1 ? "body" : "bodies" }}</template>
          <template v-if="usage.get(m.id)?.faces">
            <br />{{ usage.get(m.id)!.faces }}
            {{ usage.get(m.id)!.faces === 1 ? "face" : "faces" }}</template>
        </span>
      </button>
    </section>

    <!-- the library -->
    <section class="rd-section">
      <h3 class="rd-head">
        Library <span class="tree-count">{{ all.length }}</span>
        <button class="rd-mini" title="New material" @click="newMaterialMenu($event)">
          <Icon name="plus" :size="13" />New
        </button>
      </h3>
      <div class="rd-grid" role="listbox" aria-label="Material library">
        <button
          v-for="m in all"
          :key="m.id"
          class="rd-tile"
          :class="{ 'is-selected': selectedSet.has(m.id), 'is-worn': wornId === m.id }"
          role="option"
          :aria-selected="selectedSet.has(m.id)"
          draggable="true"
          :data-material="m.id"
          :title="wornId === m.id
            ? `${m.name}, ${finishLabel(m)}. Already applied to the selection.`
            : `${m.name}, ${finishLabel(m)}. Click to preview here, double-click or Apply below to use it. Drag onto a face, hold Shift for the whole body.`"
          @click="pick(m.id, $event, all)"
          @dblclick="selectOnly(m.id); applyToSelection()"
          @contextmenu="openMenu($event, m)"
          @dragstart="onDragStart($event, m)"
          @dragend="endMaterialDrag()"
        >
          <span v-if="wornId === m.id" class="rd-worn" title="What the selection wears now">
            <Icon name="check" :size="11" /> Applied
          </span>
          <img v-if="preview(m)" class="rd-ball" :src="preview(m)!" alt="" />
          <span v-else class="rd-ball flat" :style="{ background: m.color }"></span>
          <span class="rd-sub">{{ finishLabel(m) }}</span>
          <span class="rd-tile-name">{{ m.name }}</span>
        </button>
      </div>
      <div v-if="!all.length" class="sm-hint">
        {{ search ? "Nothing here matches that." : "This document has no materials." }}
      </div>
      <p class="sm-hint rd-howto">
        Click a tile to preview it below; it is not applied until you
        double-click, drag it onto the model, or press Apply. Drag onto a face
        to dress just that face, hold Shift while you drop to dress the whole
        body.
      </p>
    </section>

    <section v-if="selectedIds.length > 1" class="rd-section rd-edit">
      <h3 class="rd-head">{{ selectedIds.length }} materials picked</h3>
      <div class="mats-actions">
        <button class="btn" @click="store.unassignMaterials(selectedIds)">Remove from the model</button>
        <button class="btn" @click="deleteSelected()">Delete</button>
        <button class="btn" @click="selectOnly(null)">Deselect</button>
      </div>
    </section>

    <!-- the editor for the one that is selected -->
    <section v-if="selected" class="rd-section rd-edit">
      <h3 class="rd-head">{{ selected.name }}</h3>
      <label class="prefs-row">
        <span class="prefs-label">Name</span>
        <input
          class="sm-input"
          type="text"
          :value="selected.name"
          @change="set('name', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Colour</span>
        <input
          class="mats-color"
          type="color"
          :value="selected.color"
          @input="set('color', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Metalness</span>
        <input
          class="sm-slider"
          type="range" min="0" max="1" step="0.01"
          :value="finishOf(selected).metalness"
          @input="set('metalness', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Roughness</span>
        <input
          class="sm-slider"
          type="range" min="0" max="1" step="0.01"
          :value="finishOf(selected).roughness"
          @input="set('roughness', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Transmission</span>
        <input
          class="sm-slider"
          type="range" min="0" max="1" step="0.01"
          data-field="transmission"
          :value="transmissionOf(selected)"
          @input="setTransmission(($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label rd-heavy-label">
          Emission
          <span
            class="rd-heavy"
            data-heavy="emissive"
            title="Heavy effect: every glowing body adds lights and shadows, which can slow the view on a large model."
          ><Icon name="warning" :size="13" /></span>
        </span>
        <input
          class="sm-slider"
          type="range" min="0" max="1" step="0.01"
          data-field="emissive"
          :value="finishOf(selected).emissive"
          @input="slide('emissive', ($event.target as HTMLInputElement).value)"
          @change="flushNumbers()"
        />
      </label>
      <div v-if="emitting !== null" class="rd-emitting" role="progressbar" aria-label="Applying emission" :aria-valuenow="Math.round(emitting * 100)">
        <span class="rd-emitting-bar" :style="{ width: `${Math.round(emitting * 100)}%` }" />
      </div>
      <!-- Only where it applies. Bloom is what makes a glow read as light rather
           than as a flat bright patch, and a slider that quietly depends on a
           setting on another tab is a slider that looks broken. -->
      <div v-if="finishOf(selected).emissive > 0 && !bloomOn" class="sm-hint">
        Emission is on for this material. Turn Bloom on under Environment to see it
        spill light.
      </div>
      <label v-if="finishOf(selected).emissive > 0" class="prefs-row">
        <span class="prefs-label">Lights other parts</span>
        <input
          type="checkbox"
          data-field="castsLight"
          :checked="finishOf(selected).castsLight"
          @change="store.updateMaterial(selected.id, { castsLight: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Clearcoat</span>
        <input
          class="sm-slider"
          type="range" min="0" max="1" step="0.01"
          :value="finishOf(selected).clearcoat"
          @input="set('clearcoat', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Thin film</span>
        <input
          class="sm-slider"
          data-field="iridescence"
          type="range" min="0" max="1" step="0.01"
          :value="finishOf(selected).iridescence"
          @input="set('iridescence', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <div class="prefs-row">
        <span class="prefs-label">Highlight tint</span>
        <input
          class="mats-color"
          data-field="specularColor"
          type="color"
          :value="selected.specularColor ?? '#ffffff'"
          @input="set('specularColor', ($event.target as HTMLInputElement).value)"
        />
        <button v-if="selected.specularColor" class="rd-chip" @click="set('specularColor', '')">Clear</button>
      </div>
      <details class="rd-advanced" data-advanced>
        <summary class="prefs-label">Advanced</summary>
        <label v-for="s in ADVANCED_SLIDERS" :key="s.field" class="prefs-row">
          <span class="prefs-label">{{ s.label }}</span>
          <input
            class="sm-slider"
            type="range" min="0" max="1" step="0.01"
            :data-field="s.field"
            :value="finishOf(selected)[s.field]"
            @input="set(s.field, ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="prefs-row">
          <span class="prefs-label">Flake size (mm)</span>
          <input
            class="sm-slider"
            type="range" min="0.02" max="2" step="0.01"
            data-field="flakeSize"
            :value="finishOf(selected).flakeSize"
            @input="set('flakeSize', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label v-if="isGlass(selected)" class="prefs-row">
          <span class="prefs-label">Scatter (mm)</span>
          <input
            class="sm-slider"
            type="range" min="0" max="20" step="0.1"
            data-field="scatterDistance"
            :value="finishOf(selected).scatterDistance"
            @input="set('scatterDistance', ($event.target as HTMLInputElement).value)"
          />
        </label>
      </details>

      <!-- Glass: how light bends and colours on its way through. -->
      <div v-if="isGlass(selected)" class="rd-surface" data-glass>
        <span class="prefs-label">Glass</span>
        <div class="rd-chips" role="group" aria-label="Index of refraction">
          <button
            v-for="p in IOR_PRESETS"
            :key="p.label"
            class="rd-chip"
            :class="{ active: finishOf(selected).ior === p.ior }"
            :data-ior="p.ior"
            @click="set('ior', String(p.ior))"
          >{{ p.label }}</button>
        </div>
        <label class="prefs-row">
          <span class="prefs-label">IOR {{ finishOf(selected).ior.toFixed(2) }}</span>
          <input
            class="sm-slider"
            data-field="ior"
            type="range" min="1" max="2.5" step="0.01"
            :value="finishOf(selected).ior"
            @input="set('ior', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <div class="prefs-row" title="Auto measures how deep light travels through each body, a number overrides it">
          <span class="prefs-label">Thickness {{ selected.thickness === undefined ? "auto" : `${selected.thickness} mm` }}</span>
          <input
            class="sm-slider"
            data-field="thickness"
            type="range" min="0.5" max="50" step="0.5"
            :value="selected.thickness ?? FALLBACK_THICKNESS"
            @input="set('thickness', ($event.target as HTMLInputElement).value)"
          />
          <button
            v-if="selected.thickness !== undefined"
            class="rd-chip"
            data-field="thickness-auto"
            @click="set('thickness', '')"
          >Auto</button>
        </div>
        <label class="prefs-row">
          <span class="prefs-label">Dispersion</span>
          <input
            class="sm-slider"
            data-field="dispersion"
            type="range" min="0" max="10" step="0.1"
            :value="finishOf(selected).dispersion"
            @input="set('dispersion', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <div v-if="finishOf(selected).dispersion > 0 && (selected.thickness ?? Infinity) < 10" class="sm-hint">
          Dispersion fans the colours out over the distance light travels, raise Thickness to see it.
        </div>
        <div class="prefs-row">
          <span class="prefs-label">Tint</span>
          <input
            class="mats-color"
            data-field="attenuationColor"
            type="color"
            :value="selected.attenuationColor ?? '#ffffff'"
            @input="set('attenuationColor', ($event.target as HTMLInputElement).value)"
          />
          <button v-if="selected.attenuationColor" class="rd-chip" @click="set('attenuationColor', '')">Clear</button>
        </div>
        <label v-if="selected.attenuationColor" class="prefs-row">
          <span class="prefs-label">Tint depth {{ finishOf(selected).attenuationDistance }} mm</span>
          <input
            class="sm-slider"
            data-field="attenuationDistance"
            type="range" min="1" max="200" step="1"
            :value="finishOf(selected).attenuationDistance"
            @input="set('attenuationDistance', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <div class="sm-hint">Roughness frosts the glass.</div>
        <div v-if="isRenderLowPower()" class="sm-hint">
          Performance mode draws glass as plain see-through, so these show once it is off.
        </div>
      </div>

      <!-- Procedural surface: a generator plus a few knobs. Triplanar (no UVs),
           driving roughness, a bump and a tint, see viewport/proceduralSurface.ts. -->
      <div class="rd-surface">
        <span class="prefs-label">Surface</span>
        <div class="rd-chips" role="group" aria-label="Surface">
          <button
            v-for="k in SURFACE_KINDS"
            :key="k"
            class="rd-chip"
            :class="{ active: (selected.surface?.kind ?? 'none') === k }"
            :data-surface="k"
            @click="pickSurface(k)"
          >{{ SURFACE_LABEL[k] }}</button>
        </div>
        <template v-if="selected.surface">
          <label class="prefs-row">
            <span class="prefs-label">Scale</span>
            <input class="sm-slider" type="range" min="0.5" max="30" step="0.5"
              :value="selected.surface.scale" @input="setSurface('scale', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="prefs-row">
            <span class="prefs-label">Amount</span>
            <input class="sm-slider" type="range" min="0" max="1" step="0.01"
              :value="selected.surface.amount" @input="setSurface('amount', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="prefs-row">
            <span class="prefs-label">Bump</span>
            <input class="sm-slider" type="range" min="0" max="1" step="0.01"
              :value="selected.surface.bump ?? 0" @input="setSurface('bump', ($event.target as HTMLInputElement).value)" />
          </label>
          <label v-if="selected.surface.kind === 'scratches' || selected.surface.kind === 'brushed' || selected.surface.kind === 'wave'" class="prefs-row">
            <span class="prefs-label">Angle</span>
            <input class="sm-slider" type="range" min="0" max="3.14" step="0.01"
              :value="selected.surface.angle ?? 0" @input="setSurface('angle', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="prefs-row">
            <span class="prefs-label">Tint</span>
            <input class="mats-color" type="color"
              :value="selected.surface.color ?? '#000000'" @input="setSurfaceColor(($event.target as HTMLInputElement).value)" />
          </label>
          <label class="prefs-row">
            <span class="prefs-label">Tint amount</span>
            <input class="sm-slider" type="range" min="0" max="1" step="0.01"
              :value="selected.surface.colorAmount ?? 0" @input="setSurface('colorAmount', ($event.target as HTMLInputElement).value)" />
          </label>
        </template>
        <button class="rd-chip" data-editgraph style="margin-top:6px" @click="editingGraph = true">Edit graph…</button>
        <div v-if="selected.surfaceGraph" class="sm-hint">Using a node graph, the picker above is ignored while it is set.</div>
      </div>

      <div class="mats-actions">
        <button
          class="btn btn-primary"
          :disabled="!selectionCount && !faceCount"
          :title="selectionCount || faceCount ? '' : 'Select a body or a face first'"
          @click="applyToSelection()"
        >
          <template v-if="faceCount">Apply to {{ faceCount }}
            {{ faceCount === 1 ? "face" : "faces" }}</template>
          <template v-else-if="selectionCount">Apply to {{ selectionCount }}
            {{ selectionCount === 1 ? "body" : "bodies" }}</template>
          <template v-else>Apply to selection</template>
        </button>
        <button
          class="btn"
          :disabled="!selectionCount && !faceCount"
          @click="clearOnSelection()"
        >Clear</button>
        <button class="btn" @click="deleteSelected()">Delete</button>
      </div>
    </section>

    <div class="rd-foot">
      <button class="btn" @click="doImport()">Import…</button>
      <button class="btn" @click="exportMaterialLibrary(store)">Export…</button>
    </div>

    <!-- Inside the one root, not beside it. RenderDock hides the tabs it is not
         showing with v-show, which only reaches a component with a single root
         element; a second root (this Teleport) made v-show a silent no op and
         left the material list drawn under the Environment and Camera tabs. -->
    <Teleport to="body">
      <SurfaceNodeEditor
        v-if="editingGraph && selected"
        :material-id="selected.id"
        @close="editingGraph = false"
      />
    </Teleport>
    <RenderSections tab="material" />
  </div>
</template>
