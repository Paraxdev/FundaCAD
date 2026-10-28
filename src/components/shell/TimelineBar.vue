<script setup lang="ts">
import { fmtKeys } from "../../input/platform";
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue, useBuildValue } from "../../app/useDoc";
import { pickedFeatureCount, useSelectionStore } from "../../stores/selection";
import { useTimelineStore } from "../../stores/timeline";
import { useShellStore } from "../../stores/shell";
import { featureMeta, stepName } from "../../ui/featureMeta";
import Icon from "./Icon.vue";
import Button from "../ui/Button.vue";
import Chip from "../ui/Chip.vue";
import IconButton from "../ui/IconButton.vue";
import TextField from "../ui/TextField.vue";
import { contextMenu } from "../../ui/menu";
import {
  buildProgress,
  busyLine,
  CANCEL_DELAY_MS,
  historyShowsBusy,
  historyShowsEmpty,
  runningRows,
} from "../../ui/buildProgress";
import { featureFailures, featureNotes, featurePlaceholders, placeholderNote } from "../../ui/featureNotes";
import { gapIndexIn } from "../../ui/trackGaps";
import { getUnit, onUnitChange } from "../../ui/units";
import FeatureProperties from "./FeatureProperties.vue";
import { useSelectionOffers } from "../../composables/useSelectionOffers";
import { relatedFeatureIds } from "../../ui/relatedFeatures";
import { routeTreeClick, treePickWaiting } from "../../ui/treePick";
import { featurePick } from "../../app/featurePick";
import { closeOpenEdit } from "../../app/selection";
import { clickFeatureRow, deleteRows, rowTargets, toggleSuppressRows } from "../../app/featureRows";
import type { Feature } from "../../types";

const engine = useEngine();
const store = engine.store;
const selection = useSelectionStore();
const timeline = useTimelineStore();
const shellStore = useShellStore();

const scroller = useTemplateRef<HTMLElement>("scroller");
const track = useTemplateRef<HTMLElement>("track");

// Cast because `name` is only on some feature variants.
const features = useDocValue((doc) =>
  doc.features.map((f) => {
    const activeWhen = (f as { activeWhen?: unknown }).activeWhen;
    return {
      id: f.id,
      type: f.type,
      name: (f as { name?: string }).name ?? "",
      shown: stepName(f as Parameters<typeof stepName>[0]),
      hasCondition: activeWhen !== undefined,
      inactive: activeWhen === 0,
    };
  }),
);

// The selection lives on the non-reactive viewport and overlay, the offers composable watches both and bumps `counts`.
const selectionOffers = useSelectionOffers(engine);
const RELATED_KEY = "fundacad.historyRelated";
const relatedOn = ref(
  (() => {
    try {
      return localStorage.getItem(RELATED_KEY) !== "0";
    } catch {
      return true;
    }
  })(),
);
function toggleRelated() {
  relatedOn.value = !relatedOn.value;
  try {
    localStorage.setItem(RELATED_KEY, relatedOn.value ? "1" : "0");
  } catch {
    /* not remembered */
  }
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

/** The chips as drawn, which a Shift-click run is measured over. */
const shownIds = computed(() =>
  features.value.filter((f) => !filtering.value || related.value?.has(f.id)).map((f) => f.id),
);
const picked = computed(() => new Set(selection.rows.keys));
// Values show under the one chip the inspector follows, several picked chips have no single set of values.
const several = computed(() => pickedFeatureCount(selection.rows, features.value) > 1);
const isPicked = (id: string) => picked.value.has(id) || selection.featureId === id;

const unit = ref(getUnit());
const offUnit = onUnitChange(() => {
  unit.value = getUnit();
});
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
// The marker as drawn: during an edit it drops onto the edited feature, the preview's rollback point. The saved
// marker (docRollback) stays put, and finishing the edit springs the drawn one back.
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
const errors = useBuildValue((b) => featureFailures({ ...b, featureErrors: b.result?.featureErrors }));
/** Features that built but had something to say: id -> reason. The rule is in ui/featureNotes.ts. */
const notes = useBuildValue((b) =>
  featureNotes({
    featureErrors: b.result?.featureErrors,
    errorFeatureId: b.errorFeatureId,
    diagnostics: b.result?.diagnostics,
  }),
);
/** Features the build left out because this version does not know their type. */
const placeholders = useBuildValue((b) => featurePlaceholders({ skippedFeatures: b.result?.skippedFeatures }));
const building = useBuildValue((b) => b.building);
const progress = useBuildValue((b) => ({
  phase: b.phase,
  progress: b.progress,
  meshed: b.meshed,
  meshTotal: b.meshTotal,
}));

// Busy is timed from the transition, not each emission: an op emits busy frames throughout, and re-arming would never
// elapse. The delay keeps a fast op from flashing a button.
const busy = engine.bridge.busy;
const ops = engine.bridge.ops;
const rows = computed(() => runningRows(ops.value));
const busySince = ref(0);
const delayElapsed = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

watch(
  busy,
  (b) => {
    if (!b.active) {
      busySince.value = 0;
      delayElapsed.value = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return;
    }
    if (busySince.value) return; // already timing this op
    busySince.value = Date.now();
    timer = setTimeout(() => {
      delayElapsed.value = true;
    }, CANCEL_DELAY_MS);
  },
  { immediate: true },
);
onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

const chip = computed(() =>
  busy.value.waiting
    ? { label: "waiting…", pct: 0 }
    : buildProgress(
        progress.value,
        features.value.map((f) => f.shown),
      ),
);
const line = computed(() => busyLine(busy.value));

// Cancel is not instant (the engine kills the worker and spawns a fresh one), so the button disables in flight.
const cancelling = ref(false);
async function cancelBusy() {
  cancelling.value = true;
  try {
    await store.cancelBusy();
  } finally {
    cancelling.value = false;
  }
}

// An import into an empty document is the most common long op, without the busy check the empty hint shows for 90+ s.
const showEmpty = computed(() => historyShowsEmpty(features.value.length, ops.value));
const showCancel = computed(() => delayElapsed.value && historyShowsBusy(features.value.length, busy.value, ops.value));

// Chips read the whole feature, not the type: a boolean is named after its operation (ui/featureMeta.ts). Unknown types
// still render, a newer document would otherwise throw mid-draw and make File, Open silently do nothing.
function metaFor(f: { type: string; operation?: unknown }) {
  return featureMeta(f);
}

function chipTitle(f: { id: string; type: string; name?: string; shown?: string; inactive?: boolean }, i: number) {
  const err = errors.value.get(f.id);
  const note = notes.value.get(f.id);
  const placeholder = placeholders.value.get(f.id);
  return (
    `${i + 1} · ${metaFor(f).label}` +
    (f.type === "import" && f.name && f.shown !== f.name ? `\nFile: ${f.name}` : "") +
    (f.inactive ? "\nSwitched off: its Active when condition is 0" : "") +
    (placeholder !== undefined ? `\n${placeholderNote(placeholder)}` : "") +
    // A plain word, not a warning sign: the OS tooltip font may lack the symbol. Failed and Note never both apply, notes
    // skips a failed feature.
    (err ? `\nFailed: ${err}` : note ? `\nNote: ${note}` : "") +
    (placeholder !== undefined
      ? "\nclick to select · right-click for more"
      : "\nclick to select · double-click to edit, Esc to go back · right-click for more")
  );
}

// A click selects a step without moving the model, a double-click edits it with the model rolled back to just before
// it. Both are ignored while a tool owns the screen, except a double-click, which closes the other edit first.
function busyElsewhere(): boolean {
  return engine.toolBusy() || engine.sketch.active;
}
// A tool waiting for a pick takes the chip the way it takes an Items row.
function onChipClick(id: string, ev: MouseEvent) {
  const f = treePickWaiting() ? store.document.features.find((x) => x.id === id) : undefined;
  if (f) {
    routeTreeClick(featurePick(engine, f), { busyHint: () => null, hint: (t) => engine.setStatus(t, "") });
    return;
  }
  if (busyElsewhere()) return;
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey) clickFeatureRow(engine, shownIds.value, id, ev);
  // A plain click on the open chip folds it, but not the second click of a double-click, which goes on to edit.
  else if (ev.detail < 2 && selection.featureId === id && !several.value) timeline.select(null);
  else timeline.select(id);
}
/** A Shift-click takes a run of chips, so the browser's text selection across the labels is suppressed. */
function onChipMouseDown(ev: MouseEvent) {
  if (ev.shiftKey && !(ev.target as HTMLElement | null)?.closest?.("input")) ev.preventDefault();
}
function onChipDblclick(id: string) {
  if (treePickWaiting()) return;
  closeOpenEdit(engine, id);
  if (busyElsewhere()) return;
  timeline.edit(id);
}
const renamingId = ref<string | null>(null);
function linkedPath(id: string): string | null {
  return (
    (store.document.features.find((f) => f.id === id) as { link?: { path: string } } | undefined)?.link?.path ?? null
  );
}
function hasOwnName(id: string): boolean {
  return !!(store.document.features.find((f) => f.id === id) as { name?: string } | undefined)?.name;
}
// One save per edit, as in InlineLabel: the blur of a field that is closing commits again and falls out here.
let renameOpenId: string | null = null;
function startRename(id: string) {
  renamingId.value = id;
  renameOpenId = id;
  void nextTick(() => track.value?.querySelector<HTMLInputElement>(".t-rename input")?.focus());
}
// The field commits on Enter and blur and reverts on Escape before these run, they only close it.
function saveRename(name: string) {
  const id = renameOpenId;
  renameOpenId = null;
  if (id) store.renameFeature(id, name);
}
function onRenameFieldKey(e: KeyboardEvent) {
  if (e.key !== "Enter" && e.key !== "Escape") return;
  e.preventDefault();
  renameOpenId = null;
  renamingId.value = null;
}
function onRenameKey(e: KeyboardEvent) {
  if (e.key !== "F2" || renamingId.value || !selection.featureId || several.value) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (!features.value.some((f) => f.id === selection.featureId)) return;
  e.preventDefault();
  startRename(selection.featureId);
}

let offEditPreview: (() => void) | null = null;
onMounted(() => {
  window.addEventListener("keydown", onRenameKey);
  offEditPreview = store.onEditPreview(() => {
    editTick.value++;
  });
});
onUnmounted(() => {
  window.removeEventListener("keydown", onRenameKey);
  offEditPreview?.();
});

// Scroll position survives a re-render since Vue patches chips in place, only follow-on-append is explicit.
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

const errCycle = ref(0);
watch(
  () => errors.value.size,
  (n) => {
    if (n === 0) errCycle.value = 0;
  },
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

// The rollback marker drag stays imperative: it resolves a pointer against measured chip rects.
function onMarkerDown(e: PointerEvent) {
  // The drawn marker sits on the edited step during an edit; it is not the saved
  // marker and must not be dragged. Finish or Escape first.
  if (editing.value) return;
  e.preventDefault();
  e.stopPropagation();
  const m = e.currentTarget as HTMLElement;
  m.classList.add("dragging");
  const move = (ev: PointerEvent) => m.style.setProperty("--x", `${ev.clientX}px`);
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    m.classList.remove("dragging");
  };
  const up = (ev: PointerEvent) => {
    end();
    store.setRollback(gapIndexAt(ev));
  };
  // A cancelled pointer (a touch taken as a gesture, a pen out of range) gets no pointerup, so listeners would linger.
  // A cancel is not a drop, the marker stays.
  const cancel = () => end();
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}

/** Which gap (0..n) the pointer falls into. The arithmetic, including the track's axis (the strip can sit on the
 *  right), is in ui/trackGaps.ts. */
function gapIndexAt(ev: PointerEvent): number {
  const nodes = [...(track.value?.querySelectorAll<HTMLElement>(".timeline-node:not(.building)") ?? [])];
  return gapIndexIn(
    nodes.map((n) => n.getBoundingClientRect()),
    ev.clientX,
    ev.clientY,
  );
}

function openMenu(e: MouseEvent, id: string, i: number) {
  e.preventDefault();
  const targets = rowTargets(id, features.value);
  if (targets.length > 1) {
    openMultiMenu(e, targets);
    return;
  }
  // Re-pick only when this feature's last build reported an ambiguous saved reference, offering it on a healthy one
  // invites overwriting working references.
  const repick = timeline.canRepick(id) ? [{ label: "Re-pick face…", onClick: () => timeline.repick(id) }] : [];
  contextMenu(e.clientX, e.clientY, [
    ...repick,
    ...(placeholders.value.has(id) ? [] : [{ label: "Edit", onClick: () => timeline.edit(id) }]),
    { label: "Rename", shortcut: "F2", onClick: () => startRename(id) },
    ...(linkedPath(id)
      ? [
          {
            label: "Update from linked file",
            onClick: () => void import("../../io/fundaLinks").then((m) => m.refreshLink(store, engine.geometry, id)),
          },
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
        : [
            {
              label: "Add condition",
              onClick: () => {
                store.updateFeature(id, { activeWhen: 1 } as unknown as Partial<Feature>);
                timeline.select(id);
              },
            },
          ]),
    // setRollback(k) builds features[0..k-1], so k = i is the model just before this step and k = i + 1 just after (FI-7).
    { label: "Roll back before this", onClick: () => store.setRollback(i) },
    { label: "Roll to here", onClick: () => store.setRollback(i + 1) },
    { separator: true, label: "" },
    { label: "Delete", danger: true, onClick: () => deleteRows(engine, [id]) },
  ]);
}

/** Several chips picked: what makes sense on all of them, and the single-feature items shown off with the reason. */
function openMultiMenu(e: MouseEvent, ids: string[]) {
  const n = ids.length;
  const allOff = ids.every((x) => suppressed.value.has(x));
  contextMenu(e.clientX, e.clientY, [
    { label: "Edit (select one feature)", disabled: true },
    { label: "Rename (select one feature)", disabled: true },
    { label: allOff ? `Unsuppress these ${n}` : `Suppress these ${n}`, onClick: () => toggleSuppressRows(store, ids) },
    { label: "Roll back before this (select one feature)", disabled: true },
    { separator: true, label: "" },
    { label: `Delete these ${n}`, danger: true, onClick: () => deleteRows(engine, ids) },
  ]);
}
</script>

<template>
  <section id="timeline" class="timeline-shell float-card" aria-label="History">
    <div class="float-card-head">
      <span class="float-card-title">History</span>
      <Chip
        v-if="related"
        as="button"
        class="timeline-related"
        :class="{ on: relatedOn }"
        :variant="relatedOn ? 'accent' : 'neutral'"
        data-testid="history-related"
        :tip="
          relatedOn
            ? 'Showing what relates to the selection, click to show everything'
            : 'Show only what relates to the selection'
        "
        :aria-label="`Related to Selection, ${related.size}`"
        :aria-pressed="relatedOn"
        @click="toggleRelated()"
        >Related to Selection · {{ related.size }}</Chip
      >
      <Chip
        as="button"
        variant="error"
        icon="warning"
        class="timeline-errbadge"
        :class="{ hidden: errors.size === 0 }"
        tip="Failing features, click to jump to the next one"
        :aria-label="`${errors.size} failing feature${errors.size === 1 ? '' : 's'}, click to jump to the next one`"
        @click="jumpToNextError()"
        >{{ errors.size }}</Chip
      >
      <IconButton
        class="float-card-close"
        icon="close"
        size="md"
        variant="plain"
        :icon-size="14"
        :tip="fmtKeys('Hide the history (Ctrl+Alt+H)')"
        @click="shellStore.setHistory(false)"
      />
    </div>
    <!-- Transport moves the saved marker and stands down during an edit, the drawn marker is on the edited step then. -->
    <div class="timeline-transport">
      <IconButton
        class="tl-btn"
        icon="skipStart"
        size="sm"
        variant="plain"
        tip="Roll back to the start"
        :disabled="editing || docRollback <= 0"
        @click="store.setRollback(0)"
      />
      <IconButton
        class="tl-btn"
        icon="stepBack"
        size="sm"
        variant="plain"
        tip="Step one feature back"
        :disabled="editing || docRollback <= 0"
        @click="store.setRollback(Math.max(0, docRollback - 1))"
      />
      <IconButton
        class="tl-btn"
        icon="stepForward"
        size="sm"
        variant="plain"
        tip="Step one feature forward"
        :disabled="editing || docRollback >= features.length"
        @click="store.setRollback(Math.min(features.length, docRollback + 1))"
      />
      <IconButton
        class="tl-btn"
        icon="skipEnd"
        size="sm"
        variant="plain"
        tip="Roll forward to the end"
        :disabled="editing || docRollback >= features.length"
        @click="store.setRollback(features.length)"
      />
    </div>

    <div ref="scroller" class="timeline-scroll" @dragover="onDragOverScroller">
      <div ref="track" class="timeline-track">
        <div v-if="showEmpty" class="timeline-empty">
          Your modeling history will appear here. Start with a Sketch, or drop a STEP, STL or 3MF file.
        </div>
        <template v-else>
          <template v-for="(f, i) in features" :key="f.id">
            <div
              v-if="i === rollback"
              class="timeline-marker"
              title="Drag to roll the model back / forward"
              @pointerdown="onMarkerDown"
              ><span class="marker-grip"></span
            ></div>
            <div v-show="!filtering || related?.has(f.id)" class="timeline-item" :data-feature="f.id">
              <div
                class="timeline-node"
                :data-id="f.id"
                :class="{
                  selected: isPicked(f.id),
                  error: errors.has(f.id),
                  // amber only where there is no red: the build SUCCEEDED, so
                  // the chip must not read as a failure. `notes` already drops
                  // every failing feature; the `&&` is the second lock.
                  warn: !errors.has(f.id) && notes.has(f.id),
                  rolled: i >= rollback,
                  suppressed: suppressed.has(f.id) || f.inactive,
                  placeholder: placeholders.has(f.id),
                  'drop-target': dropTarget === f.id,
                }"
                :title="chipTitle(f, i)"
                draggable="true"
                @mousedown="onChipMouseDown"
                @click="onChipClick(f.id, $event)"
                @dblclick="onChipDblclick(f.id)"
                @contextmenu="openMenu($event, f.id, i)"
                @dragstart="onDragStart(f.id, $event)"
                @dragover="onDragOver(f.id, $event)"
                @dragleave="dropTarget = null"
                @drop="onDrop(f.id, i, $event)"
              >
                <span class="glyph"><Icon :name="metaFor(f).icon" :size="18" /></span>
                <!-- display: contents, so a press on the well's padding stays out of the chip as one on the text does -->
                <span
                  v-if="renamingId === f.id"
                  class="t-rename-hold"
                  @click.stop
                  @dblclick.stop
                  @pointerdown.stop
                  @keydown.stop="onRenameFieldKey"
                >
                  <TextField
                    class="t-rename"
                    size="sm"
                    commit="change"
                    select-on-focus
                    aria-label="Rename"
                    :model-value="f.name || metaFor(f).label"
                    :placeholder="metaFor(f).label"
                    spellcheck="false"
                    @update:model-value="saveRename"
                    @blur="renamingId = null"
                  />
                </span>
                <span v-else class="t-name">{{ f.shown }}</span>
                <Icon
                  class="t-caret"
                  :name="selection.featureId === f.id && !several ? 'caretDown' : 'caretRight'"
                  :size="12"
                />
              </div>
              <!-- The values sit under the clicked chip, so the history already names the operation and the form need not. -->
              <div v-if="selection.featureId === f.id && !several" class="timeline-props">
                <FeatureProperties :feature-id="f.id" :unit="unit" />
              </div>
            </div>
          </template>
          <div
            v-if="rollback >= features.length"
            class="timeline-marker"
            title="Drag to roll the model back / forward"
            @pointerdown="onMarkerDown"
            ><span class="marker-grip"></span
          ></div>

          <!-- An import shows here from the moment it starts, not only once its file is read. -->
          <div v-for="op in rows" :key="op.key" class="timeline-node running" :data-op="op.key">
            <span class="t-build" :title="op.label">{{ op.stage ? `${op.label}, ${op.stage}` : op.label }}</span>
            <Button
              class="t-op-cancel"
              variant="ghost"
              size="sm"
              :tip="`Stop ${op.label}`"
              @click="store.cancelRunningOp(op.key)"
              >Cancel</Button
            >
          </div>
          <div v-if="building" class="timeline-node building">
            <span class="t-build">{{ chip.label }}</span>
            <span class="t-bar"><i :style="{ width: `${chip.pct}%` }"></i></span>
          </div>
        </template>
      </div>
    </div>

    <!-- Cancel and the busy label are siblings of the track, which keeps their focus and CSS out of its re-renders. -->
    <div class="timeline-busy" :class="{ hidden: !showCancel }">
      <span class="busy-text" :title="line.text">{{ line.text }}</span>
      <template v-if="line.bar">
        <span class="busy-stage">{{ line.detail }}</span>
        <span
          class="busy-bar"
          :class="{ indeterminate: line.pct === null }"
          role="progressbar"
          :aria-valuenow="line.pct ?? undefined"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="line.detail ?? undefined"
          ><i :style="line.pct === null ? undefined : { width: `${line.pct}%` }"></i
        ></span>
      </template>
    </div>
    <Button
      class="timeline-cancel"
      :class="{ hidden: !showCancel }"
      variant="danger"
      size="sm"
      :disabled="cancelling"
      :tip="
        busy.waiting
          ? 'Withdraw this request, the job it waits on carries on'
          : busy.label || 'Stop the running operation'
      "
      @click="cancelBusy()"
      >Cancel</Button
    >
  </section>
</template>
