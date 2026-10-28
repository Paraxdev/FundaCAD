<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { escapeClaimed } from "../../ui/escapeClaim";
import { useExportDialogStore } from "../../stores/exportDialog";
import {
  clampFaceting,
  clampTolerance,
  DEFAULT_SETTINGS,
  FORMATS,
  isFlatFormat,
  isMeshFormat,
  loadExportSettings,
  REFINEMENTS,
  refinementOf,
  takesUnit,
  UNITS,
  type BodyScope,
  type Faceting,
  type Refinement,
} from "../../io/exportSettings";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import NumberField from "../ui/NumberField.vue";
import Select from "../ui/Select.vue";
import Switch from "../ui/Switch.vue";

const dialog = useExportDialogStore();
const bodies = dialog.request?.bodies ?? [];
const picked = dialog.request?.selected?.length ?? 0;

const flat = dialog.request?.flat ?? null;
const formatOptions = flat ? FORMATS : FORMATS.filter((f) => !isFlatFormat(f.value));
const settings = ref(loadExportSettings());
if (dialog.request?.format) settings.value.format = dialog.request.format;
if (!formatOptions.some((f) => f.value === settings.value.format)) settings.value.format = DEFAULT_SETTINGS.format;
const scope = ref<BodyScope>(dialog.request?.scope ?? "all");

const mesh = computed(() => isMeshFormat(settings.value.format));
const flatShown = computed(() => isFlatFormat(settings.value.format));
const unitShown = computed(() => takesUnit(settings.value.format));

const REFINEMENT_OPTIONS: { value: Refinement; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "custom", label: "Custom" },
];
const scopeOptions = computed(() => [
  { value: "all", label: "All in one file" },
  { value: "separate", label: "Each body as its own file" },
  ...(picked > 1
    ? [
        { value: "selected", label: `Selected (${picked} bodies)` },
        { value: "selected-separate", label: `Selected (${picked} bodies), each as its own file` },
      ]
    : []),
  ...bodies.map((b) => ({ value: b.id, label: b.name })),
]);
// The picker speaks strings; STL's binary flag is a bool, so it rides through
// one either way.
const BINARY_OPTIONS = [
  { value: "binary", label: "Binary" },
  { value: "ascii", label: "ASCII" },
];
function onRefinement(r: Refinement) {
  settings.value.refinement = r;
  if (r === "custom") settings.value.showAdvanced = true;
  else settings.value.faceting = { ...REFINEMENTS[r] };
}

function setFacet(key: keyof Faceting, v: number | null) {
  if (v == null || !Number.isFinite(v)) return;
  settings.value.faceting = { ...settings.value.faceting, [key]: v };
  settings.value.refinement = refinementOf(settings.value.faceting);
}

function confirm() {
  settings.value.faceting = clampFaceting(settings.value.faceting);
  settings.value.tolerance = clampTolerance(settings.value.tolerance);
  const s = settings.value;
  dialog.finish({ settings: { ...s, faceting: { ...s.faceting } }, scope: scope.value });
}
const cancel = () => dialog.finish(null);

function onKey(e: KeyboardEvent) {
  // A picker's popover binds its listener after this one, so escapeClaimed() is how it says the Escape is taken.
  if (e.key === "Escape" && !escapeClaimed()) {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  } else if (
    e.key === "Enter" &&
    !(e.target instanceof HTMLSelectElement) &&
    !(e.target as HTMLElement)?.closest(".select-trigger, .select-pop")
  ) {
    e.preventDefault();
    confirm();
  }
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <!-- Escape and Enter are this dialog's own handler above; the frame holds the modal gate and the focus. Fields are
       live, as Enter confirms before a field would commit. -->
  <Dialog
    title="Export"
    panel-class="export-dialog"
    :close-on-esc="false"
    :body="false"
    initial-focus="[data-testid=export-confirm]"
    @close="cancel()"
  >
    <div class="modal-body prefs export-body">
      <label class="prefs-row">
        <span class="prefs-label">Type</span>
        <Select v-model="settings.format" :options="formatOptions" label="Type" testid="export-format" />
      </label>
      <template v-if="flatShown && flat">
        <div class="prefs-row">
          <span class="prefs-label">Draws</span>
          <span data-testid="export-flat-source">{{ flat.label }}</span>
        </div>
        <label class="prefs-row">
          <span class="prefs-label">Tolerance</span>
          <NumberField
            label="Tolerance"
            commit="live"
            unit="mm"
            data-testid="export-tolerance"
            :model-value="settings.tolerance"
            @update:model-value="
              (v: number | null) => {
                if (v != null && Number.isFinite(v)) settings.tolerance = v;
              }
            "
          />
        </label>
        <div class="sm-hint"
          >Drawn at true size in millimetres. Lines, arcs and circles stay exact, other curves become polylines this
          close to the curve.</div
        >
      </template>
      <label v-if="bodies.length > 1 && !flatShown" class="prefs-row">
        <span class="prefs-label">Bodies</span>
        <Select v-model="scope" :options="scopeOptions" label="Bodies" testid="export-scope" />
      </label>

      <template v-if="mesh">
        <div class="sm-section">Output</div>
        <label v-if="unitShown" class="prefs-row">
          <span class="prefs-label">Unit</span>
          <Select v-model="settings.unit" :options="UNITS" label="Unit" testid="export-unit" />
        </label>
        <label v-if="settings.format === 'stl'" class="prefs-row">
          <span class="prefs-label">Format</span>
          <Select
            :model-value="settings.binary ? 'binary' : 'ascii'"
            :options="BINARY_OPTIONS"
            label="Format"
            testid="export-binary"
            @update:model-value="settings.binary = $event === 'binary'"
          />
        </label>
        <label class="prefs-row">
          <span class="prefs-label">Refinement</span>
          <Select
            :model-value="settings.refinement"
            :options="REFINEMENT_OPTIONS"
            label="Refinement"
            testid="export-refinement"
            @update:model-value="onRefinement"
          />
        </label>
        <label class="prefs-row">
          <span class="prefs-label">Advanced</span>
          <Switch v-model="settings.showAdvanced" label="Advanced" data-testid="export-advanced" />
        </label>

        <template v-if="settings.showAdvanced">
          <label class="prefs-row">
            <span class="prefs-label">Surface deviation</span>
            <NumberField
              commit="live"
              unit="mm"
              label="Surface deviation"
              data-testid="export-surface-deviation"
              :model-value="settings.faceting.surfaceDeviation"
              @update:model-value="setFacet('surfaceDeviation', $event)"
            />
          </label>
          <div class="sm-hint">The largest distance allowed between the body and a facet.</div>
          <label class="prefs-row">
            <span class="prefs-label">Normal deviation</span>
            <NumberField
              commit="live"
              unit="deg"
              label="Normal deviation"
              data-testid="export-normal-deviation"
              :model-value="settings.faceting.normalDeviation"
              @update:model-value="setFacet('normalDeviation', $event)"
            />
          </label>
          <div class="sm-hint">The largest angle allowed between the normals of two neighbouring facets.</div>
          <label class="prefs-row">
            <span class="prefs-label">Maximum cell size</span>
            <NumberField
              commit="live"
              unit="mm"
              label="Maximum cell size"
              data-testid="export-max-edge"
              :model-value="settings.faceting.maxEdgeLength"
              @update:model-value="setFacet('maxEdgeLength', $event)"
            />
          </label>
          <div class="sm-hint">The longest a facet edge may be, 0 for no limit.</div>
        </template>
      </template>
    </div>

    <template #footer>
      <Button @click="cancel()">Cancel</Button>
      <Button variant="primary" data-testid="export-confirm" @click="confirm()">Export…</Button>
    </template>
  </Dialog>
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
</style>
