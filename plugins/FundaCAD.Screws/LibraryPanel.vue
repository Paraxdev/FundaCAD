<script setup lang="ts">
// The fastener library: the catalogue and your own, searched and filtered, a preview and the specs
// of the one selected, and Insert. Mounted for the life of the plugin; `open` decides whether it
// draws.

import { computed, ref, watch } from "vue";
import { FloatingPanel } from "fundacad/ui";
import { openTextFile, saveTextFile, toast, useEngine } from "fundacad";
import FastenerPreview from "./FastenerPreview.vue";
import CustomForm from "./CustomForm.vue";
import {
  DRIVE_PREFIX, catalogueSize, drivesOf, expand, familyById, formatLength, lengthsFor, pitchesFor,
  specRows, threadSize, type ItemChoice,
} from "./catalogue";
import { NO_FILTERS, facets, filterEntries, groupEntries, listEntries, parseQuery, type Filters, type ListEntry } from "./search";
import { exportLibrary, parseLibraryFile } from "./library";
import { PARTS, type FastenerSpec } from "./spec";
import {
  DRAG_MIME, addUserFastener, dragging, open, removeUserFastener, selection, tab, updateUserFastener, userLibrary,
} from "./state";
import { insertFastener, placementFromSelection } from "./insert";

const engine = useEngine();
const TOTAL = catalogueSize();

const filters = ref<Filters>({ ...NO_FILTERS });
const entries = computed(() => listEntries(userLibrary.value));
const shown = computed(() => filterEntries(entries.value, filters.value));
const groups = computed(() => groupEntries(shown.value).map((g) => ({
  ...g,
  families: g.families.map((f) => ({ ...f, entries: f.entries.slice(0, 60) })),
})));
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
  if (sel?.source === "catalogue" && sel.choice.familyId === e.familyId && sel.choice.size === e.size) return expand(sel.choice);
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
watch(spec, () => { volume.value = null; });
const sizeKey = computed(() => (selection.value?.source === "catalogue" ? selection.value.choice.size : undefined));
const rows = computed(() => (spec.value
  ? specRows(spec.value, { ...(sizeKey.value ? { size: sizeKey.value } : {}), ...(volume.value !== null ? { volume: volume.value } : {}) })
  : []));

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

// --- your own ---

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
  await saveTextFile("fasteners.json", exportLibrary(userLibrary.value), { name: "Fastener library", extensions: ["json"] });
}

async function importMine() {
  const text = await openTextFile({ name: "Fastener library", extensions: ["json"] });
  if (text === null) return;
  const { specs, problems } = parseLibraryFile(text);
  for (const s of specs) addUserFastener(s);
  if (problems.length) toast(`Imported ${specs.length}, skipped ${problems.length}: ${problems.join(" | ")}`, { kind: "error" });
  else toast(`Imported ${specs.length} fastener${specs.length === 1 ? "" : "s"}`, { kind: "info" });
}

const selectStyle = { flex: "1 1 0", minWidth: "0" };
const rowStyle = (active: boolean) => ({
  display: "flex", alignItems: "center", gap: "8px", padding: "3px 6px", cursor: "pointer",
  borderRadius: "var(--r-sm, 3px)",
  background: active ? "var(--accent-tint-2, rgba(75,249,188,0.24))" : "transparent",
});
const badge = { fontSize: "9px", padding: "0 5px", borderRadius: "var(--r-pill, 999px)", border: "1px solid var(--accent, #4bf9bc)", color: "var(--accent, #4bf9bc)" };
const tabStyle = (on: boolean) => ({ fontWeight: on ? 600 : 400, opacity: on ? 1 : 0.65 });
</script>

<template>
  <FloatingPanel :open="open" close-on-esc panel-class="scr-panel" @close="open = false">
    <div class="scr-library" :style="{ width: '860px', maxWidth: '82vw' }" @pointerenter="refreshFace">
      <div :style="{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }">
        <div class="measure-title" :style="{ margin: 0 }">Fasteners</div>
        <button type="button" class="btn scr-tab-catalogue" :style="tabStyle(tab === 'catalogue')" @click="tab = 'catalogue'">Catalogue</button>
        <button type="button" class="btn scr-tab-custom" :style="tabStyle(tab === 'custom')" @click="tab = 'custom'">My fasteners ({{ userLibrary.length }})</button>
        <span class="measure-hint" :style="{ margin: '0 0 0 auto' }">{{ TOTAL.toLocaleString() }} standard items</span>
        <button type="button" class="btn scr-close" title="Close" @click="open = false">Close</button>
      </div>

      <div v-if="tab === 'catalogue'" :style="{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: '14px' }">
        <div>
          <input
            v-model="filters.query"
            class="measure-number scr-search"
            :style="{ width: '100%', boxSizing: 'border-box', textAlign: 'left', padding: '4px 6px' }"
            placeholder="Search: M3, M4x20, socket, ISO 7380, #10"
          />
          <div :style="{ display: 'flex', gap: '4px', margin: '6px 0' }">
            <select v-model="filters.category" class="measure-select scr-filter-category" :style="selectStyle">
              <option value="">All kinds</option>
              <option v-for="c in options.categories" :key="c" :value="c">{{ c }}</option>
            </select>
            <select v-model="filters.system" class="measure-select scr-filter-system" :style="selectStyle">
              <option value="">Metric and inch</option>
              <option value="metric">Metric</option>
              <option value="inch">Inch</option>
            </select>
          </div>
          <div :style="{ display: 'flex', gap: '4px', margin: '0 0 6px' }">
            <select v-model="filters.standard" class="measure-select scr-filter-standard" :style="selectStyle">
              <option value="">Any standard</option>
              <option v-for="s in options.standards" :key="s" :value="s">{{ s }}</option>
            </select>
            <select v-model="filters.drive" class="measure-select scr-filter-drive" :style="selectStyle">
              <option value="">Any drive</option>
              <option v-for="d in options.drives" :key="d" :value="d">{{ driveLabel(d) }}</option>
            </select>
            <select v-model="filters.head" class="measure-select scr-filter-head" :style="selectStyle">
              <option value="">Any head</option>
              <option v-for="h in options.heads" :key="h" :value="h">{{ h }}</option>
            </select>
          </div>
          <div class="scr-list" :style="{ maxHeight: '56vh', overflow: 'auto', paddingRight: '4px' }">
            <div v-if="!shown.length" class="measure-hint">Nothing matches. Clear a filter, or add your own under My fasteners.</div>
            <template v-for="g in groups" :key="g.category">
              <div :style="{ margin: '8px 0 2px', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-mute, #7d7590)' }">{{ g.category }}</div>
              <div v-for="fam in g.families" :key="fam.title + fam.standard" :style="{ marginBottom: '4px' }">
                <div :style="{ fontWeight: 600, padding: '2px 6px' }">
                  {{ fam.title }} <span v-if="fam.standard" :style="{ color: 'var(--text-dim, #aaa1b5)', fontWeight: 400 }">{{ fam.standard }}</span>
                </div>
                <div
                  v-for="e in fam.entries"
                  :key="e.key"
                  class="scr-row"
                  :data-key="e.key"
                  :style="rowStyle(isSelected(e))"
                  draggable="true"
                  @click="select(e)"
                  @dblclick="select(e); insert()"
                  @dragstart="onDragStart($event, e)"
                  @dragend="onDragEnd"
                >
                  <span :style="{ minWidth: '92px' }">{{ e.source === "custom" ? e.familyName : e.sizeLabel }}</span>
                  <span v-if="e.source === 'custom'" class="scr-badge" :style="badge">Custom</span>
                  <span :style="{ color: 'var(--text-dim, #aaa1b5)', fontSize: '11px' }">
                    <template v-if="e.lengths.length > 1">L {{ formatLength(e.lengths[0]!, e.system === 'inch' ? 'in' : 'mm') }} to {{ formatLength(e.lengths[e.lengths.length - 1]!, e.system === 'inch' ? 'in' : 'mm') }}</template>
                    <template v-else-if="e.source === 'custom'">{{ e.size }}</template>
                  </span>
                  <span :style="{ marginLeft: 'auto', color: 'var(--text-mute, #7d7590)', fontSize: '11px' }">{{ e.drives.map(driveLabel).join(", ") }}</span>
                </div>
              </div>
            </template>
          </div>
          <div class="measure-hint scr-count">{{ shown.length }} sizes shown</div>
        </div>

        <div v-if="spec" class="scr-detail">
          <div :style="{ fontWeight: 600, fontSize: '13px', marginBottom: '6px' }" class="scr-name">{{ spec.name }}</div>
          <div :style="{ display: 'flex', gap: '12px' }">
            <FastenerPreview :spec="spec" :width="250" :height="200" @measured="volume = $event" />
            <div :style="{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }">
              <template v-if="choice">
                <label v-if="lengths.length > 1">Length
                  <select class="measure-select scr-length" :value="choice.length" :style="{ width: '100%' }" @change="setChoice({ length: Number(($event.target as HTMLSelectElement).value) })">
                    <option v-for="l in lengths" :key="l" :value="l">{{ formatLength(l, spec.units) }}</option>
                  </select>
                </label>
                <label v-if="drives.length > 1">Drive
                  <select class="measure-select scr-drive" :value="choice.drive" :style="{ width: '100%' }" @change="setChoice({ drive: ($event.target as HTMLSelectElement).value })">
                    <option v-for="d in drives" :key="d" :value="d">{{ driveLabel(d) }} ({{ DRIVE_PREFIX[d] ?? d }})</option>
                  </select>
                </label>
                <label v-if="pitches.length > 1">Pitch
                  <select class="measure-select scr-pitch" :value="choice.pitch ?? pitches[0]!.pitch" :style="{ width: '100%' }" @change="setChoice({ pitch: Number(($event.target as HTMLSelectElement).value) })">
                    <option v-for="p in pitches" :key="p.label" :value="p.pitch">{{ p.label }}</option>
                  </select>
                </label>
                <label>Thread
                  <select class="measure-select scr-modelled" :value="choice.modelled ? 'modelled' : 'simple'" :style="{ width: '100%' }" @change="setChoice({ modelled: ($event.target as HTMLSelectElement).value === 'modelled' })">
                    <option value="simple">Simplified</option>
                    <option value="modelled">Modelled helix</option>
                  </select>
                </label>
                <label>Hand
                  <select class="measure-select" :value="choice.hand ?? 'right'" :style="{ width: '100%' }" @change="setChoice({ hand: ($event.target as HTMLSelectElement).value as 'right' | 'left' })">
                    <option value="right">Right</option>
                    <option value="left">Left</option>
                  </select>
                </label>
              </template>
              <button type="button" class="btn btn-primary scr-insert" :disabled="busy" :style="{ marginTop: '6px' }" @click="insert">
                {{ busy ? "Inserting..." : hasFace ? "Insert on selected face" : "Insert at origin" }}
              </button>
              <div class="measure-hint" :style="{ margin: 0 }">Or drag a row onto a face.</div>
              <button v-if="selection?.source !== 'custom'" type="button" class="btn scr-make-custom" @click="startNew(spec)">Make a custom one from this</button>
              <template v-else>
                <button type="button" class="btn" @click="startEdit(selection.id)">Edit</button>
                <button type="button" class="btn" @click="remove(selection.id)">Delete</button>
              </template>
            </div>
          </div>
          <div class="scr-specs" :style="{ marginTop: '10px', maxHeight: '32vh', overflow: 'auto' }">
            <div v-for="(r, i) in rows" :key="i" class="measure-row" :style="{ padding: '1px 0' }">
              <span class="measure-k" :style="{ whiteSpace: 'pre' }">{{ r.label }}</span>
              <span class="measure-v" :style="{ textAlign: 'right' }">{{ r.value }}</span>
            </div>
          </div>
        </div>
        <div v-else class="measure-hint">Pick a size on the left to see it and its specs.</div>
      </div>

      <div v-else>
        <CustomForm
          v-if="editing"
          :key="editing.id ?? 'new'"
          :initial="editing.initial"
          :editing="!!editing.id"
          @save="onSave"
          @cancel="editing = null"
        />
        <template v-else>
          <div :style="{ display: 'flex', gap: '8px', marginBottom: '8px' }">
            <button type="button" class="btn btn-primary scr-new" @click="startNew(null)">New fastener</button>
            <button type="button" class="btn scr-import" @click="importMine">Import JSON</button>
            <button type="button" class="btn scr-export" :disabled="!userLibrary.length" @click="exportMine">Export JSON</button>
          </div>
          <div v-if="!userLibrary.length" class="measure-hint">
            Nothing here yet. Make a new one, or pick a catalogue item and choose Make a custom one from this.
          </div>
          <div v-for="it in userLibrary" :key="it.id" class="scr-custom-row" :style="{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', borderBottom: '1px solid var(--line, #322c42)' }">
            <span class="scr-badge" :style="badge">Custom</span>
            <span :style="{ fontWeight: 600 }">{{ it.spec.name }}</span>
            <span class="measure-hint" :style="{ margin: 0 }">{{ it.spec.notes }}</span>
            <span :style="{ marginLeft: 'auto', display: 'flex', gap: '6px' }">
              <button type="button" class="btn" @click="selection = { source: 'custom', id: it.id }; tab = 'catalogue'">Show</button>
              <button type="button" class="btn" @click="startEdit(it.id)">Edit</button>
              <button type="button" class="btn" @click="remove(it.id)">Delete</button>
            </span>
          </div>
        </template>
      </div>
    </div>
  </FloatingPanel>
</template>
