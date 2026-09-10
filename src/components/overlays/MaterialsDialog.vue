<script setup lang="ts">
// The material library: what this document can make a body out of, and the
// editor for one of them.
//
// A DIALOG rather than a Browser section, unlike the filament palette, and the
// difference is what the two are for. A palette is four rows that are read at a
// glance while modelling, so it belongs in the panel that is always open. A
// library is a working surface: it has an editor in it, it is where a colour is
// dialled in against the model behind it, and it is opened on purpose. Putting
// it in the 232px Browser would have meant three sliders in a column 90px wide.
//
// It edits the document LIVE, with no OK to press, exactly as Preferences does
// and for the same reason: every change here is already undoable in the ordinary
// sense (change it back) and none of them is on the undo stack, so a buffered
// copy would be a second version of the library that the model was not wearing.
// Dragging a roughness slider and watching the part change is the whole gesture.

import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDialogStore } from "../../stores/dialogs";
import { useBrowserStore } from "../../stores/browser";
import { useModalGate } from "../../composables/useModalGate";
import { useBuildValue } from "../../app/useDoc";
import ModalFrame from "./ModalFrame.vue";
import { toast } from "../../ui/toast";
import { exportMaterialLibrary, importMaterialLibrary } from "../../io/files";
import { finishOf, type MaterialDef } from "../../document/materials";
import { onRenderPrefsChange, renderPrefs } from "../../ui/renderPrefs";

const engine = useEngine();
const store = engine.store;
const dialogs = useDialogStore();
const browser = useBrowserStore();
// Whether a glow will actually spill light. Watched rather than read once: the
// Preferences dialog can be opened and the setting changed while this one is up.
const bloomOn = ref(renderPrefs().bloom !== "off");
onRenderPrefsChange(() => { bloomOn.value = renderPrefs().bloom !== "off"; });
const close = () => { dialogs.materials = false; };

// Full of text-sized targets and sliders, so single-letter tool keys must not
// fire underneath it. Same call, same reason, as Preferences.
useModalGate();

/** Which row the editor is showing. An id, not the object: the list is replaced
 *  wholesale on every edit (the store hands back fresh objects so a subscriber
 *  can compare identity), so holding the object would freeze the editor on a
 *  copy of the material as it was before the last keystroke. */
const selectedId = ref<string | null>(null);

/** The library, re-read whenever the build re-emits, which is what every
 *  material setter does. */
const library = useBuildValue(() => [...store.materialLibrary]);

/** How many bodies wear each material, so a row says whether deleting it will
 *  change anything on screen. */
const usage = useBuildValue((b) => {
  const out = new Map<string, number>();
  for (const body of b.result?.bodies ?? []) {
    const m = store.bodyMaterialId(body.id);
    if (m) out.set(m, (out.get(m) ?? 0) + 1);
  }
  return out;
});

const selected = computed<MaterialDef | null>(
  () => library.value.find((m) => m.id === selectedId.value) ?? null,
);

/** The bodies an Apply would land on. */
const selectionCount = computed(() => {
  engine.bridge.buildVersion.value;
  return browser.selectedBodyIds.length;
});

function pick(id: string) {
  selectedId.value = id;
}

function addMaterial() {
  // Seeded from whatever is selected, because the way a library grows is
  // "like that one, but darker", and starting from the app's default grey
  // every time means dialling in a whole material to make a variant of one.
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
 *  a value becomes a document change and one place that decides what a slider's
 *  raw string means. */
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

function applyToSelection() {
  const m = selected.value;
  if (!m || !browser.selectedBodyIds.length) return;
  store.setBodiesMaterial([...browser.selectedBodyIds], m.id);
}

function clearOnSelection() {
  if (!browser.selectedBodyIds.length) return;
  store.setBodiesMaterial([...browser.selectedBodyIds], null);
}

async function doImport() {
  const res = await importMaterialLibrary(store);
  if (!res) return; // cancelled
  const { added, updated, problem } = res;
  const said = added || updated
    ? `${added} added, ${updated} updated`
    : "nothing usable in it";
  toast(problem ? `Materials: ${said}, ${problem}` : `Materials: ${said}`, {
    kind: added || updated ? "info" : "error",
  });
}

/** The finish a row's swatch is drawn with, so the list reads as materials and
 *  not as a colour picker: a metal gets a sheen, glass shows the panel through
 *  it, a lit part halos. Cheap and approximate on purpose, this is a 22px
 *  square, not a render. */
function swatchStyle(m: MaterialDef) {
  const f = finishOf(m);
  const sheen = Math.round(f.metalness * (1 - f.roughness) * 60);
  return {
    background: sheen
      ? `linear-gradient(135deg, rgba(255,255,255,${sheen / 100}) 0%, ${m.color} 55%)`
      : m.color,
    opacity: String(Math.max(0.25, f.opacity)),
    boxShadow: f.emissive > 0 ? `0 0 ${Math.round(4 + f.emissive * 8)}px ${m.color}` : "",
  };
}
</script>

<template>
  <ModalFrame panel-class="mats-panel" @close="close()">
    <template #title>Materials</template>

    <div class="modal-body mats">
      <!-- the library -->
      <div class="mats-list" role="listbox" aria-label="Material library">
        <button
          v-for="m in library"
          :key="m.id"
          class="mats-row"
          :class="{ 'is-selected': m.id === selectedId }"
          role="option"
          :aria-selected="m.id === selectedId"
          @click="pick(m.id)"
        >
          <span class="mats-swatch" :style="swatchStyle(m)"></span>
          <span class="mats-name">{{ m.name }}</span>
          <span v-if="usage.get(m.id)" class="tree-count">{{ usage.get(m.id) }}</span>
        </button>
        <div v-if="!library.length" class="sm-hint">This document has no materials.</div>
      </div>

      <!-- the editor for the one that is selected -->
      <div class="mats-edit">
        <template v-if="selected">
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
          <!-- Only where it applies. Bloom is what makes a glow read as light
               rather than as a flat bright patch, and a slider that quietly
               depends on a setting elsewhere is a slider that looks broken. -->
          <div v-if="finishOf(selected).emissive > 0 && !bloomOn" class="sm-hint">
            Glow is on for this material. Turn Bloom on in Preferences to see it
            spill light.
          </div>
          <div class="sm-hint">
            Changes land on the model as you make them, and on every body already
            wearing this material.
          </div>

          <div class="mats-actions">
            <button
              class="btn btn-primary"
              :disabled="!selectionCount"
              :title="selectionCount ? '' : 'Select one or more bodies first'"
              @click="applyToSelection()"
            >
              Apply to {{ selectionCount || "selection" }}<template v-if="selectionCount">
                {{ selectionCount === 1 ? " body" : " bodies" }}</template>
            </button>
            <button class="btn" :disabled="!selectionCount" @click="clearOnSelection()">
              Clear on selection
            </button>
          </div>
        </template>
        <div v-else class="sm-hint">Pick a material to edit it.</div>
      </div>
    </div>

    <div class="modal-foot mats-foot">
      <button class="btn" title="Add a material" @click="addMaterial()">New</button>
      <button class="btn" :disabled="!selected" @click="removeSelected()">Delete</button>
      <span style="flex: 1"></span>
      <button class="btn" @click="doImport()">Import…</button>
      <button class="btn" @click="exportMaterialLibrary(store)">Export…</button>
      <button class="btn btn-primary" @click="close()">Done</button>
    </div>
  </ModalFrame>
</template>
