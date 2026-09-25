<script setup lang="ts">
// The history: a floating list of every feature in build order, with a draggable
// rollback marker, transport buttons and an error badge that jumps to failing
// features. A selected row opens its values in place under it.

import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue, useBuildValue } from "../../app/useDoc";
import { useSelectionStore } from "../../stores/selection";
import { useTimelineStore } from "../../stores/timeline";
import { useShellStore } from "../../stores/shell";
import { featureMeta } from "../../ui/featureMeta";
import Icon from "./Icon.vue";
import { contextMenu } from "../../ui/menu";
import { buildProgress, CANCEL_DELAY_MS, historyShowsEmpty, waitLabel } from "../../ui/buildProgress";
import { featureNotes } from "../../ui/featureNotes";
import { gapIndexIn } from "../../ui/trackGaps";
import { getUnit, onUnitChange } from "../../ui/units";
import FeatureProperties from "./FeatureProperties.vue";
import { useSelectionOffers } from "../../composables/useSelectionOffers";
import { relatedFeatureIds } from "../../ui/relatedFeatures";
import { routeTreeClick, treePickWaiting } from "../../ui/treePick";
import { featurePick } from "../../app/featurePick";
import type { Feature } from "../../types";

const engine = useEngine();
const store = engine.store;
const selection = useSelectionStore();
const timeline = useTimelineStore();
const shellStore = useShellStore();

const scroller = useTemplateRef<HTMLElement>("scroller");
const track = useTemplateRef<HTMLElement>("track");

// Cast because `name` is optional and only on SOME feature variants, the same
// way every other reader of it in the app reaches for it.
const features = useDocValue((doc) =>
  doc.features.map((f) => {
    const activeWhen = (f as { activeWhen?: unknown }).activeWhen;
    return {
      id: f.id,
      type: f.type,
      name: (f as { name?: string }).name ?? "",
      hasCondition: activeWhen !== undefined,
      inactive: activeWhen === 0,
    };
  }),
);

// --- Related to Selection -------------------------------------------------
// The selection lives on the viewport and the overlay, which are not reactive;
// the offers composable already watches both and bumps `counts` on a change.
const selectionOffers = useSelectionOffers(engine);
const RELATED_KEY = "fundacad.historyRelated";
const relatedOn = ref((() => {
  try { return localStorage.getItem(RELATED_KEY) !== "0"; } catch { return true; }
})());
function toggleRelated() {
  relatedOn.value = !relatedOn.value;
  try { localStorage.setItem(RELATED_KEY, relatedOn.value ? "1" : "0"); } catch { /* not remembered */ }
}
const related = computed<Set<string> | null>(() => {
  void selectionOffers.counts.value;
  void features.value;
  const seeds = new Set<string>();
  for (const f of engine.viewport.getSelectedFaceIds()) {
    const owner = engine.featureForFace(f);
    if (owner) seeds.add(owner);
  }
  const bodies = new Set(engine.viewport.getSelectedBodies());
  for (const b of store.buildState.result?.bodies ?? []) {
    if (bodies.has(b.id)) for (const o of b.faceOwners ?? []) if (o) seeds.add(o);
  }
  for (const r of engine.overlay.selectedRegions()) seeds.add(r.sketchId);
  return seeds.size ? relatedFeatureIds(store.document.features, seeds) : null;
});
const filtering = computed(() => relatedOn.value && related.value !== null);

const unit = ref(getUnit());
const offUnit = onUnitChange(() => { unit.value = getUnit(); });
onUnmounted(offUnit);

// The SAVED marker, from the document. Transport buttons and the marker drag
// act on this, and it is what a save records.
const docRollback = useDocValue(() => store.rollbackIndex);
// A bump on every edit-preview change (which does not touch the document, so
// useDocValue would not see it), so `editing` and the marker below re-read.
const editTick = ref(0);
const editing = computed(() => {
  editTick.value;
  return store.editPreviewId !== null && !store.editPreviewInPlace;
});
// The marker AS DRAWN. While a feature is being edited it drops onto that
// feature, since the preview shows the model as of that step with everything
// after it rolled away; the saved marker (docRollback) stays put and finishing
// the edit springs the drawn marker back to it.
const rollback = computed(() => {
  if (editing.value) {
    const i = features.value.findIndex((f) => f.id === store.editPreviewId);
    if (i >= 0) return i + 1;
  }
  return docRollback.value;
});
const suppressed = useDocValue(() => new Set(features.value.filter((f) => store.isSuppressed(f.id)).map((f) => f.id)));

/** Every failing feature this build: id -> message. Continue-past-errors can
 *  yield several; fall back to the single legacy error field. */
const errors = useBuildValue((b) => {
  const m = new Map<string, string>();
  for (const e of b.result?.featureErrors ?? []) if (e.feature_id) m.set(e.feature_id, e.message);
  if (b.errorFeatureId && !m.has(b.errorFeatureId)) m.set(b.errorFeatureId, b.errorMessage ?? "failed");
  return m;
});
/** Every feature that BUILT but had something to say: id -> reason. The rule
 *  itself is in ui/featureNotes.ts, where it can be read and tested on its own;
 *  this is the wiring. */
const notes = useBuildValue((b) =>
  featureNotes({
    featureErrors: b.result?.featureErrors,
    errorFeatureId: b.errorFeatureId,
    diagnostics: b.result?.diagnostics,
  }),
);
const building = useBuildValue((b) => b.building);
const progress = useBuildValue((b) => ({ progress: b.progress, meshed: b.meshed, meshTotal: b.meshTotal }));

// --- busy / Cancel -------------------------------------------------------
// Timestamp the TRANSITION into busy, not each emission: an op emits busy
// frames throughout, and re-arming the delay on every one means it never
// elapses. The delay exists so a fast op doesn't flash a button at the user.
const busy = engine.bridge.busy;
const busySince = ref(0);
const delayElapsed = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

watch(
  busy,
  (b) => {
    if (!b.active) {
      busySince.value = 0;
      delayElapsed.value = false;
      if (timer) { clearTimeout(timer); timer = null; }
      return;
    }
    if (busySince.value) return; // already timing this op
    busySince.value = Date.now();
    timer = setTimeout(() => { delayElapsed.value = true; }, CANCEL_DELAY_MS);
  },
  { immediate: true },
);
onUnmounted(() => { if (timer) clearTimeout(timer); });

const chip = computed(() =>
  busy.value.waiting
    ? { label: "waiting…", pct: 0 }
    : buildProgress(progress.value.progress, progress.value.meshed, progress.value.meshTotal, features.value.length),
);
const busyText = computed(() => {
  const b = busy.value;
  if (b.waiting) return waitLabel(b.waiting);
  return b.pct === null ? b.label : `${b.label} ${b.pct}%`;
});

// Cancelling is not instant (the engine kills the worker and spawns a fresh
// one), so the button disables itself in flight, a second press would target
// an op that is already gone.
const cancelling = ref(false);
async function cancelBusy() {
  cancelling.value = true;
  try {
    await store.cancelBusy();
  } finally {
    cancelling.value = false;
  }
}

// An import into an EMPTY document is the most common long operation there is,
// and without the busy check the timeline would advertise "start with a Sketch"
// for the whole 90+ seconds.
const showEmpty = computed(() => historyShowsEmpty(features.value.length, busy.value));
const showCancel = computed(() => busy.value.active && delayElapsed.value && !showEmpty.value);

// --- chips ---------------------------------------------------------------
// The whole feature, not just its type: a boolean is named after the operation
// it performs (ui/featureMeta.ts), so a chip that read only the type would give
// three different commands one word. Unknown types still render rather than
// crash, a document from a newer version would otherwise throw mid-draw and
// make File→Open silently do nothing.
function metaFor(f: { type: string; operation?: unknown }) {
  return featureMeta(f);
}

function chipTitle(f: { id: string; type: string; inactive?: boolean }, i: number) {
  const err = errors.value.get(f.id);
  const note = notes.value.get(f.id);
  return (
    `${i + 1} · ${metaFor(f).label}` +
    (f.inactive ? "\nSwitched off: its Active when condition is 0" : "") +
    // A plain-text word, not a warning sign: this is a `title` attribute, and
    // the browser draws it in the OS tooltip font where a symbol lands as
    // whatever fallback glyph, or tofu, that font happens to carry.
    //
    // The two are mutually exclusive by construction (notes skips a feature
    // that failed), so this reads as one line either way rather than as a
    // feature accused of two different things.
    (err ? `\nFailed: ${err}` : note ? `\nNote: ${note}` : "") +
    "\nclick to edit · double-click to see the model as of here, Esc to go back · right-click for more"
  );
}

// A single click SELECTS a step: its values open under the chip and the datum
// it made lights up, but the MODEL DOES NOT MOVE. A double-click EDITS it, which
// rolls the view back to just before the feature (its own tool then shows the
// inputs it was built from) and opens that tool; finishing or Escape puts the
// model back at the tip. There is no separate "peek": the edit's own rollback is
// the look back in time, and one gesture that moves the model is clearer than a
// single click that quietly did.
//
// Both are ignored while a tool already owns the screen (an edit in progress, a
// sketch): a click that swapped the open feature out from under a running editor
// is exactly the "clicking around bugs out" case. Finish or Escape first.
function busyElsewhere(): boolean {
  return engine.toolBusy() || engine.sketch.active;
}
// A tool waiting for a pick takes the chip the way it takes an Items row.
function onChipClick(id: string) {
  const f = treePickWaiting() ? store.document.features.find((x) => x.id === id) : undefined;
  if (f) {
    routeTreeClick(featurePick(engine, f), { busyHint: () => null, hint: (t) => engine.setStatus(t, "") });
    return;
  }
  if (busyElsewhere()) return;
  timeline.select(id);
}
function onChipDblclick(id: string) {
  if (busyElsewhere() || treePickWaiting()) return;
  timeline.edit(id);
}
// --- renaming ------------------------------------------------------------
const renamingId = ref<string | null>(null);
function linkedPath(id: string): string | null {
  return (store.document.features.find((f) => f.id === id) as { link?: { path: string } } | undefined)?.link?.path ?? null;
}
function hasOwnName(id: string): boolean {
  return !!(store.document.features.find((f) => f.id === id) as { name?: string } | undefined)?.name;
}
function startRename(id: string) {
  renamingId.value = id;
  void nextTick(() => {
    const el = track.value?.querySelector<HTMLInputElement>(".t-rename");
    el?.focus();
    el?.select();
  });
}
function finishRename(e: Event, save: boolean) {
  const id = renamingId.value;
  if (!id) return;
  renamingId.value = null;
  if (save) store.renameFeature(id, (e.target as HTMLInputElement).value);
}
function onRenameKey(e: KeyboardEvent) {
  if (e.key !== "F2" || renamingId.value || !selection.featureId) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (!features.value.some((f) => f.id === selection.featureId)) return;
  e.preventDefault();
  startRename(selection.featureId);
}

let offEditPreview: (() => void) | null = null;
onMounted(() => {
  window.addEventListener("keydown", onRenameKey);
  offEditPreview = store.onEditPreview(() => { editTick.value++; });
});
onUnmounted(() => {
  window.removeEventListener("keydown", onRenameKey);
  offEditPreview?.();
});

// --- scrolling -----------------------------------------------------------
// The scroller is a persistent element and Vue patches the chips in place, so
// scroll position survives a re-render on its own, the old code had to save
// and restore it around `track.innerHTML = ""`. Only the follow-on-append
// behaviour is left to do explicitly.
watch(
  () => features.value.length,
  async (n, prev) => {
    if (prev === undefined || n <= prev) return;
    await nextTick();
    const el = scroller.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  },
);

// Dragging a chip near either edge auto-scrolls; a reorder across a long
// document is impossible otherwise.
function onDragOverScroller(e: DragEvent) {
  const el = scroller.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (e.clientY < r.top + 48) el.scrollTop -= 14;
  else if (e.clientY > r.bottom - 48) el.scrollTop += 14;
}

// --- reorder via native drag-and-drop ------------------------------------
const dragId = ref<string | null>(null);
const dropTarget = ref<string | null>(null);

function onDragStart(id: string, e: DragEvent) {
  dragId.value = id;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragOver(id: string, e: DragEvent) {
  if (dragId.value && dragId.value !== id) {
    e.preventDefault();
    dropTarget.value = id;
  }
}
function onDrop(id: string, i: number, e: DragEvent) {
  e.preventDefault();
  dropTarget.value = null;
  if (dragId.value && dragId.value !== id) store.moveFeature(dragId.value, i);
  dragId.value = null;
}

// --- error badge ---------------------------------------------------------
const errCycle = ref(0);
watch(
  () => errors.value.size,
  (n) => { if (n === 0) errCycle.value = 0; },
);

function jumpToNextError() {
  const ids = [...errors.value.keys()];
  if (!ids.length) return;
  const id = ids[errCycle.value % ids.length];
  if (id === undefined) return;
  errCycle.value++;
  track.value
    ?.querySelector<HTMLElement>(`.timeline-node[data-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  timeline.select(id);
}

// --- rollback marker (drag to roll the model back/forward) ---------------
// Stays imperative: it is a pointer drag resolved against measured chip rects.
function onMarkerDown(e: PointerEvent) {
  // The drawn marker sits on the edited step during an edit; it is not the saved
  // marker and must not be dragged. Finish or Escape first.
  if (editing.value) return;
  e.preventDefault();
  e.stopPropagation();
  const m = e.currentTarget as HTMLElement;
  m.classList.add("dragging");
  const move = (ev: PointerEvent) => m.style.setProperty("--x", `${ev.clientX}px`);
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    m.classList.remove("dragging");
    store.setRollback(gapIndexAt(ev));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Which inter-feature gap (0..n) the pointer falls into. The measuring is here;
 *  the arithmetic, including which axis the track runs along, since the history
 *  strip can be moved to the right-hand side, is in ui/trackGaps.ts. */
function gapIndexAt(ev: PointerEvent): number {
  const nodes = [...(track.value?.querySelectorAll<HTMLElement>(".timeline-node:not(.building)") ?? [])];
  return gapIndexIn(nodes.map((n) => n.getBoundingClientRect()), ev.clientX, ev.clientY);
}

// --- right-click context menu (shared engine in ui/menu.ts) --------------
function openMenu(e: MouseEvent, id: string, i: number) {
  e.preventDefault();
  // "Re-pick" only appears when THIS feature's last build reported an ambiguous
  // saved reference, offering it on a healthy feature would invite users to
  // overwrite references that are working.
  const repick = timeline.canRepick(id)
    ? [{ label: "Re-pick face…", onClick: () => timeline.repick(id) }]
    : [];
  contextMenu(e.clientX, e.clientY, [
    ...repick,
    { label: "Edit", onClick: () => timeline.edit(id) },
    { label: "Rename", shortcut: "F2", onClick: () => startRename(id) },
    ...(linkedPath(id)
      ? [
          { label: "Update from linked file", onClick: () => void import("../../io/fundaLinks").then((m) => m.refreshLink(store, engine.geometry, id)) },
          { label: "Unlink", onClick: () => void import("../../io/fundaLinks").then((m) => m.unlink(store, id)) },
        ]
      : []),
    ...(hasOwnName(id) ? [{ label: "Reset name", onClick: () => store.renameFeature(id, "") }] : []),
    {
      label: suppressed.value.has(id) ? "Unsuppress" : "Suppress",
      onClick: () => store.toggleSuppress(id),
    },
    // A sketch's values are edited in the sketch, not in the rows under its
    // chip, so it is offered only the removal of a condition the MCP wrote.
    ...(features.value[i]?.hasCondition
      ? [{ label: "Remove condition", onClick: () => store.removeFeatureField(id, "activeWhen") }]
      : features.value[i]?.type === "sketch"
        ? []
        : [{
            label: "Add condition",
            onClick: () => {
              store.updateFeature(id, { activeWhen: 1 } as unknown as Partial<Feature>);
              timeline.select(id);
            },
          }]),
    // setRollback(k) builds features[0..k-1], so k = i excludes this step (the
    // model as it was right BEFORE it ran) and k = i + 1 includes it (right
    // after it ran). "Roll to here" now means what it says: the state this step
    // produced. FI-7: it used to sit on setRollback(i), so rolling to a step
    // showed the model with that step itself missing.
    { label: "Roll back before this", onClick: () => store.setRollback(i) },
    { label: "Roll to here", onClick: () => store.setRollback(i + 1) },
    { separator: true, label: "" },
    { label: "Delete", danger: true, onClick: () => store.removeFeature(id) },
  ]);
}
</script>

<template>
  <section id="timeline" class="timeline-shell float-card" aria-label="History">
    <div class="float-card-head">
      <span class="float-card-title">History</span>
      <button
        v-if="related"
        class="timeline-related"
        :class="{ on: relatedOn }"
        data-testid="history-related"
        :title="relatedOn ? 'Showing what relates to the selection, click to show everything' : 'Show only what relates to the selection'"
        @click="toggleRelated()"
      >Related to Selection · {{ related.size }}</button>
      <button
        class="timeline-errbadge"
        :class="{ hidden: errors.size === 0 }"
        title="Failing features, click to jump to the next one"
        @click="jumpToNextError()"
      ><Icon name="warning" :size="14" /> {{ errors.size }}</button>
      <button class="float-card-close" title="Hide the history (Ctrl Alt H)" @click="shellStore.setHistory(false)"><Icon name="close" :size="14" /></button>
    </div>
    <!-- Transport moves the SAVED marker (docRollback), and stands down while a
         feature is being edited: the drawn marker is on the edited step then, and
         scrubbing out from under a live edit is the "bugs out" case. -->
    <div class="timeline-transport">
      <button class="tl-btn" title="Roll back to the start" :disabled="editing || docRollback <= 0" @click="store.setRollback(0)"><Icon name="skipStart" /></button>
      <button class="tl-btn" title="Step one feature back" :disabled="editing || docRollback <= 0" @click="store.setRollback(Math.max(0, docRollback - 1))"><Icon name="stepBack" /></button>
      <button class="tl-btn" title="Step one feature forward" :disabled="editing || docRollback >= features.length" @click="store.setRollback(Math.min(features.length, docRollback + 1))"><Icon name="stepForward" /></button>
      <button class="tl-btn" title="Roll forward to the end" :disabled="editing || docRollback >= features.length" @click="store.setRollback(features.length)"><Icon name="skipEnd" /></button>
    </div>

    <div ref="scroller" class="timeline-scroll" @dragover="onDragOverScroller">
      <div ref="track" class="timeline-track">
        <div v-if="showEmpty" class="timeline-empty">
          Your modeling history will appear here. Start with a Sketch.
        </div>
        <template v-else>
          <template v-for="(f, i) in features" :key="f.id">
            <div
              v-if="i === rollback"
              class="timeline-marker"
              title="Drag to roll the model back / forward"
              @pointerdown="onMarkerDown"
            ><span class="marker-grip"></span></div>
            <div v-show="!filtering || related?.has(f.id)" class="timeline-item" :data-feature="f.id">
              <div
                class="timeline-node"
                :data-id="f.id"
                :class="{
                  selected: selection.featureId === f.id,
                  error: errors.has(f.id),
                  // amber only where there is no red: the build SUCCEEDED, so
                  // the chip must not read as a failure. `notes` already drops
                  // every failing feature; the `&&` is the second lock.
                  warn: !errors.has(f.id) && notes.has(f.id),
                  rolled: i >= rollback,
                  suppressed: suppressed.has(f.id) || f.inactive,
                  'drop-target': dropTarget === f.id,
                }"
                :title="chipTitle(f, i)"
                draggable="true"
                @click="onChipClick(f.id)"
                @dblclick="onChipDblclick(f.id)"
                @contextmenu="openMenu($event, f.id, i)"
                @dragstart="onDragStart(f.id, $event)"
                @dragover="onDragOver(f.id, $event)"
                @dragleave="dropTarget = null"
                @drop="onDrop(f.id, i, $event)"
              >
                <span class="glyph"><Icon :name="metaFor(f).icon" :size="18" /></span>
                <input
                  v-if="renamingId === f.id"
                  class="t-rename"
                  :value="f.name || metaFor(f).label"
                  :placeholder="metaFor(f).label"
                  spellcheck="false"
                  @click.stop
                  @dblclick.stop
                  @pointerdown.stop
                  @keydown.stop="$event.key === 'Enter' ? finishRename($event, true) : $event.key === 'Escape' ? finishRename($event, false) : undefined"
                  @blur="finishRename($event, true)"
                />
                <span v-else class="t-name">{{ f.name || metaFor(f).label }}</span>
                <Icon class="t-caret" :name="selection.featureId === f.id ? 'caretDown' : 'caretRight'" :size="12" />
              </div>
              <!-- The feature's own values, under the chip you clicked. The
                   point of putting them HERE rather than in a docked panel is
                   that the history already says which operation you are
                   changing, so the form does not have to. -->
              <div v-if="selection.featureId === f.id" class="timeline-props">
                <FeatureProperties :feature-id="f.id" :unit="unit" />
              </div>
            </div>
          </template>
          <div
            v-if="rollback >= features.length"
            class="timeline-marker"
            title="Drag to roll the model back / forward"
            @pointerdown="onMarkerDown"
          ><span class="marker-grip"></span></div>

          <div v-if="building" class="timeline-node building">
            <span class="t-build">{{ chip.label }}</span>
            <span class="t-bar"><i :style="{ width: `${chip.pct}%` }"></i></span>
          </div>
        </template>
      </div>
    </div>

    <!-- Cancel and the busy label are SIBLINGS of the track, never inside it.
         That mattered structurally before (a button detached between mousedown
         and mouseup fires no click at all, so one press in eight was swallowed
         by the once-a-second re-render); Vue patches in place, so the hazard is
         gone, but keeping them out here also keeps focus and the CSS. -->
    <div class="timeline-busy" :class="{ hidden: !showCancel }">{{ busyText }}</div>
    <button
      class="timeline-cancel"
      :class="{ hidden: !showCancel }"
      :disabled="cancelling"
      :title="busy.waiting ? 'Withdraw this request, the job it waits on carries on' : busy.label || 'Stop the running operation'"
      @click="cancelBusy()"
    >Cancel</button>

  </section>
</template>
