<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { useEngine } from "../../app/engineKey";
import { useWheelScroll } from "../../composables/useWheelScroll";
import { GEOMETRY_PAGE_SIZE, useGeometryBrowserStore, type GeometryKind } from "../../stores/geometryBrowser";
import { describePick, type FacingWord } from "../../ui/describePick";
import { NO_FILTERS, type GeometryFilters, type GeometryRowType } from "../../ui/geometryRows";
import { announce } from "../../ui/announce";
import { onRenderPrefsChange, renderPrefs } from "../../ui/renderPrefs";
import { getUnit, onUnitChange } from "../../ui/units";
import Button from "../ui/Button.vue";
import FieldRow from "../ui/FieldRow.vue";
import Listbox from "../ui/Listbox.vue";
import ListRow from "../ui/ListRow.vue";
import NumberField from "../ui/NumberField.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";

const ctl = useEngine().geometryBrowser;
const list = useGeometryBrowserStore();

const KINDS: { value: GeometryKind; label: string }[] = [
  { value: "faces", label: "Faces" },
  { value: "edges", label: "Edges" },
];
const FACE_TYPES: { value: GeometryRowType | "any"; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "flat", label: "Flat" },
  { value: "cylinder", label: "Cylinder" },
  { value: "curved", label: "Curved" },
];
const EDGE_TYPES: { value: GeometryRowType | "any"; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "straight", label: "Straight" },
  { value: "round", label: "Round" },
  { value: "curved", label: "Curved" },
];
const FACINGS: { value: FacingWord | "any"; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
  { value: "front", label: "Front" },
  { value: "back", label: "Back" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

const unit = ref(getUnit());
const offUnit = onUnitChange(() => (unit.value = getUnit()));

const scroller = useTemplateRef<HTMLElement>("scroller");
useWheelScroll(scroller);

const faces = computed(() => list.kind === "faces");
const noun = computed(() => (faces.value ? "faces" : "edges"));
const bodyName = computed(() => list.bodies.find((b) => b.id === list.bodyId)?.name ?? "");
const bodyOptions = computed(() => list.bodies.map((b) => ({ value: b.id, label: b.name })));

const options = computed(() => {
  // describePick reads the display unit from outside Vue.
  void unit.value;
  return list.pageRows.map((row) => {
    const words = describePick(row.facts);
    return { value: row.key, label: words.label, hint: words.hint, spoken: words.spoken };
  });
});

const firstShown = computed(() => list.page * GEOMETRY_PAGE_SIZE + 1);
const count = (n: number) => n.toLocaleString("en-US");
const range = computed(() => {
  const last = firstShown.value + options.value.length - 1;
  return `${count(firstShown.value)} to ${count(last)} of ${count(list.filtered.length)}`;
});

const failed = computed(() => list.state === "error");
const filteredOut = computed(() => list.rows.length > 0 && list.filtered.length === 0);
const blank = computed(() => {
  if (list.bodyId === null) return "No body to list yet.";
  if (list.rows.length > 0) return filteredOut.value ? `No ${noun.value} match.` : null;
  if (failed.value) return null;
  return list.state === "ready" ? `This body has no ${noun.value}.` : `Listing the ${noun.value}.`;
});

function setFilter(next: Partial<GeometryFilters>) {
  list.setFilters(next);
  const n = list.filtered.length;
  const words = n === 1 ? noun.value.slice(0, -1) : noun.value;
  announce(`${n === 0 ? "No" : count(n)} ${words}`, "polite", { key: "geometry-filter", delay: 250 });
}

// A page's cursor moves with it, or the next build would take the list back to the cursor's page.
function turnPage(delta: 1 | -1) {
  const lead = list.filtered[(list.page + delta) * GEOMETRY_PAGE_SIZE];
  if (lead) list.setCursor(lead.key);
}

let tangent = renderPrefs().tangentEdges;
const offPrefs = onRenderPrefsChange(() => {
  if (renderPrefs().tangentEdges === tangent) return;
  tangent = renderPrefs().tangentEdges;
  ctl.show(true);
});

onMounted(() => ctl.show(true));
onUnmounted(() => {
  ctl.show(false);
  offUnit();
  offPrefs();
});
</script>

<template>
  <div class="geometry-page">
    <div class="geometry-filters">
      <FieldRow v-slot="{ id, labelId }" label="Body">
        <Select
          :id="id"
          size="sm"
          :labelledby="labelId"
          :model-value="list.bodyId ?? ''"
          :options="bodyOptions"
          :disabled="bodyOptions.length === 0"
          disabled-reason="No body to list yet"
          @update:model-value="ctl.setBody"
        />
      </FieldRow>
      <Segmented
        label="What to list"
        size="sm"
        :model-value="list.kind"
        :options="KINDS"
        @update:model-value="ctl.setKind"
      />
      <div class="geometry-filter-pair">
        <FieldRow v-slot="{ id, labelId }" label="Type" layout="stacked">
          <Select
            :id="id"
            size="sm"
            :labelledby="labelId"
            :model-value="list.filters.type ?? 'any'"
            :options="faces ? FACE_TYPES : EDGE_TYPES"
            @update:model-value="setFilter({ type: $event === 'any' ? null : $event })"
          />
        </FieldRow>
        <FieldRow v-if="faces" v-slot="{ id, labelId }" label="Facing" layout="stacked">
          <Select
            :id="id"
            size="sm"
            :labelledby="labelId"
            :model-value="list.filters.facing ?? 'any'"
            :options="FACINGS"
            @update:model-value="setFilter({ facing: $event === 'any' ? null : $event })"
          />
        </FieldRow>
      </div>
      <FieldRow v-slot="{ id, labelId }" label="Size at least">
        <NumberField
          :id="id"
          size="sm"
          commit="live"
          nullable
          :labelledby="labelId"
          :unit="unit"
          :min="0"
          :width-ch="6"
          :model-value="list.filters.minSize"
          @update:model-value="setFilter({ minSize: $event })"
        />
      </FieldRow>
    </div>
    <div ref="scroller" class="float-card-body geometry-rows" :aria-busy="list.state === 'loading' || undefined">
      <div v-if="failed" class="geometry-note" role="alert">
        <p class="empty-state">{{ list.error }}</p>
        <Button size="sm" @click="ctl.retry()">Try again</Button>
      </div>
      <div v-if="blank" class="geometry-note">
        <p class="empty-state" role="status">{{ blank }}</p>
        <Button v-if="filteredOut" size="sm" @click="setFilter(NO_FILTERS)">Clear filters</Button>
      </div>
      <Listbox
        v-if="options.length"
        multiple
        :label="`${faces ? 'Faces' : 'Edges'} of ${bodyName}`"
        :items="options"
        :model-value="list.selected"
      >
        <template #option="{ item, index, selected, attrs }">
          <ListRow
            v-bind="attrs"
            as="option"
            :label="item.label"
            :hint="item.hint"
            :selected="selected"
            :aria-label="item.spoken"
            :aria-posinset="firstShown + index"
            :aria-setsize="list.filtered.length"
          />
        </template>
      </Listbox>
    </div>
    <div v-if="list.filtered.length || list.truncated" class="geometry-pager">
      <p v-if="list.truncated" class="geometry-range">{{ count(list.truncated) }} more faces are not listed.</p>
      <span v-if="list.filtered.length" class="geometry-range">{{ range }}</span>
      <template v-if="list.pageCount > 1">
        <Button size="sm" :disabled="list.page === 0" disabled-reason="This is the first page" @click="turnPage(-1)"
          >Previous</Button
        >
        <Button
          size="sm"
          :disabled="list.page >= list.pageCount - 1"
          disabled-reason="This is the last page"
          @click="turnPage(1)"
          >Next</Button
        >
      </template>
    </div>
  </div>
</template>
