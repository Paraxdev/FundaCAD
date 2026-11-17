<script setup lang="ts">
import { spellFixed, spellNumber } from "../../ui/measure";
import { fmtKeys } from "../../input/platform";
import RenderSections from "./RenderSections.vue";
// Editing is live with no OK: none of it is on the undo stack, so a buffered copy would be a library the model is not
// wearing.

import { computed, onMounted, onUnmounted, ref, useId } from "vue";
import { useEngine } from "../../app/engineKey";
import { useBrowserStore } from "../../stores/browser";
import { useBuildValue } from "../../app/useDoc";
import Icon from "./Icon.vue";
import { toast } from "../../ui/toast";
import { exportMaterialLibrary, importMaterialLibrary } from "../../io/files";
import {
  finishOf,
  finishWords,
  type FinishGloss,
  type FinishKind,
  type MaterialDef,
  type SurfaceSpec,
} from "../../document/materials";
import { t, type MessageKey } from "../../i18n";
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
import Listbox from "../ui/Listbox.vue";

const engine = useEngine();
const store = engine.store;
const browser = useBrowserStore();

/** Bumped once, when the reflections arrive a beat after open (a dynamic import plus a cubemap), so every swatch is
 *  asked for again. */
const previewTick = ref(0);
const bloomOn = ref(renderPrefs().bloom > 0);
const emitting = ref(emissionProgress());
let offPreview: (() => void) | null = null;
let offPrefs: (() => void) | null = null;
let offEmission: (() => void) | null = null;
onMounted(() => {
  offPreview = onPreviewsChanged(() => {
    previewTick.value++;
  });
  offPrefs = onRenderPrefsChange(() => {
    bloomOn.value = renderPrefs().bloom > 0;
  });
  offEmission = onEmissionProgress((p) => {
    emitting.value = p;
  });
});
onUnmounted(() => {
  flushNumbers();
  offPreview?.();
  offPrefs?.();
  offEmission?.();
});

function preview(m: MaterialDef): string | null {
  previewTick.value; // dependency: re-ask once the reflections land
  return materialPreview(m);
}

/** Ids, not objects: the store returns fresh objects on every edit, and holding one would freeze the editor on the
 *  pre-keystroke material. */
const selectedIds = ref<string[]>([]);
const anchorId = ref<string | null>(null);
const selectedSet = computed(() => new Set(selectedIds.value));
const selectedId = computed(() => (selectedIds.value.length === 1 ? selectedIds.value[0]! : null));
const search = ref("");

const library = useBuildValue(() => [...store.materialLibrary]);

/** Bodies and faces wearing each material, two facts: six bodies is the part's plastic, two faces a dressed detail. */
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

const GLOSS_KEYS = {
  glossy: "render.mat.finish.glossy",
  satin: "render.mat.finish.satin",
  matte: "render.mat.finish.matte",
} as const satisfies Record<FinishGloss, MessageKey>;
const KIND_KEYS = {
  lit: "render.mat.finish.lit",
  transparent: "render.mat.finish.transparent",
  metallic: "render.mat.finish.metallic",
  glitter: "render.mat.finish.glitter",
  brushed: "render.mat.finish.brushed",
  velvet: "render.mat.finish.velvet",
} as const satisfies Record<FinishKind, MessageKey>;

function finishText(m: MaterialDef): string {
  const { gloss, kind } = finishWords(m);
  if (!kind) return t(GLOSS_KEYS[gloss]);
  return t("render.mat.finish.pair", { gloss: t(GLOSS_KEYS[gloss]), kind: t(KIND_KEYS[kind]) });
}

const matches = (m: MaterialDef) => {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  return `${m.name} ${finishText(m)} ${m.color}`.toLowerCase().includes(q);
};

/** The ones on the model first: an imported assembly wears fifteen of a thirty-strong library. */
const used = computed(() => library.value.filter((m) => usage.value.has(m.id) && matches(m)));
const all = computed(() => library.value.filter(matches));
const libraryItems = computed(() => all.value.map((m) => ({ value: m.id, label: m.name, m })));
const tileHowtoId = useId();

const selected = computed<MaterialDef | null>(() => library.value.find((m) => m.id === selectedId.value) ?? null);

/** What an Apply would land on. Bodies come from the browser's selection;
 *  faces from the viewport's, which is the only place a face can be picked. */
const selectionCount = computed(() => {
  engine.bridge.buildVersion.value;
  return browser.selectedBodyIds.length;
});
const faceCount = ref(0);
const applyLabel = computed(() =>
  faceCount.value
    ? t("render.mat.applyTo", { what: "face", n: faceCount.value })
    : selectionCount.value
      ? t("render.mat.applyTo", { what: "body", n: selectionCount.value })
      : t("render.mat.applyTo", { what: "selection", n: 0 }),
);
/** What the selection wears now, null for none or several. A click only picks a tile to look at, so this tells the
 *  tile on the model apart from the picked one. */
const wornId = ref<string | null>(null);
let facePoll: number | null = null;
onMounted(() => {
  // Polled: the face selection lives on the highlighter and emits nothing (clicks, boxes, rebuild remaps, four tools).
  // Four times a second is imperceptible for a button label.
  facePoll = window.setInterval(() => {
    faceCount.value = engine.viewport.getSelectedFaceIds().length;
    // A face with nothing of its own wears its body's material, and that is
    // the one it looks like (FI-6 saw no mark at all on a freshly picked face).
    const faces = selectedFaceTargets();
    const worn = faces.length
      ? faces.map((f) => store.faceMaterialId(f.body, f.face) ?? store.bodyMaterialId(f.body))
      : browser.selectedBodyIds.map((id) => store.bodyMaterialId(id));
    wornId.value = worn.length && worn.every((w) => w === worn[0]) ? (worn[0] ?? null) : null;
  }, 250);
});
onUnmounted(() => {
  if (facePoll !== null) window.clearInterval(facePoll);
});

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
  const next = selectRow(
    { keys: selectedIds.value, anchor: anchorId.value },
    order.map((m) => m.id),
    id,
    mods,
  );
  selectedIds.value = [...next.keys];
  anchorId.value = next.anchor;
}

function pickTile(id: string, e: MouseEvent) {
  pick(id, e, all.value);
  e.preventDefault();
}

function applyTile(id: string) {
  selectOnly(id);
  applyToSelection();
}

function tileName(m: MaterialDef) {
  const args = { name: m.name, finish: finishText(m) };
  return wornId.value === m.id ? t("render.mat.tileWorn", args) : t("render.mat.tile", args);
}

function tileTitle(m: MaterialDef) {
  const args = { name: m.name, finish: finishText(m) };
  return wornId.value === m.id ? t("render.mat.tileTitleWorn", args) : t("render.mat.tileTitle", args);
}

async function deleteSelected() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  const worn = ids.filter((id) => usage.value.has(id)).length;
  if (worn) {
    const answer = await choose(t("render.mat.deleteAsk", { n: ids.length }), [
      { value: "delete", label: t("render.mat.delete") },
      { value: "cancel", label: t("common.cancel") },
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
  if (n === 1) {
    items.push({
      label: applyLabel.value,
      disabled: !faceCount.value && !selectionCount.value,
      onClick: () => applyToSelection(),
    });
    items.push({ label: t("render.mat.duplicate"), onClick: () => addMaterial() });
  }
  const worn = ids.filter((id) => usage.value.has(id));
  items.push({
    label: t("render.mat.unassign", { n }),
    disabled: !worn.length,
    onClick: () => store.unassignMaterials(worn),
  });
  items.push({ separator: true, label: "" });
  items.push({
    label: t("render.mat.deleteMenu", { n }),
    danger: true,
    shortcut: "Del",
    onClick: () => void deleteSelected(),
  });
  contextMenu(e.clientX, e.clientY, items);
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  const el = e.target as HTMLElement | null;
  if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
  if (!selectedIds.value.length) return;
  e.preventDefault();
  // The window's own Delete removes a selected face or feature; this one is the
  // panel's.
  e.stopPropagation();
  void deleteSelected();
}

function addMaterial() {
  // Seeded from the selection, since a library grows as "like that one, but darker".
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
  const items: CtxItem[] = [{ label: t("render.mat.blank"), onClick: () => addMaterial() }];
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
  field:
    | "name"
    | "color"
    | "metalness"
    | "roughness"
    | "opacity"
    | "emissive"
    | "clearcoat"
    | "ior"
    | "thickness"
    | "attenuationDistance"
    | "dispersion"
    | "iridescence"
    | "sheen"
    | "anisotropy"
    | "flakes"
    | "flakeSize"
    | "scatterDistance"
    | "attenuationColor"
    | "specularColor",
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
  const v = Number.parseFloat(raw);
  if (Number.isFinite(v)) set("opacity", String(Math.round((1 - v) * 100) / 100));
}

const IOR_PRESETS = [
  {
    ior: 1.33,
    get label() {
      return t("render.mat.ior.water");
    },
  },
  {
    ior: 1.5,
    get label() {
      return t("render.mat.ior.glass");
    },
  },
  {
    ior: 2.0,
    get label() {
      return t("render.mat.ior.crystal");
    },
  },
  {
    ior: 2.42,
    get label() {
      return t("render.mat.ior.diamond");
    },
  },
] as const;
const TINT_DEPTH = 20;
// An undefined field is how a patch removes it, which exactOptionalPropertyTypes does not allow.
type MaterialPatch = Partial<Omit<MaterialDef, "id">>;

/** Glass controls only where the viewport draws glass: see-through and not metal. */
// Flakes and Flake size stay in the document but are not offered: nothing draws them yet (material rework 5pkzj6br).
const ADVANCED_SLIDERS = [
  {
    field: "sheen",
    get label() {
      return t("render.mat.sheen");
    },
  },
  {
    field: "anisotropy",
    get label() {
      return t("render.mat.anisotropy");
    },
  },
] as const;

function isGlass(m: MaterialDef): boolean {
  const f = finishOf(m);
  return f.opacity < 1 && f.metalness < 0.5;
}

// Procedural surface, separate from `set` because it is one nested object: the picker builds a fresh one with
// defaults, the sliders merge into it, and None removes it.
const SURFACE_KINDS = ["none", "noise", "scratches", "brushed", "voronoi", "wave"] as const;
const SURFACE_KEYS = {
  none: "render.surface.none",
  noise: "render.surface.noise",
  scratches: "render.surface.scratches",
  brushed: "render.surface.brushed",
  voronoi: "render.surface.wear",
  wave: "render.surface.bands",
} as const satisfies Record<(typeof SURFACE_KINDS)[number], MessageKey>;

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

/** The viewport's selected faces as the store addresses them, through band expansion so a cylinder the kernel split in
 *  two is dressed whole. */
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
  const usable = added || updated;
  const line = usable
    ? problem
      ? t("render.mat.import.countsProblem", { added, updated, problem })
      : t("render.mat.import.counts", { added, updated })
    : problem
      ? t("render.mat.import.nothingProblem", { problem })
      : t("render.mat.import.nothing");
  toast(line, { kind: usable ? "info" : "error" });
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
        :placeholder="t('render.mat.search')"
        :aria-label="t('render.mat.search')"
      />
    </label>

    <section v-if="used.length" class="rd-section">
      <h3 class="rd-head"
        >{{ t("render.mat.inDocument") }} <span class="tree-count">{{ used.length }}</span></h3
      >
      <button
        v-for="m in used"
        :key="m.id"
        class="rd-used"
        :class="{ 'is-selected': selectedSet.has(m.id) }"
        draggable="true"
        :title="fmtKeys(t('render.mat.usedTitle', { name: m.name, finish: finishText(m) }))"
        @click="pick(m.id, $event, used)"
        @contextmenu="openMenu($event, m)"
        @dragstart="onDragStart($event, m)"
        @dragend="endMaterialDrag()"
      >
        <img v-if="preview(m)" class="rd-ball sm" :src="preview(m)!" alt="" />
        <span v-else class="rd-ball sm flat" :style="{ background: m.color }"></span>
        <span class="rd-used-text">
          <span class="rd-used-name">{{ m.name }}</span>
          <span class="rd-sub">{{ finishText(m) }}</span>
        </span>
        <span class="rd-used-count">
          <template v-if="usage.get(m.id)?.bodies">{{
            t("render.mat.usedBodies", { n: usage.get(m.id)!.bodies })
          }}</template>
          <template v-if="usage.get(m.id)?.faces">
            <br />{{ t("render.mat.usedFaces", { n: usage.get(m.id)!.faces }) }}</template
          >
        </span>
      </button>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">
        {{ t("render.mat.library") }} <span class="tree-count">{{ all.length }}</span>
        <button class="rd-mini" :title="t('render.mat.newTitle')" @click="newMaterialMenu($event)">
          <Icon name="plus" :size="13" />{{ t("render.mat.new") }}
        </button>
      </h3>
      <Listbox
        v-model:anchor="anchorId"
        class="rd-grid"
        :label="t('render.mat.libraryLabel')"
        multiple
        :items="libraryItems"
        :model-value="selectedIds"
        @update:model-value="(v) => (selectedIds = typeof v === 'string' ? [v] : [...v])"
        @apply="applyTile"
      >
        <template #option="{ item: { m }, selected, attrs }">
          <button
            v-bind="attrs"
            class="rd-tile"
            :class="{ 'is-selected': selected, 'is-worn': wornId === m.id }"
            :aria-label="tileName(m)"
            :aria-describedby="tileHowtoId"
            draggable="true"
            :data-material="m.id"
            :title="tileTitle(m)"
            @click="pickTile(m.id, $event)"
            @dblclick="applyTile(m.id)"
            @contextmenu="openMenu($event, m)"
            @dragstart="onDragStart($event, m)"
            @dragend="endMaterialDrag()"
          >
            <span v-if="wornId === m.id" class="rd-worn" :title="t('render.mat.wornTitle')">
              <Icon name="check" :size="11" /> {{ t("render.mat.worn") }}
            </span>
            <img v-if="preview(m)" class="rd-ball" :src="preview(m)!" alt="" />
            <span v-else class="rd-ball flat" :style="{ background: m.color }"></span>
            <span class="rd-sub">{{ finishText(m) }}</span>
            <span class="rd-tile-name">{{ m.name }}</span>
          </button>
        </template>
      </Listbox>
      <span :id="tileHowtoId" class="sr-only">{{ t("render.mat.tileHowto") }}</span>
      <div v-if="!all.length" class="sm-hint">
        {{ search ? t("render.mat.noMatch") : t("render.mat.none") }}
      </div>
      <p class="sm-hint rd-howto">{{ t("render.mat.howto") }}</p>
    </section>

    <section v-if="selectedIds.length > 1" class="rd-section rd-edit">
      <h3 class="rd-head">{{ t("render.mat.picked", { n: selectedIds.length }) }}</h3>
      <div class="mats-actions">
        <button class="btn" @click="store.unassignMaterials(selectedIds)">{{ t("render.mat.unassignPicked") }}</button>
        <button class="btn" @click="deleteSelected()">{{ t("render.mat.delete") }}</button>
        <button class="btn" @click="selectOnly(null)">{{ t("render.mat.deselect") }}</button>
      </div>
    </section>

    <section v-if="selected" class="rd-section rd-edit">
      <h3 class="rd-head">{{ selected.name }}</h3>
      <label class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.name") }}</span>
        <input
          class="sm-input"
          type="text"
          :value="selected.name"
          @change="set('name', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.colour") }}</span>
        <input
          class="mats-color"
          type="color"
          :value="selected.color"
          @input="set('color', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.metalness") }}</span>
        <input
          class="sm-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="finishOf(selected).metalness"
          @input="set('metalness', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.roughness") }}</span>
        <input
          class="sm-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="finishOf(selected).roughness"
          @input="set('roughness', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.transmission") }}</span>
        <input
          class="sm-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          data-field="transmission"
          :value="transmissionOf(selected)"
          @input="setTransmission(($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label rd-heavy-label">
          {{ t("render.mat.emission") }}
          <span class="rd-heavy" data-heavy="emissive" :title="t('render.mat.emissionHeavy')"
            ><Icon name="warning" :size="13"
          /></span>
        </span>
        <input
          class="sm-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          data-field="emissive"
          :value="finishOf(selected).emissive"
          @input="slide('emissive', ($event.target as HTMLInputElement).value)"
          @change="flushNumbers()"
        />
      </label>
      <div
        v-if="emitting !== null"
        class="rd-emitting"
        role="progressbar"
        :aria-label="t('render.mat.emissionProgress')"
        :aria-valuenow="Math.round(emitting * 100)"
      >
        <span class="rd-emitting-bar" :style="{ width: `${Math.round(emitting * 100)}%` }" />
      </div>
      <!-- Only where it applies: a glow needs Bloom (another tab), and a slider silently depending on it looks broken. -->
      <div v-if="finishOf(selected).emissive > 0 && !bloomOn" class="sm-hint">{{ t("render.mat.emissionBloom") }}</div>
      <label v-if="finishOf(selected).emissive > 0" class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.castsLight") }}</span>
        <input
          type="checkbox"
          data-field="castsLight"
          :checked="finishOf(selected).castsLight"
          @change="store.updateMaterial(selected.id, { castsLight: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.clearcoat") }}</span>
        <input
          class="sm-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="finishOf(selected).clearcoat"
          @input="set('clearcoat', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.thinFilm") }}</span>
        <input
          class="sm-slider"
          data-field="iridescence"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="finishOf(selected).iridescence"
          @input="set('iridescence', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <div class="prefs-row">
        <span class="prefs-label">{{ t("render.mat.highlightTint") }}</span>
        <input
          class="mats-color"
          data-field="specularColor"
          type="color"
          :value="selected.specularColor ?? '#ffffff'"
          @input="set('specularColor', ($event.target as HTMLInputElement).value)"
        />
        <button v-if="selected.specularColor" class="rd-chip" @click="set('specularColor', '')">{{
          t("render.mat.clearColour")
        }}</button>
      </div>
      <details class="rd-advanced disclosure" data-advanced>
        <summary class="prefs-label"
          ><Icon class="disclosure-caret" name="caretRight" :size="10" />{{ t("render.mat.advanced") }}</summary
        >
        <label v-for="s in ADVANCED_SLIDERS" :key="s.field" class="prefs-row">
          <span class="prefs-label">{{ s.label }}</span>
          <input
            class="sm-slider"
            type="range"
            min="0"
            max="1"
            step="0.01"
            :data-field="s.field"
            :value="finishOf(selected)[s.field]"
            @input="set(s.field, ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label v-if="isGlass(selected)" class="prefs-row">
          <span class="prefs-label">{{ t("render.mat.scatter") }}</span>
          <input
            class="sm-slider"
            type="range"
            min="0"
            max="20"
            step="0.1"
            data-field="scatterDistance"
            :value="finishOf(selected).scatterDistance"
            @input="set('scatterDistance', ($event.target as HTMLInputElement).value)"
          />
        </label>
      </details>

      <!-- Glass: how light bends and colours on its way through. -->
      <div v-if="isGlass(selected)" class="rd-surface" data-glass>
        <span class="prefs-label">{{ t("render.mat.glass") }}</span>
        <div class="rd-chips" role="group" :aria-label="t('render.mat.iorLabel')">
          <button
            v-for="p in IOR_PRESETS"
            :key="p.ior"
            class="rd-chip"
            :class="{ active: finishOf(selected).ior === p.ior }"
            :data-ior="p.ior"
            @click="set('ior', String(p.ior))"
            >{{ p.label }}</button
          >
        </div>
        <label class="prefs-row">
          <span class="prefs-label">{{ t("render.mat.ior", { value: spellFixed(finishOf(selected).ior, 2) }) }}</span>
          <input
            class="sm-slider"
            data-field="ior"
            type="range"
            min="1"
            max="2.5"
            step="0.01"
            :value="finishOf(selected).ior"
            @input="set('ior', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <div class="prefs-row" :title="t('render.mat.thicknessTitle')">
          <span class="prefs-label">{{
            selected.thickness === undefined
              ? t("render.mat.thicknessAuto")
              : t("render.mat.thickness", { mm: spellNumber(selected.thickness) })
          }}</span>
          <input
            class="sm-slider"
            data-field="thickness"
            type="range"
            min="0.5"
            max="50"
            step="0.5"
            :value="selected.thickness ?? FALLBACK_THICKNESS"
            @input="set('thickness', ($event.target as HTMLInputElement).value)"
          />
          <button
            v-if="selected.thickness !== undefined"
            class="rd-chip"
            data-field="thickness-auto"
            @click="set('thickness', '')"
            >{{ t("render.mat.auto") }}</button
          >
        </div>
        <label class="prefs-row">
          <span class="prefs-label">{{ t("render.mat.dispersion") }}</span>
          <input
            class="sm-slider"
            data-field="dispersion"
            type="range"
            min="0"
            max="10"
            step="0.1"
            :value="finishOf(selected).dispersion"
            @input="set('dispersion', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <div v-if="finishOf(selected).dispersion > 0 && (selected.thickness ?? Infinity) < 10" class="sm-hint">
          {{ t("render.mat.dispersionHint") }}
        </div>
        <div class="prefs-row">
          <span class="prefs-label">{{ t("render.mat.tint") }}</span>
          <input
            class="mats-color"
            data-field="attenuationColor"
            type="color"
            :value="selected.attenuationColor ?? '#ffffff'"
            @input="set('attenuationColor', ($event.target as HTMLInputElement).value)"
          />
          <button v-if="selected.attenuationColor" class="rd-chip" @click="set('attenuationColor', '')">{{
            t("render.mat.clearColour")
          }}</button>
        </div>
        <label v-if="selected.attenuationColor" class="prefs-row">
          <span class="prefs-label">{{
            t("render.mat.tintDepth", { mm: spellNumber(finishOf(selected).attenuationDistance) })
          }}</span>
          <input
            class="sm-slider"
            data-field="attenuationDistance"
            type="range"
            min="1"
            max="200"
            step="1"
            :value="finishOf(selected).attenuationDistance"
            @input="set('attenuationDistance', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <div class="sm-hint">{{ t("render.mat.frost") }}</div>
        <div v-if="isRenderLowPower()" class="sm-hint">{{ t("render.mat.glassLowPower") }}</div>
      </div>

      <!-- Procedural surface: a generator plus a few knobs. Triplanar (no UVs),
           driving roughness, a bump and a tint, see viewport/proceduralSurface.ts. -->
      <div class="rd-surface">
        <span class="prefs-label">{{ t("render.mat.surface") }}</span>
        <div class="rd-chips" role="group" :aria-label="t('render.mat.surface')">
          <button
            v-for="k in SURFACE_KINDS"
            :key="k"
            class="rd-chip"
            :class="{ active: (selected.surface?.kind ?? 'none') === k }"
            :data-surface="k"
            @click="pickSurface(k)"
            >{{ t(SURFACE_KEYS[k]) }}</button
          >
        </div>
        <template v-if="selected.surface">
          <label class="prefs-row">
            <span class="prefs-label">{{ t("render.surface.scale") }}</span>
            <input
              class="sm-slider"
              type="range"
              min="0.5"
              max="30"
              step="0.5"
              :value="selected.surface.scale"
              @input="setSurface('scale', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="prefs-row">
            <span class="prefs-label">{{ t("render.surface.amount") }}</span>
            <input
              class="sm-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="selected.surface.amount"
              @input="setSurface('amount', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="prefs-row">
            <span class="prefs-label">{{ t("render.surface.bump") }}</span>
            <input
              class="sm-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="selected.surface.bump ?? 0"
              @input="setSurface('bump', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label
            v-if="
              selected.surface.kind === 'scratches' ||
              selected.surface.kind === 'brushed' ||
              selected.surface.kind === 'wave'
            "
            class="prefs-row"
          >
            <span class="prefs-label">{{ t("render.surface.angle") }}</span>
            <input
              class="sm-slider"
              type="range"
              min="0"
              max="3.14"
              step="0.01"
              :value="selected.surface.angle ?? 0"
              @input="setSurface('angle', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="prefs-row">
            <span class="prefs-label">{{ t("render.surface.tint") }}</span>
            <input
              class="mats-color"
              type="color"
              :value="selected.surface.color ?? '#000000'"
              @input="setSurfaceColor(($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="prefs-row">
            <span class="prefs-label">{{ t("render.surface.tintAmount") }}</span>
            <input
              class="sm-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="selected.surface.colorAmount ?? 0"
              @input="setSurface('colorAmount', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </template>
        <button class="rd-chip" data-editgraph style="margin-top: 6px" @click="editingGraph = true">{{
          t("render.mat.editGraph")
        }}</button>
        <div v-if="selected.surfaceGraph" class="sm-hint">{{ t("render.mat.graphHint") }}</div>
      </div>

      <div class="mats-actions">
        <button
          class="btn btn-primary"
          :disabled="!selectionCount && !faceCount"
          :title="selectionCount || faceCount ? '' : t('render.mat.applyReason')"
          @click="applyToSelection()"
        >
          {{ applyLabel }}
        </button>
        <button class="btn" :disabled="!selectionCount && !faceCount" @click="clearOnSelection()">{{
          t("render.mat.clearSelection")
        }}</button>
        <button class="btn" @click="deleteSelected()">{{ t("render.mat.delete") }}</button>
      </div>
    </section>

    <div class="rd-foot">
      <button class="btn" @click="doImport()">{{ t("render.mat.import") }}</button>
      <button class="btn" @click="exportMaterialLibrary(store)">{{ t("render.mat.export") }}</button>
    </div>

    <!-- Inside the one root: RenderDock's v-show only reaches a single-root component, a second root left this list
    drawn under the other tabs. -->
    <Teleport to="body">
      <SurfaceNodeEditor v-if="editingGraph && selected" :material-id="selected.id" @close="editingGraph = false" />
    </Teleport>
    <RenderSections tab="material" />
  </div>
</template>
