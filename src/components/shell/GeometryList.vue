<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { refuseAloud } from "../../app/planePick";
import { useWheelScroll } from "../../composables/useWheelScroll";
import { GEOMETRY_PAGE_SIZE, useGeometryBrowserStore, type GeometryKind } from "../../stores/geometryBrowser";
import { useSelectionStore } from "../../stores/selection";
import { describePick, type FacingWord } from "../../ui/describePick";
import {
  NO_FILTERS,
  planeRowKey,
  type GeometryFilters,
  type GeometryRow,
  type GeometryRowType,
} from "../../ui/geometryRows";
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

const engine = useEngine();
const ctl = engine.geometryBrowser;
const list = useGeometryBrowserStore();
const selection = useSelectionStore();

const KINDS: { value: GeometryKind; label: string }[] = [
  { value: "faces", label: "Faces" },
  { value: "edges", label: "Edges" },
  { value: "planes", label: "Planes" },
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
const planes = computed(() => list.kind === "planes");
const facesLeft = computed(() => (faces.value ? list.truncated : null));
const noun = computed<string>(() => list.kind);
const bodyName = computed(() => list.bodies.find((b) => b.id === list.bodyId)?.name ?? "");
const bodyOptions = computed(() => list.bodies.map((b) => ({ value: b.id, label: b.name })));
const listName = computed(() => (planes.value ? "Planes" : `${faces.value ? "Faces" : "Edges"} of ${bodyName.value}`));

const options = computed(() => {
  // describePick reads the display unit from outside Vue.
  void unit.value;
  return list.pageRows.map((row) => {
    const words = describePick(row.facts);
    return { value: row.key, label: words.label, hint: words.hint, spoken: words.spoken, row };
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
  if (planes.value) return filteredOut.value ? "No planes match." : null;
  if (list.bodyId === null) return "No body to list yet.";
  if (list.rows.length > 0) return filteredOut.value ? `No ${noun.value} match.` : null;
  if (failed.value) return null;
  return list.state === "ready" ? `This body has no ${noun.value}.` : `Listing the ${noun.value}.`;
});

function sayCount() {
  const n = list.filtered.length;
  const words = n === 1 ? noun.value.slice(0, -1) : noun.value;
  announce(`${n === 0 ? "No" : count(n)} ${words}`, "polite", { key: "geometry-filter", delay: 250 });
}

const sizeError = ref<string | null>(null);
// The field goes with Planes and comes back empty.
watch(planes, () => (sizeError.value = null));
function onSizeError(error: string | null) {
  sizeError.value = error;
  if (error) announce(error, "polite", { key: "geometry-size", delay: 250 });
}

function setFilter(next: Partial<GeometryFilters>) {
  list.setFilters(next);
  sayCount();
}

// Faces wait for the engine's reply, so the count is said once the rows are in. An error or no body says its own words.
let countDue = false;
function setKind(next: GeometryKind) {
  countDue ||= next !== list.kind;
  ctl.setKind(next);
  sayCountOnceListed();
}
function sayCountOnceListed() {
  if (!countDue || list.state === "loading") return;
  countDue = false;
  if (list.state === "ready") sayCount();
}
watch(() => list.state, sayCountOnceListed);

const sayRange = () => announce(range.value, "polite", { key: "geometry-page" });

// A page's cursor moves with it, or the next build would take the list back to the cursor's page.
function turnPage(delta: 1 | -1) {
  const lead = list.filtered[(list.page + delta) * GEOMETRY_PAGE_SIZE];
  if (!lead) return;
  list.setCursor(lead.key);
  sayRange();
}

const anchor = ref<string | null>(null);
const rowByKey = computed(() => new Map(list.rows.map((r) => [r.key, r])));
const rowsOf = (keys: readonly string[]) => keys.flatMap((k) => rowByKey.value.get(k) ?? []);

// Planes stay selected as Items rows, so the two tabs show one selection.
const chosen = computed(() => {
  if (!planes.value) return list.selected;
  const rows = new Set(selection.rows.keys);
  return list.rows.filter((r) => r.plane && rows.has(planeRowKey(r.plane))).map((r) => r.key);
});

function pick(rows: readonly GeometryRow[], additive: boolean) {
  const refused = ctl.pickRows(rows, { additive });
  if (refused) refuseAloud(engine, refused);
}

function selectOnly(key: string) {
  anchor.value = key;
  const row = rowByKey.value.get(key);
  if (row?.plane) ctl.activatePlane(row);
  else pick(rowsOf([key]), false);
}

// A plain click does what Enter does on a plane, Ctrl and Shift go on to the Listbox and select, as on Items' Origin
// rows. preventDefault is how a click tells the Listbox to leave it.
function onRowClick(row: GeometryRow, e: MouseEvent) {
  if (!row.plane) return;
  const plain = !(e.ctrlKey || e.metaKey || e.shiftKey);
  if (ctl.activatePlane(row, plain)) e.preventDefault();
}

// What the Listbox wants, as the smallest change: an additive pick toggles, so keys only gained or only lost go through
// it, which also leaves picks outside this list alone. Anything else replaces the selection.
function onListSelection(next: readonly string[]) {
  const had = new Set(chosen.value);
  const now = new Set(next);
  const gained = next.filter((k) => !had.has(k));
  const lost = chosen.value.filter((k) => !now.has(k));
  const toggled = gained.length === 0 ? lost : lost.length === 0 ? gained : null;
  if (toggled && rowsOf(toggled).length === toggled.length) pick(rowsOf(toggled), true);
  else pick(rowsOf(next), false);
}

let focusedRow: GeometryRow | null = null;

function onRowFocus(row: GeometryRow) {
  focusedRow = row;
  list.setCursor(row.key);
  ctl.hover(row);
}

function onRowBlur() {
  focusedRow = null;
  ctl.hover(null);
}

const ownsFocus = () => !!scroller.value?.contains(document.activeElement);

function focusCursor() {
  const box = scroller.value;
  if (!box) return;
  const at = options.value.findIndex((o) => o.value === list.cursor);
  const rows = box.querySelectorAll<HTMLElement>("[data-roving]");
  (rows[Math.max(at, 0)] ?? box.querySelector<HTMLElement>(".empty-state"))?.focus();
}

// The Listbox has no focus recovery, and a removed row would drop focus on the body, where the next key runs a tool.
let hadFocus = false;
watch([() => list.pageRows, chosen], () => (hadFocus = ownsFocus()), { flush: "pre" });
watch(
  [() => list.pageRows, chosen],
  () => {
    if (hadFocus && !ownsFocus()) focusCursor();
    else keepTabStop();
    hadFocus = false;
  },
  { flush: "post" },
);

// The Listbox moves its stop to the first picked row when that changes, and a filter leaves it on an old index. Its
// stop follows a focus event, and a row holding focus has to hold it or Tab lands on another row.
function keepTabStop() {
  const a = document.activeElement;
  if (ownsFocus() && a instanceof HTMLElement && a.matches("[data-roving]") && a.tabIndex !== 0) {
    a.dispatchEvent(new FocusEvent("focus"));
  }
}

function moveCursor(place: number) {
  const row = list.filtered[place];
  if (!row) return;
  const was = list.page;
  list.setCursor(row.key);
  if (list.page !== was) sayRange();
  void nextTick(focusCursor);
}

function pageTurnTarget(e: KeyboardEvent): number | null {
  const at = options.value.findIndex((o) => o.value === list.cursor);
  if (at < 0) return null;
  const place = list.page * GEOMETRY_PAGE_SIZE + at;
  if (e.key === "PageUp") return Math.max(0, (list.page - 1) * GEOMETRY_PAGE_SIZE);
  if (e.key === "PageDown") return Math.min(list.filtered.length - 1, (list.page + 1) * GEOMETRY_PAGE_SIZE);
  if (e.shiftKey) return null;
  if (e.key === "ArrowUp" && at === 0 && list.page > 0) return place - 1;
  if (e.key === "ArrowDown" && at === options.value.length - 1 && list.page < list.pageCount - 1) return place + 1;
  return null;
}

// In capture, as the Listbox consumes these keys itself. Delete would otherwise remove a selected face that may not be
// the focused row.
function onListKeys(e: KeyboardEvent) {
  const guarded = e.key === "Delete" || e.key === "Backspace";
  const place = guarded || e.altKey || e.ctrlKey || e.metaKey ? null : pageTurnTarget(e);
  if (!guarded && place === null) return;
  e.preventDefault();
  e.stopPropagation();
  if (place !== null) moveCursor(place);
}

// The Listbox lets a first letter no row starts go on, and the window keymap leaves letters typed in a list alone.
function onUnmatchedLetter(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1 || e.key === " ") return;
  if (!(e.target instanceof Element) || !e.target.closest("[role=option]")) return;
  announce(`No row starts with ${e.key.toUpperCase()}. F6 goes to the 3D view.`, "polite", { key: "geometry-letter" });
}

// The viewport keeps focus put on a press, so a row would go on taking the arrows meant for the model.
function onDocPointerdown(e: PointerEvent) {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !ownsFocus()) return;
  if (!(e.target instanceof Node && scroller.value?.contains(e.target))) a.blur();
}

let tangent = renderPrefs().tangentEdges;
const offPrefs = onRenderPrefsChange(() => {
  if (renderPrefs().tangentEdges === tangent) return;
  tangent = renderPrefs().tangentEdges;
  ctl.show(true);
});

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerdown, true);
  ctl.show(true);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointerdown, true);
  ctl.hover(null);
  ctl.show(false);
  offUnit();
  offPrefs();
});
</script>

<template>
  <div class="geometry-page" data-keeps-delete>
    <div class="geometry-filters">
      <FieldRow v-if="!planes" v-slot="{ id, labelId }" label="Body">
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
        @update:model-value="setKind"
      />
      <div class="geometry-filter-pair">
        <FieldRow v-if="!planes" v-slot="{ id, labelId }" label="Type" layout="stacked">
          <Select
            :id="id"
            size="sm"
            :labelledby="labelId"
            :model-value="list.filters.type ?? 'any'"
            :options="faces ? FACE_TYPES : EDGE_TYPES"
            @update:model-value="setFilter({ type: $event === 'any' ? null : $event })"
          />
        </FieldRow>
        <FieldRow v-if="faces || planes" v-slot="{ id, labelId }" label="Facing" layout="stacked">
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
      <FieldRow
        v-if="!planes"
        v-slot="{ id, labelId, describedby }"
        label="Size at least"
        :error="sizeError ?? undefined"
      >
        <NumberField
          :id="id"
          size="sm"
          commit="live"
          nullable
          :labelledby="labelId"
          :aria-describedby="describedby"
          :unit="unit"
          :min="0"
          :width-ch="6"
          :model-value="list.filters.minSize"
          @update:model-value="setFilter({ minSize: $event })"
          @error="onSizeError"
        />
      </FieldRow>
    </div>
    <div
      ref="scroller"
      class="float-card-body geometry-rows"
      :aria-busy="list.state === 'loading' || undefined"
      @keydown="onUnmatchedLetter"
    >
      <div v-if="failed" class="geometry-note" role="alert">
        <p class="empty-state" tabindex="-1">{{ list.error }}</p>
        <Button size="sm" @click="ctl.retry()">Try again</Button>
      </div>
      <div v-if="blank" class="geometry-note">
        <p class="empty-state" role="status" tabindex="-1">{{ blank }}</p>
        <Button v-if="filteredOut" size="sm" @click="setFilter(NO_FILTERS)">Clear filters</Button>
      </div>
      <Listbox
        v-if="options.length"
        multiple
        :label="listName"
        :items="options"
        :model-value="chosen"
        :anchor="anchor"
        @update:model-value="onListSelection($event as string[])"
        @update:anchor="anchor = $event"
        @apply="selectOnly"
        @keydown.capture="onListKeys"
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
            @click="onRowClick(item.row, $event)"
            @focus="onRowFocus(item.row)"
            @blur="onRowBlur"
            @pointerenter="ctl.hover(item.row)"
            @pointerleave="ctl.hover(focusedRow)"
          />
        </template>
      </Listbox>
    </div>
    <div v-if="list.filtered.length || facesLeft" class="geometry-pager">
      <p v-if="facesLeft" class="geometry-range">{{ count(facesLeft) }} more faces are not listed.</p>
      <span v-if="list.filtered.length" class="geometry-range">{{ range }}</span>
      <template v-if="list.pageCount > 1">
        <Button
          size="sm"
          :aria-label="`Previous page of ${noun}`"
          :disabled="list.page === 0"
          disabled-reason="This is the first page"
          @click="turnPage(-1)"
          >Previous</Button
        >
        <Button
          size="sm"
          :aria-label="`Next page of ${noun}`"
          :disabled="list.page >= list.pageCount - 1"
          disabled-reason="This is the last page"
          @click="turnPage(1)"
          >Next</Button
        >
      </template>
    </div>
  </div>
</template>
