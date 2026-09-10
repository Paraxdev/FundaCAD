<script setup lang="ts">
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
import { finishLabel, finishOf, type MaterialDef } from "../../document/materials";
import { materialPreview, onPreviewsChanged } from "../../viewport/materialPreview";
import { beginMaterialDrag, endMaterialDrag, MATERIAL_MIME } from "../../ui/materialDrag";
import { onRenderPrefsChange, renderPrefs } from "../../ui/renderPrefs";

const engine = useEngine();
const store = engine.store;
const browser = useBrowserStore();

/** Bumped when the preview renderer has something new to say, which is once:
 *  the reflections arrive a beat after the panel opens (they are a dynamic
 *  import plus a cubemap) and every swatch is worth asking for again. */
const previewTick = ref(0);
const bloomOn = ref(renderPrefs().bloom !== "off");
let offPreview: (() => void) | null = null;
let offPrefs: (() => void) | null = null;
onMounted(() => {
  offPreview = onPreviewsChanged(() => { previewTick.value++; });
  offPrefs = onRenderPrefsChange(() => { bloomOn.value = renderPrefs().bloom !== "off"; });
});
onUnmounted(() => { offPreview?.(); offPrefs?.(); });

function preview(m: MaterialDef): string | null {
  previewTick.value; // dependency: re-ask once the reflections land
  return materialPreview(m);
}

/** Which row the editor is showing. An id and not the object: the store hands
 *  back fresh objects on every edit so a subscriber can compare identity, and
 *  holding the object would freeze the editor on the material as it was before
 *  the last keystroke. */
const selectedId = ref<string | null>(null);
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
let facePoll: number | null = null;
onMounted(() => {
  // Polled rather than subscribed, because the face selection lives on the
  // renderer's highlighter and emits nothing: it is changed by a click, by a
  // box, by a rebuild remapping it, and by four tools. Four times a second is
  // imperceptible for a button label and is one array length.
  facePoll = window.setInterval(() => {
    faceCount.value = engine.viewport.getSelectedFaceIds().length;
  }, 250);
});
onUnmounted(() => { if (facePoll !== null) window.clearInterval(facePoll); });

function pick(id: string) {
  selectedId.value = selectedId.value === id ? null : id;
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
  selectedId.value = id;
}

function removeSelected() {
  const m = selected.value;
  if (!m) return;
  store.removeMaterial(m.id);
  selectedId.value = null;
}

/** Push one edited field. Every control calls this, so there is one place where
 *  a value becomes a document change. */
function set(
  field: "name" | "color" | "metalness" | "roughness" | "opacity" | "emissive",
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
  const n = Number.parseFloat(raw);
  if (Number.isFinite(n)) store.updateMaterial(m.id, { [field]: n });
}

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
  <div class="rd-scroll">
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
        :class="{ 'is-selected': m.id === selectedId }"
        draggable="true"
        :title="`${m.name}, ${finishLabel(m)}. Drag onto a face.`"
        @click="pick(m.id)"
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
        <button class="rd-mini" title="New material" @click="addMaterial()">
          <Icon name="plus" :size="13" />New
        </button>
      </h3>
      <div class="rd-grid" role="listbox" aria-label="Material library">
        <button
          v-for="m in all"
          :key="m.id"
          class="rd-tile"
          :class="{ 'is-selected': m.id === selectedId }"
          role="option"
          :aria-selected="m.id === selectedId"
          draggable="true"
          :data-material="m.id"
          :title="`${m.name}, ${finishLabel(m)}. Drag onto a face, hold Shift for the whole body.`"
          @click="pick(m.id)"
          @dblclick="pick(m.id); applyToSelection()"
          @dragstart="onDragStart($event, m)"
          @dragend="endMaterialDrag()"
        >
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
        Drag a material onto a face to dress just that face. Hold Shift while you
        drop to dress the whole body.
      </p>
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
        <span class="prefs-label">Opacity</span>
        <input
          class="sm-slider"
          type="range" min="0" max="1" step="0.01"
          :value="finishOf(selected).opacity"
          @input="set('opacity', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Glow</span>
        <input
          class="sm-slider"
          type="range" min="0" max="1" step="0.01"
          :value="finishOf(selected).emissive"
          @input="set('emissive', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <!-- Only where it applies. Bloom is what makes a glow read as light rather
           than as a flat bright patch, and a slider that quietly depends on a
           setting on another tab is a slider that looks broken. -->
      <div v-if="finishOf(selected).emissive > 0 && !bloomOn" class="sm-hint">
        Glow is on for this material. Turn Bloom on under Environment to see it
        spill light.
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
        <button class="btn" @click="removeSelected()">Delete</button>
      </div>
    </section>

    <div class="rd-foot">
      <button class="btn" @click="doImport()">Import…</button>
      <button class="btn" @click="exportMaterialLibrary(store)">Export…</button>
    </div>
  </div>
</template>
