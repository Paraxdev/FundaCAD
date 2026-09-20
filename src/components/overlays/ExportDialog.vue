<script setup lang="ts">
// Export: format, which bodies, output units and, for the formats written as
// triangles, how finely curved surfaces are faceted.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useModalGate } from "../../composables/useModalGate";
import { useExportDialogStore } from "../../stores/exportDialog";
import {
  clampFaceting, FORMATS, isMeshFormat, loadExportSettings, REFINEMENTS, refinementOf, takesUnit, UNITS,
  type BodyScope, type Faceting, type Refinement,
} from "../../io/exportSettings";
import ModalFrame from "./ModalFrame.vue";

const dialog = useExportDialogStore();
const bodies = dialog.request?.bodies ?? [];

useModalGate();

const settings = ref(loadExportSettings());
const scope = ref<BodyScope>("all");

const mesh = computed(() => isMeshFormat(settings.value.format));
const unitShown = computed(() => takesUnit(settings.value.format));

function onRefinement(ev: Event) {
  const r = (ev.target as HTMLSelectElement).value as Refinement;
  settings.value.refinement = r;
  if (r === "custom") settings.value.showAdvanced = true;
  else settings.value.faceting = { ...REFINEMENTS[r] };
}

function setFacet(key: keyof Faceting, ev: Event) {
  const v = Number.parseFloat((ev.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) return;
  settings.value.faceting = { ...settings.value.faceting, [key]: v };
  settings.value.refinement = refinementOf(settings.value.faceting);
}

function confirm() {
  settings.value.faceting = clampFaceting(settings.value.faceting);
  const s = settings.value;
  dialog.finish({ settings: { ...s, faceting: { ...s.faceting } }, scope: scope.value });
}
const cancel = () => dialog.finish(null);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  } else if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    confirm();
  }
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <ModalFrame panel-class="export-dialog" @close="cancel()">
    <template #title>Export</template>

    <div class="modal-body prefs export-body">
      <label class="prefs-row">
        <span class="prefs-label">Type</span>
        <select v-model="settings.format" class="sm-select" data-testid="export-format">
          <option v-for="f in FORMATS" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
      </label>
      <label v-if="bodies.length > 1" class="prefs-row">
        <span class="prefs-label">Bodies</span>
        <select v-model="scope" class="sm-select" data-testid="export-scope">
          <option value="all">All in one file</option>
          <option value="separate">Each body as its own file</option>
          <option v-for="b in bodies" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
      </label>

      <template v-if="mesh">
        <div class="sm-section">Output</div>
        <label v-if="unitShown" class="prefs-row">
          <span class="prefs-label">Unit</span>
          <select v-model="settings.unit" class="sm-select" data-testid="export-unit">
            <option v-for="u in UNITS" :key="u.value" :value="u.value">{{ u.label }}</option>
          </select>
        </label>
        <label v-if="settings.format === 'stl'" class="prefs-row">
          <span class="prefs-label">Format</span>
          <select v-model="settings.binary" class="sm-select" data-testid="export-binary">
            <option :value="true">Binary</option>
            <option :value="false">ASCII</option>
          </select>
        </label>
        <label class="prefs-row">
          <span class="prefs-label">Refinement</span>
          <select
            class="sm-select"
            data-testid="export-refinement"
            :value="settings.refinement"
            @change="onRefinement"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label class="prefs-row">
          <span class="prefs-label">Advanced</span>
          <span class="param-switch prefs-switch">
            <input v-model="settings.showAdvanced" type="checkbox" data-testid="export-advanced" />
            <span class="track"><span class="knob"></span></span>
          </span>
        </label>

        <template v-if="settings.showAdvanced">
          <label class="prefs-row">
            <span class="prefs-label">Surface deviation</span>
            <span class="export-num">
              <input
                class="sm-input"
                type="number"
                min="0.0001"
                step="0.005"
                data-testid="export-surface-deviation"
                :value="settings.faceting.surfaceDeviation"
                @change="setFacet('surfaceDeviation', $event)"
              />
              <span class="export-unit">mm</span>
            </span>
          </label>
          <div class="sm-hint">The largest distance allowed between the body and a facet.</div>
          <label class="prefs-row">
            <span class="prefs-label">Normal deviation</span>
            <span class="export-num">
              <input
                class="sm-input"
                type="number"
                min="0.5"
                max="90"
                step="1"
                data-testid="export-normal-deviation"
                :value="settings.faceting.normalDeviation"
                @change="setFacet('normalDeviation', $event)"
              />
              <span class="export-unit">°</span>
            </span>
          </label>
          <div class="sm-hint">The largest angle allowed between the normals of two neighbouring facets.</div>
          <label class="prefs-row">
            <span class="prefs-label">Maximum cell size</span>
            <span class="export-num">
              <input
                class="sm-input"
                type="number"
                min="0"
                step="1"
                data-testid="export-max-edge"
                :value="settings.faceting.maxEdgeLength"
                @change="setFacet('maxEdgeLength', $event)"
              />
              <span class="export-unit">mm</span>
            </span>
          </label>
          <div class="sm-hint">The longest a facet edge may be, 0 for no limit.</div>
        </template>
      </template>
    </div>

    <div class="modal-foot">
      <button type="button" class="btn" @click="cancel()">Cancel</button>
      <button type="button" class="btn btn-primary" data-testid="export-confirm" @click="confirm()">Export…</button>
    </div>
  </ModalFrame>
</template>

<style scoped>
.modal-body.prefs.export-body {
  display: flex;
  flex: 0 1 auto;
  gap: var(--s-2);
  min-width: 340px;
  padding: var(--s-5);
  overflow: auto;
}
.export-body .prefs-row {
  grid-template-columns: 130px 1fr;
}
.export-num {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.export-num input {
  flex: 1;
  min-width: 0;
}
.export-unit {
  width: 22px;
  font-size: 12px;
  color: var(--text-dim);
}
</style>
