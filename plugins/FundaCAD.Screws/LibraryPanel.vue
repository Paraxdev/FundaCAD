<script setup lang="ts">
// Mounted for the life of the plugin, `open` decides whether it draws.

import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Button, Chip, FieldRow, FloatingPanel, ListRow, Segmented, Select, TextField } from "fundacad/ui";
import { openTextFile, saveTextFile, toast, useEngine } from "fundacad";
import FastenerPreview from "./FastenerPreview.vue";
import CustomForm from "./CustomForm.vue";
import {
  DRIVE_PREFIX,
  catalogueSize,
  drivesOf,
  expand,
  familyById,
  formatLength,
  lengthsFor,
  pitchesFor,
  specRows,
  threadSize,
  type ItemChoice,
} from "./catalogue";
import {
  NO_FILTERS,
  facets,
  filterEntries,
  groupEntries,
  listEntries,
  parseQuery,
  type Filters,
  type ListEntry,
} from "./search";
import { exportLibrary, parseLibraryFile } from "./library";
import { PARTS, type FastenerSpec } from "./spec";
import {
  DRAG_MIME,
  addUserFastener,
  dragging,
  open,
  removeUserFastener,
  selection,
  tab,
  updateUserFastener,
  userLibrary,
} from "./state";
import { insertFastener, placementFromSelection } from "./insert";

const engine = useEngine();
const TOTAL = catalogueSize();

const filters = ref<Filters>({ ...NO_FILTERS });
const entries = computed(() => listEntries(userLibrary.value));
const shown = computed(() => filterEntries(entries.value, filters.value));
const groups = computed(() =>
  groupEntries(shown.value).map((g) => ({
    ...g,
    families: g.families.map((f) => ({ ...f, entries: f.entries.slice(0, 60) })),
  })),
);
const options = computed(() => facets(entries.value));

function driveLabel(d: string): string {
  return PARTS.drive[d]?.label ?? d;
}

function defaultChoice(e: ListEntry): ItemChoice {
  const f = familyById(e.familyId!)!;
  const row = f.sizes.find((r) => r.size === e.size)!;
  const lengths = lengthsFor(f, row);
  const q = parseQuery(filters.value.query);
  const d = threadSize(f, e.size)?.d ?? 0;
  const wanted = q.length !== undefined ? lengths.find((l) => Math.abs(l - q.length!) < 1e-9) : undefined;
  const length = wanted ?? lengths.find((l) => l >= 2.5 * d) ?? lengths[lengths.length - 1];
  const drive = filters.value.drive && drivesOf(f).includes(filters.value.drive) ? filters.value.drive : drivesOf(f)[0];
  return {
    familyId: f.id,
    size: e.size,
    ...(length !== undefined ? { length } : {}),
    ...(drive ? { drive } : {}),
  };
}

function specOfEntry(e: ListEntry): FastenerSpec | null {
  if (e.source === "custom") return userLibrary.value.find((it) => it.id === e.customId)?.spec ?? null;
  const sel = selection.value;
  if (sel?.source === "catalogue" && sel.choice.familyId === e.familyId && sel.choice.size === e.size)
    return expand(sel.choice);
  return expand(defaultChoice(e));
}

function select(e: ListEntry) {
  if (e.source === "custom") selection.value = { source: "custom", id: e.customId! };
  else selection.value = { source: "catalogue", choice: defaultChoice(e) };
}

function isSelected(e: ListEntry): boolean {
  const sel = selection.value;
  if (!sel) return false;
  if (sel.source === "custom") return e.customId === sel.id;
  return sel.source === "catalogue" && sel.choice.familyId === e.familyId && sel.choice.size === e.size;
}

const choice = computed(() => (selection.value?.source === "catalogue" ? selection.value.choice : null));
const family = computed(() => (choice.value ? familyById(choice.value.familyId) : undefined));
const lengths = computed(() => {
  const f = family.value;
  const row = f?.sizes.find((r) => r.size === choice.value?.size);
  return f && row ? lengthsFor(f, row) : [];
});
const drives = computed(() => (family.value ? drivesOf(family.value) : []));
const pitches = computed(() => (family.value && choice.value ? pitchesFor(family.value, choice.value.size) : []));

function setChoice(patch: Partial<ItemChoice>) {
  if (!choice.value) return;
  selection.value = { source: "catalogue", choice: { ...choice.value, ...patch } };
}

const spec = computed<FastenerSpec | null>(() => {
  const sel = selection.value;
  if (!sel) return null;
  if (sel.source === "catalogue") {
    try {
      return expand(sel.choice);
    } catch {
      return null;
    }
  }
  if (sel.source === "custom") return userLibrary.value.find((it) => it.id === sel.id)?.spec ?? null;
  return sel.spec;
});

const volume = ref<number | null>(null);
watch(spec, () => {
  volume.value = null;
});
const sizeKey = computed(() => (selection.value?.source === "catalogue" ? selection.value.choice.size : undefined));
const rows = computed(() =>
  spec.value
    ? specRows(spec.value, {
        ...(sizeKey.value ? { size: sizeKey.value } : {}),
        ...(volume.value !== null ? { volume: volume.value } : {}),
      })
    : [],
);

const busy = ref(false);
const hasFace = ref(false);

async function insert() {
  if (!spec.value || busy.value) return;
  busy.value = true;
  try {
    await insertFastener(engine, spec.value, placementFromSelection(engine));
  } finally {
    busy.value = false;
  }
}

function refreshFace() {
  hasFace.value = !!placementFromSelection(engine);
}

function onDragStart(ev: DragEvent, e: ListEntry) {
  const s = specOfEntry(e);
  if (!s || !ev.dataTransfer) return;
  dragging.value = s;
  ev.dataTransfer.setData(DRAG_MIME, s.name);
  ev.dataTransfer.setData("text/plain", s.name);
  ev.dataTransfer.effectAllowed = "copy";
}

function onDragEnd() {
  dragging.value = null;
}

const editing = ref<{ id: string | null; initial: FastenerSpec | null } | null>(null);

function startNew(from: FastenerSpec | null) {
  tab.value = "custom";
  editing.value = { id: null, initial: from };
}

function startEdit(id: string) {
  const item = userLibrary.value.find((it) => it.id === id);
  if (!item) return;
  tab.value = "custom";
  editing.value = { id, initial: item.spec };
}

function onSave(s: FastenerSpec) {
  const target = editing.value;
  if (!target) return;
  if (target.id) {
    updateUserFastener(target.id, s);
    selection.value = { source: "custom", id: target.id };
  } else {
    const item = addUserFastener(s);
    selection.value = { source: "custom", id: item.id };
  }
  editing.value = null;
  toast(`Saved ${s.name}`, { kind: "info" });
}

function remove(id: string) {
  removeUserFastener(id);
}

async function exportMine() {
  if (!userLibrary.value.length) return;
  await saveTextFile("fasteners.json", exportLibrary(userLibrary.value), {
    name: "Fastener library",
    extensions: ["json"],
  });
}

async function importMine() {
  const text = await openTextFile({ name: "Fastener library", extensions: ["json"] });
  if (text === null) return;
  const { specs, problems } = parseLibraryFile(text);
  for (const s of specs) addUserFastener(s);
  if (problems.length)
    toast(`Imported ${specs.length}, skipped ${problems.length}: ${problems.join(" | ")}`, { kind: "error" });
  else toast(`Imported ${specs.length} fastener${specs.length === 1 ? "" : "s"}`, { kind: "info" });
}

const FILL = { width: "100%" };
const GROW = { flex: "1 1 0", minWidth: "0" };

const tabOptions = computed(() => [
  { value: "catalogue" as const, label: "Catalogue", attrs: { class: "scr-tab-catalogue" } },
  { value: "custom" as const, label: `My fasteners (${userLibrary.value.length})`, attrs: { class: "scr-tab-custom" } },
]);

const any = (label: string, values: readonly string[], text: (v: string) => string = (v) => v) => [
  { value: "", label },
  ...values.map((v) => ({ value: v, label: text(v) })),
];
const categoryOptions = computed(() => any("All kinds", options.value.categories));
const systemOptions = [
  { value: "", label: "Metric and inch" },
  { value: "metric", label: "Metric" },
  { value: "inch", label: "Inch" },
];
const standardOptions = computed(() => any("Any standard", options.value.standards));
const driveOptions = computed(() => any("Any drive", options.value.drives, driveLabel));
const headOptions = computed(() => any("Any head", options.value.heads));

const lengthOptions = computed(() =>
  lengths.value.map((l) => ({ value: String(l), label: formatLength(l, spec.value?.units ?? "mm") })),
);
const driveChoices = computed(() =>
  drives.value.map((d) => ({ value: d, label: `${driveLabel(d)} (${DRIVE_PREFIX[d] ?? d})` })),
);
const pitchOptions = computed(() => pitches.value.map((p) => ({ value: String(p.pitch), label: p.label })));
const modelledOptions = [
  { value: "simple", label: "Simplified" },
  { value: "modelled", label: "Modelled helix" },
];
const handOptions = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
];

function lengthHint(e: ListEntry): string {
  const unit = e.system === "inch" ? "in" : "mm";
  if (e.lengths.length > 1)
    return `L ${formatLength(e.lengths[0]!, unit)} to ${formatLength(e.lengths[e.lengths.length - 1]!, unit)}`;
  return e.source === "custom" ? e.size : "";
}

// The panel is capped to the span between the rail and the right cards, which a plugin has no stylesheet to query.
const STACK_BELOW = 640;
const libraryEl = ref<HTMLElement | null>(null);
const stacked = ref(false);
let widthWatch: ResizeObserver | null = null;
let restack = 0;
const stopWatching = () => {
  widthWatch?.disconnect();
  widthWatch = null;
  cancelAnimationFrame(restack);
  restack = 0;
};
watch(libraryEl, (el) => {
  stopWatching();
  if (!el) return;
  stacked.value = el.offsetWidth < STACK_BELOW;
  // Restacking changes the layout, so doing it inside the callback makes WebKit report a ResizeObserver loop error.
  widthWatch = new ResizeObserver(() => {
    if (restack) return;
    restack = requestAnimationFrame(() => {
      restack = 0;
      stacked.value = el.offsetWidth < STACK_BELOW;
    });
  });
  widthWatch.observe(el);
});
onBeforeUnmount(stopWatching);
</script>

<template>
  <FloatingPanel
    :open="open"
    title="Fasteners"
    close-on-esc
    panel-class="scr-panel measure-panel-column"
    @close="open = false"
  >
    <div
      ref="libraryEl"
      class="scr-library"
      :style="{ display: 'flex', flexDirection: 'column', width: '860px', maxWidth: '100%', minHeight: 0 }"
      @pointerenter="refreshFace"
    >
      <div
        :style="{
          display: 'flex',
          flexWrap: 'wrap',
          flexShrink: 0,
          alignItems: 'center',
          gap: '8px 12px',
          marginBottom: '8px',
        }"
      >
        <div class="measure-title" aria-hidden="true" :style="{ margin: 0 }">Fasteners</div>
        <div
          :style="{
            display: 'flex',
            flexWrap: 'wrap',
            order: stacked ? 2 : 0,
            flexBasis: stacked ? '100%' : 'auto',
          }"
        >
          <Segmented v-model="tab" label="Fastener library" size="sm" :options="tabOptions" />
        </div>
        <span v-if="!stacked" class="measure-hint" :style="{ margin: '0 0 0 auto' }"
          >{{ TOTAL.toLocaleString() }} standard items</span
        >
        <Button class="scr-close" :style="stacked ? { order: 1, marginLeft: 'auto' } : {}" @click="open = false"
          >Close</Button
        >
      </div>

      <div
        v-if="tab === 'catalogue'"
        :style="{
          display: 'grid',
          flexShrink: 0,
          gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : 'minmax(0, 45fr) minmax(0, 55fr)',
          gap: '14px',
        }"
      >
        <div>
          <TextField
            v-model="filters.query"
            class="scr-search"
            type="search"
            size="sm"
            label="Search fasteners"
            placeholder="Search: M3, M4x20, socket, ISO 7380, #10"
            :style="FILL"
          />
          <div :style="{ display: 'flex', gap: '4px', margin: '6px 0' }">
            <Select
              v-model="filters.category"
              class="scr-filter-category"
              size="sm"
              label="Kind"
              :options="categoryOptions"
              :style="GROW"
            />
            <Select
              v-model="filters.system"
              class="scr-filter-system"
              size="sm"
              label="Unit system"
              :options="systemOptions"
              :style="GROW"
            />
          </div>
          <div :style="{ display: 'flex', gap: '4px', margin: '0 0 6px' }">
            <Select
              v-model="filters.standard"
              class="scr-filter-standard"
              size="sm"
              label="Standard"
              :options="standardOptions"
              :style="GROW"
            />
            <Select
              v-model="filters.drive"
              class="scr-filter-drive"
              size="sm"
              label="Drive"
              :options="driveOptions"
              :style="GROW"
            />
            <Select
              v-model="filters.head"
              class="scr-filter-head"
              size="sm"
              label="Head"
              :options="headOptions"
              :style="GROW"
            />
          </div>
          <div
            class="scr-list"
            :style="{ maxHeight: stacked ? '28vh' : '56vh', overflow: 'auto', paddingRight: '4px' }"
          >
            <div v-if="!shown.length" class="measure-hint"
              >Nothing matches. Clear a filter, or add your own under My fasteners.</div
            >
            <template v-for="g in groups" :key="g.category">
              <div
                :style="{
                  margin: '8px 0 2px',
                  fontSize: 'var(--fs-micro)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--text-mute)',
                }"
                >{{ g.category }}</div
              >
              <div v-for="fam in g.families" :key="fam.title + fam.standard" :style="{ marginBottom: '4px' }">
                <div :style="{ fontWeight: 600, padding: '2px 6px' }">
                  {{ fam.title }}
                  <span v-if="fam.standard" :style="{ color: 'var(--text-dim)', fontWeight: 400 }">{{
                    fam.standard
                  }}</span>
                </div>
                <ListRow
                  v-for="e in fam.entries"
                  :key="e.key"
                  class="scr-row"
                  :data-key="e.key"
                  :label="e.source === 'custom' ? e.familyName : e.sizeLabel"
                  :hint="lengthHint(e)"
                  :selected="isSelected(e)"
                  draggable="true"
                  @click="select(e)"
                  @dblclick="
                    select(e);
                    insert();
                  "
                  @dragstart="onDragStart($event, e)"
                  @dragend="onDragEnd"
                >
                  <template #trailing>
                    <Chip v-if="e.source === 'custom'" class="scr-badge" variant="accent" size="xs" label="Custom" />
                    <span :style="{ color: 'var(--text-mute)', fontSize: 'var(--fs-micro)' }">{{
                      e.drives.map(driveLabel).join(", ")
                    }}</span>
                  </template>
                </ListRow>
              </div>
            </template>
          </div>
          <div class="measure-hint scr-count">{{ shown.length }} sizes shown</div>
        </div>

        <div v-if="spec" class="scr-detail">
          <div :style="{ fontWeight: 600, fontSize: 'var(--fs-body)', marginBottom: '6px' }" class="scr-name">{{
            spec.name
          }}</div>
          <div :style="{ display: 'flex', flexWrap: 'wrap', gap: '12px' }">
            <FastenerPreview :spec="spec" :width="250" :height="200" @measured="volume = $event" />
            <div :style="{ flex: '1 1 150px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }">
              <template v-if="choice">
                <FieldRow v-if="lengths.length > 1" v-slot="{ id }" layout="stacked" label="Length">
                  <Select
                    :id="id"
                    class="scr-length"
                    size="sm"
                    label="Length"
                    :style="FILL"
                    :options="lengthOptions"
                    :model-value="String(choice.length ?? '')"
                    @update:model-value="setChoice({ length: Number($event) })"
                  />
                </FieldRow>
                <FieldRow v-if="drives.length > 1" v-slot="{ id }" layout="stacked" label="Drive">
                  <Select
                    :id="id"
                    class="scr-drive"
                    size="sm"
                    label="Drive"
                    :style="FILL"
                    :options="driveChoices"
                    :model-value="choice.drive ?? ''"
                    @update:model-value="setChoice({ drive: $event })"
                  />
                </FieldRow>
                <FieldRow v-if="pitches.length > 1" v-slot="{ id }" layout="stacked" label="Pitch">
                  <Select
                    :id="id"
                    class="scr-pitch"
                    size="sm"
                    label="Pitch"
                    :style="FILL"
                    :options="pitchOptions"
                    :model-value="String(choice.pitch ?? pitches[0]!.pitch)"
                    @update:model-value="setChoice({ pitch: Number($event) })"
                  />
                </FieldRow>
                <FieldRow v-slot="{ id }" layout="stacked" label="Thread">
                  <Select
                    :id="id"
                    class="scr-modelled"
                    size="sm"
                    label="Thread"
                    :style="FILL"
                    :options="modelledOptions"
                    :model-value="choice.modelled ? 'modelled' : 'simple'"
                    @update:model-value="setChoice({ modelled: $event === 'modelled' })"
                  />
                </FieldRow>
                <FieldRow v-slot="{ id }" layout="stacked" label="Hand">
                  <Select
                    :id="id"
                    size="sm"
                    label="Hand"
                    :style="FILL"
                    :options="handOptions"
                    :model-value="choice.hand ?? 'right'"
                    @update:model-value="setChoice({ hand: $event as 'right' | 'left' })"
                  />
                </FieldRow>
              </template>
              <Button
                variant="primary"
                class="scr-insert"
                :disabled="busy"
                :style="{ marginTop: '6px' }"
                @click="insert"
              >
                {{ busy ? "Inserting..." : hasFace ? "Insert on selected face" : "Insert at origin" }}
              </Button>
              <div class="measure-hint" :style="{ margin: 0 }">Or drag a row onto a face.</div>
              <Button v-if="selection?.source !== 'custom'" class="scr-make-custom" @click="startNew(spec)"
                >Make a custom one from this</Button
              >
              <template v-else>
                <Button @click="startEdit(selection.id)">Edit</Button>
                <Button @click="remove(selection.id)">Delete</Button>
              </template>
            </div>
          </div>
          <div class="scr-specs" :style="{ marginTop: '10px', maxHeight: '32vh', overflow: 'auto' }">
            <div v-for="(r, i) in rows" :key="i" class="measure-row" :style="{ padding: '1px 0' }">
              <span class="measure-k" :style="{ whiteSpace: 'pre-wrap' }">{{ r.label }}</span>
              <span class="measure-v" :style="{ textAlign: 'right' }">{{ r.value }}</span>
            </div>
          </div>
        </div>
        <div v-else class="measure-hint">Pick a size on the left to see it and its specs.</div>
      </div>

      <div v-else :style="{ display: 'flex', flexDirection: 'column', minHeight: 0 }">
        <CustomForm
          v-if="editing"
          :key="editing.id ?? 'new'"
          :initial="editing.initial"
          :editing="!!editing.id"
          :stacked="stacked"
          @save="onSave"
          @cancel="editing = null"
        />
        <template v-else>
          <div :style="{ display: 'flex', gap: '8px', marginBottom: '8px' }">
            <Button variant="primary" class="scr-new" @click="startNew(null)">New fastener</Button>
            <Button class="scr-import" @click="importMine">Import JSON</Button>
            <Button class="scr-export" :disabled="!userLibrary.length" @click="exportMine">Export JSON</Button>
          </div>
          <div v-if="!userLibrary.length" class="measure-hint">
            Nothing here yet. Make a new one, or pick a catalogue item and choose Make a custom one from this.
          </div>
          <template v-for="(it, i) in userLibrary" :key="it.id">
            <div v-if="i" class="measure-divider"></div>
            <div
              class="scr-custom-row"
              :style="{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }"
            >
              <Chip class="scr-badge" variant="accent" size="xs" label="Custom" />
              <span :style="{ fontWeight: 600 }">{{ it.spec.name }}</span>
              <span class="measure-hint" :style="{ margin: 0 }">{{ it.spec.notes }}</span>
              <span :style="{ marginLeft: 'auto', display: 'flex', gap: '6px' }">
                <Button
                  size="sm"
                  :aria-label="`Show ${it.spec.name}`"
                  @click="
                    selection = { source: 'custom', id: it.id };
                    tab = 'catalogue';
                  "
                  >Show</Button
                >
                <Button size="sm" :aria-label="`Edit ${it.spec.name}`" @click="startEdit(it.id)">Edit</Button>
                <Button size="sm" :aria-label="`Delete ${it.spec.name}`" @click="remove(it.id)">Delete</Button>
              </span>
            </div>
          </template>
        </template>
      </div>
    </div>
  </FloatingPanel>
</template>
