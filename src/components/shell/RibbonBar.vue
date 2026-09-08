<script setup lang="ts">
// MCAD-style icon ribbon. Two contexts, modeling and sketch, each a row of
// grouped icon buttons (CREATE / MODIFY / …) with the group name underneath.
// The sketch context ends with the green Finish Sketch + a Sketch Palette toggle.

import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useRibbonStore } from "../../stores/ribbon";
import { modelGroups, SKETCH, PINNED, priorityOf, leavesOf } from "../../ui/ribbonDefs";
import { onContribChange } from "../../plugins/contrib";
import type { Group, Item, RibbonContext, ToolItem } from "../../ui/ribbonDefs";
import Icon from "./Icon.vue";
import RibbonPopup from "./RibbonPopup.vue";
import { layoutPrefs, onLayoutPrefsChange } from "../../ui/layoutPrefs";
import { HOLD_MS, IDLE, holdStep, type HoldEvent, type HoldPhase } from "../../ui/holdGesture";

const ribbon = useRibbonStore();
// Two elements, two jobs, exactly as the class had them: the ResizeObserver
// watches #ribbon (the container that actually changes size with the window),
// while the packing measures .ribbon-context, #ribbon is an overflow-x:auto
// scroller, so once the tools no longer fit, its clientWidth is the VIEWPORT
// width, not the row's.
const root = useTemplateRef<HTMLElement>("root");
const ctx = useTemplateRef<HTMLElement>("ctx");

// The sketch context's two pinned groups live outside the SKETCH table because
// they are chrome, not tools, a spacer pushes them to the right-hand end.
const PALETTE_GROUP: Group = {
  label: "PALETTE",
  items: [{ action: "palette", label: "Sketch Palette", iconName: "palette", kind: "toggle" }],
};
const FINISH_GROUP: Group = {
  label: "FINISH",
  items: [{ action: "finish", label: "Finish Sketch", iconName: "check", kind: "finish" }],
};

// Bumped when a capability is turned on or off, so the model ribbon redraws
// without the toggle having to know the ribbon exists. The plugin registry is
// deliberately Vue-free, which is what lets the headless suite reach it, so a
// mirror ref is how its changes become reactive here.
const pluginTick = ref(0);
let offPlugins: (() => void) | null = null;
onMounted(() => { offPlugins = onContribChange(() => pluginTick.value++); });
onUnmounted(() => offPlugins?.());

const groups = computed<Group[]>(() => {
  pluginTick.value; // dependency
  return ribbon.context === "sketch" ? [...SKETCH, PALETTE_GROUP, FINISH_GROUP] : modelGroups();
});

// PINNED first: a pinned group never collapses, whoever owns it. Everything
// else asks ribbonDefs, which knows the app's own order AND what a plugin
// asked for when it contributed a group of its own.
const collapsePriority = (label: string) => (PINNED.has(label) ? Infinity : priorityOf(label));

// --- split buttons: last-used-wins primary -------------------------------
// Keyed by the split's label, so a primary chosen in one context survives a
// trip through the other. setActiveSketchTool ALSO writes here: arming a
// constraint from the keymap has to put it on the button face, or the .active
// highlight below would have nothing to land on.
const primaryOf = ref<Record<string, string>>({});

function primaryTool(it: Item & { children: ToolItem[] }): ToolItem {
  const chosen = primaryOf.value[it.label];
  return (chosen && it.children.find((c) => c.action === chosen)) || it.children[0]!;
}

watch(
  () => ribbon.activeSketchTool,
  (tool) => {
    if (!tool) return;
    for (const g of SKETCH) {
      for (const it of g.items) {
        if ("children" in it && it.children.some((c) => c.action === tool)) {
          primaryOf.value = { ...primaryOf.value, [it.label]: tool };
        }
      }
    }
  },
);

// --- overflow packing ----------------------------------------------------
// Natural group sizes ALONG THE BAR, measured with every group shown, cached
// per context. Re-measuring on each reflow would mean un-collapsing, awaiting a
// frame and re-collapsing, a visible flicker during a resize drag. The sizes
// only change when the context, the font, the zoom or the bar's axis changes,
// none of which is a container resize, so the cache is invalidated on those.
const naturalWidths = new Map<RibbonContext, number[]>();
const collapsedLabels = ref<Set<string>>(new Set());

// Which way the bar runs (ui/layoutPrefs.ts). Everything below is written in
// terms of "along the bar" rather than "wide", because a side ribbon overflows
// DOWNWARD: measuring widths there compares each full-width group against a
// column of its own width and collapses almost all of them into the ⋯ button.
const vertical = ref(layoutPrefs().ribbon === "left");

function measure(): number[] {
  const el = ctx.value;
  if (!el) return [];
  const along = (g: HTMLElement) => (vertical.value ? g.offsetHeight : g.offsetWidth);
  return [...el.querySelectorAll<HTMLElement>(".ribbon-group")].map(along);
}

async function naturalFor(context: RibbonContext): Promise<number[]> {
  const cached = naturalWidths.get(context);
  if (cached?.length) return cached;
  // Measure with nothing collapsed, the one frame we cannot avoid, paid once
  // per context rather than once per resize event.
  const had = collapsedLabels.value;
  if (had.size) {
    collapsedLabels.value = new Set();
    await nextTick();
  }
  const w = measure();
  if (w.length) naturalWidths.set(context, w);
  return w;
}

async function reflow() {
  const el = ctx.value;
  if (!el) return;
  const list = groups.value;
  const widths = await naturalFor(ribbon.context);
  if (widths.length !== list.length) return; // mid-swap; the context watcher re-runs it

  const available = (vertical.value ? el.clientHeight : el.clientWidth) - 12;
  let total = widths.reduce((a, b) => a + b, 0);
  if (total <= available) {
    collapsedLabels.value = new Set();
    closePopup();
    return;
  }
  total += 40; // reserve the overflow button

  // low priority first, then rightmost, same order the class used
  const order = list
    .map((g, i) => ({ g, i }))
    .filter((x) => !PINNED.has(x.g.label))
    .sort((a, b) => collapsePriority(a.g.label) - collapsePriority(b.g.label) || b.i - a.i);

  const next = new Set<string>();
  for (const { g, i } of order) {
    if (total <= available) break;
    const w = widths[i];
    if (w === undefined) continue;
    next.add(g.label);
    total -= w;
  }
  collapsedLabels.value = next;
  // A reflow moves or hides split-arrow anchors, so a split dropdown would be
  // pointing at nothing. The overflow popup is fine, its contents are derived.
  if (popup.value?.kind === "split") closePopup();
}

const collapsedGroups = computed(() =>
  groups.value
    .filter((g) => collapsedLabels.value.has(g.label))
    // split buttons flatten: every child tool stays reachable from the overflow
    .map((g) => ({ label: g.label, items: g.items.flatMap(leavesOf) })),
);

let ro: ResizeObserver | null = null;
let offLayout: (() => void) | null = null;
onMounted(() => {
  ro = new ResizeObserver(() => void reflow());
  if (root.value) ro.observe(root.value);
  // Turning the bar on its side changes which dimension the cached sizes are,
  // so they have to go, a column of heights compared against a row's width
  // collapses everything. The ResizeObserver fires too, but only after the
  // layout settles, and it would reflow against the stale cache first.
  offLayout = onLayoutPrefsChange(async () => {
    const next = layoutPrefs().ribbon === "left";
    if (next === vertical.value) return; // the history side moved, not ours
    vertical.value = next;
    naturalWidths.clear();
    collapsedLabels.value = new Set();
    closePopup();
    await nextTick();
    void reflow();
  });
  void reflow();
  window.addEventListener("pointerup", onWindowUp, true);
  window.addEventListener("pointercancel", onWindowCancel, true);
  window.addEventListener("blur", onWindowCancel);
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  ro?.disconnect();
  offLayout?.();
  clearHoldTimer();
  window.removeEventListener("pointerup", onWindowUp, true);
  window.removeEventListener("pointercancel", onWindowCancel, true);
  window.removeEventListener("blur", onWindowCancel);
  window.removeEventListener("keydown", onKey);
});

// A context switch swaps the whole group list, so the cache key changes and the
// packing has to be redone against the new set.
watch(
  () => ribbon.context,
  async () => {
    closePopup();
    collapsedLabels.value = new Set();
    await nextTick();
    void reflow();
  },
);

// --- popups --------------------------------------------------------------
// At most one is open, which is what the class's single overflowPopup field
// enforced. `anchor` is the element it hangs off, for positioning and for
// letting a second click on the same button toggle it shut.
const popup = shallowRef<
  | { kind: "overflow"; anchor: HTMLElement }
  | { kind: "split"; anchor: HTMLElement; label: string; items: ToolItem[] }
  | null
>(null);

const overflowBtn = useTemplateRef<HTMLButtonElement>("overflowBtn");

function closePopup() {
  popup.value = null;
}

function toggleOverflow() {
  const wasOpen = popup.value?.kind === "overflow";
  closePopup();
  if (!wasOpen && overflowBtn.value) popup.value = { kind: "overflow", anchor: overflowBtn.value };
}

function toggleSplit(ev: MouseEvent, it: Item & { children: ToolItem[] }) {
  const anchor = ev.currentTarget as HTMLElement;
  const wasMine = popup.value?.kind === "split" && popup.value.anchor === anchor;
  closePopup();
  if (wasMine) return; // second click on the same arrow just closes
  popup.value = { kind: "split", anchor, label: it.label, items: it.children };
}

// --- press and hold the face to open the family --------------------------
// The caret is a small target and knowing it is there is half the trick, so the
// button face carries the same list on a press-and-hold, and on a right-click
// for anyone who already knows. The rules are ui/holdGesture.ts, which has no
// DOM in it; what lives here is the timer, the element under the pointer at
// release, and the dispatch.

const hold = shallowRef<HoldPhase>(IDLE);
let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** A primary button is down on a split face, so the next release belongs to this
 *  gesture. Not the same as "the machine is busy": a right-click opens the list
 *  with nothing held, and there the rows are picked by an ordinary click, which
 *  arrives as a `click` on the row. Consuming that release here as well would
 *  run the tool twice. */
let pressDown = false;
/** The button faces, by split label, so an `open` effect knows what to hang the
 *  popup off without the gesture layer being handed elements. */
const splitFaces = new Map<string, HTMLElement>();

function clearHoldTimer() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
}

function sendHold(ev: HoldEvent) {
  const { next, effect } = holdStep(hold.value, ev);
  hold.value = next;
  if (next.phase !== "pressing") clearHoldTimer();
  if (next.phase === "idle") pressDown = false;
  const list = (id: string) =>
    groups.value.flatMap((g) => g.items).find((it) => "children" in it && it.label === id);
  switch (effect.kind) {
    case "open": {
      const anchor = splitFaces.get(effect.groupId);
      const it = list(effect.groupId);
      if (anchor && it && "children" in it) {
        popup.value = { kind: "split", anchor, label: effect.groupId, items: it.children };
      }
      break;
    }
    case "close":
      closePopup();
      break;
    case "runDefault": {
      const it = list(effect.groupId);
      if (it && "children" in it) ribbon.act(primaryTool(it).action);
      break;
    }
    case "pick":
      primaryOf.value = { ...primaryOf.value, [effect.groupId]: effect.action };
      closePopup();
      ribbon.act(effect.action);
      break;
    case "none":
      break;
  }
}

function onSplitDown(e: PointerEvent, it: Item & { children: ToolItem[] }) {
  if (e.button !== 0) return; // a right-click emits pointerdown too, and contextmenu owns it
  pressDown = true;
  splitFaces.set(it.label, e.currentTarget as HTMLElement);
  // Pen and touch capture the pointer on the element that was pressed, which
  // would deliver the release here however far the finger travelled, and the
  // release position is exactly what decides the pick.
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  sendHold({ type: "press", groupId: it.label, hasVariants: it.children.length > 1 });
  clearHoldTimer();
  holdTimer = setTimeout(() => sendHold({ type: "hold" }), HOLD_MS);
}

/** The family row under the pointer at release. Read from the DOM rather than
 *  tracked, because the popup is teleported to the body and the pointer never
 *  entered it as far as the ribbon is concerned. */
function rowAt(x: number, y: number): { groupId: string; action: string } | null {
  const p = popup.value;
  if (p?.kind !== "split") return null;
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pick]");
  const action = el?.dataset["pick"];
  return action ? { groupId: p.label, action } : null;
}

// On the WINDOW: a hold that ends over the model, over another panel, or off the
// edge of the app still has to end, and only the release position distinguishes
// a pick from backing out.
function onWindowUp(e: PointerEvent) {
  if (e.button !== 0 || !pressDown) return;
  sendHold({ type: "release", over: rowAt(e.clientX, e.clientY) });
}
function onWindowCancel() {
  if (hold.value.phase !== "idle") sendHold({ type: "cancel" });
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && hold.value.phase !== "idle") sendHold({ type: "cancel" });
}

function onSplitContext(e: MouseEvent, it: Item & { children: ToolItem[] }) {
  e.preventDefault();
  splitFaces.set(it.label, e.currentTarget as HTMLElement);
  sendHold({ type: "contextmenu", groupId: it.label, hasVariants: it.children.length > 1 });
}

function pickFromPopup(it: ToolItem) {
  const p = popup.value;
  // A split pick also becomes that button's primary (last-used-wins); an
  // overflow pick just runs, because the group is collapsed anyway.
  if (p?.kind === "split") primaryOf.value = { ...primaryOf.value, [p.label]: it.action };
  closePopup();
  // This is the click-to-pick route (the caret, or a right-click), so the
  // gesture is over however it was opened. Leaving the machine `open` would make
  // the next press on that face read as a dismiss instead of a tool.
  hold.value = IDLE;
  pressDown = false;
  ribbon.act(it.action);
}

function dismissPopup() {
  closePopup();
  hold.value = IDLE;
  pressDown = false;
}

function title(it: ToolItem) {
  return it.key ? `${it.label} (${it.key})` : it.label;
}
</script>

<template>
  <div id="ribbon" ref="root">
    <div ref="ctx" class="ribbon-context">
      <template v-for="g in groups" :key="g.label">
        <!-- the spacer pushes PALETTE/FINISH to the right in sketch context -->
        <div v-if="g.label === 'PALETTE'" class="ribbon-spacer"></div>
        <div class="ribbon-group" :class="{ collapsed: collapsedLabels.has(g.label) }">
          <div class="ribbon-tools">
            <template v-for="it in g.items" :key="'children' in it ? it.label : it.action">
              <div v-if="'children' in it" class="ribbon-split">
                <!-- No @click: the press-and-hold machine owns this face, and
                     running the tool from both would run it twice on every
                     ordinary click. `runDefault` is the click. -->
                <button
                  class="ribbon-btn"
                  :data-action="primaryTool(it).action"
                  :class="{
                    active: ribbon.activeSketchTool === primaryTool(it).action,
                    holding: hold.phase !== 'idle' && hold.groupId === it.label,
                  }"
                  :title="`${title(primaryTool(it))} · hold for more`"
                  @pointerdown="onSplitDown($event, it)"
                  @contextmenu="onSplitContext($event, it)"
                >
                  <Icon :name="primaryTool(it).iconName" /><span>{{ primaryTool(it).label }}</span>
                </button>
                <button
                  class="ribbon-split-arrow"
                  :title="`More ${it.label} tools`"
                  @click.stop="toggleSplit($event, it)"
                ><Icon name="caretDown" :size="11" /></button>
              </div>
              <button
                v-else
                class="ribbon-btn"
                :class="{ finish: it.kind === 'finish', active: ribbon.activeSketchTool === it.action }"
                :data-action="it.action"
                :title="title(it)"
                @click="ribbon.act(it.action)"
              >
                <Icon :name="it.iconName" /><span>{{ it.label }}</span>
              </button>
            </template>
          </div>
          <div class="ribbon-group-label">{{ g.label }}</div>
        </div>
      </template>

      <button
        ref="overflowBtn"
        class="ribbon-overflow"
        :class="{ hidden: !collapsedGroups.length }"
        title="More tools"
        @click.stop="toggleOverflow()"
      >⋯</button>
    </div>

    <RibbonPopup
      v-if="popup"
      :anchor="popup.anchor"
      :align="popup.kind === 'overflow' ? 'right' : 'left'"
      :items="popup.kind === 'split' ? popup.items : []"
      :groups="popup.kind === 'overflow' ? collapsedGroups : undefined"
      @pick="pickFromPopup"
      @dismiss="dismissPopup"
    />
  </div>
</template>
