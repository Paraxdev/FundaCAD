<script setup lang="ts">
// The floating tool rail down the left of the viewport. It carries every tool
// the ribbon did, and swaps its whole content with the mode: categories for the
// model, the tools that fit a selection, or the drawing tools inside a sketch.

import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { useBuildValue, useDocValue } from "../../app/useDoc";
import { useRibbonStore } from "../../stores/ribbon";
import { useCommandPaletteStore } from "../../stores/commandPalette";
import { useSketchPaletteStore } from "../../stores/sketchPalette";
import { onContribChange } from "../../plugins/contrib";
import {
  faceOf, familyOf, modelRail, sketchRail,
  type RailEntry, type RailFamily, type RailTool,
} from "../../ui/railDefs";
import { HOLD_MS, IDLE, holdStep, type HoldEvent, type HoldPhase } from "../../ui/holdGesture";
import { useSelectionOffers } from "../../composables/useSelectionOffers";
import RailButton from "../ui/RailButton.vue";
import Popover from "../ui/Popover.vue";

const engine = useEngine();
const ribbon = useRibbonStore();
const cmdk = useCommandPaletteStore();
const sketchPalette = useSketchPaletteStore();
const sel = useSelectionOffers(engine);

const railEl = useTemplateRef<HTMLElement>("railEl");
const listEl = useTemplateRef<HTMLElement>("listEl");
/** Smaller tiles and no sub-labels once the tools no longer fit the height. */
const compact = ref(false);
function measureFit() {
  const rail = railEl.value;
  const list = listEl.value;
  if (!rail || !list) return;
  const foot = rail.querySelector<HTMLElement>(".rail-foot")?.offsetHeight ?? 0;
  const needed = compact.value ? list.scrollHeight * 1.3 : list.scrollHeight;
  compact.value = needed + foot + 12 > rail.clientHeight;
}
let fitRo: ResizeObserver | null = null;
onMounted(() => {
  fitRo = new ResizeObserver(() => measureFit());
  if (railEl.value) fitRo.observe(railEl.value);
  void nextTick(measureFit);
});
onUnmounted(() => fitRo?.disconnect());

const pluginTick = ref(0);
let offPlugins: (() => void) | null = null;
onMounted(() => { offPlugins = onContribChange(() => pluginTick.value++); });
onUnmounted(() => offPlugins?.());

const mode = computed(() => {
  if (ribbon.context === "sketch") return "sketch";
  return sel.kind.value && !sel.toolOwns.value ? "selection" : "model";
});

const entries = computed<RailEntry[]>(() => {
  pluginTick.value;
  if (mode.value === "sketch") return sketchRail();
  if (mode.value === "selection") {
    return [
      ...sel.offers.value.map((o): RailTool => ({
        kind: "tool", action: `offer:${o.tool}`, label: o.label, icon: o.iconName, ...(o.hint ? { keys: o.hint } : {}),
      })),
      ...sel.looks.value.map((o): RailTool => ({ kind: "tool", action: `look:${o.id}`, label: o.label, icon: o.iconName })),
    ];
  }
  return modelRail();
});

const sketchName = useDocValue((doc) => {
  const id = ribbon.sketchId;
  if (!id) return "New sketch";
  const sketches = doc.features.filter((f) => f.type === "sketch");
  const i = sketches.findIndex((f) => f.id === id);
  const named = (sketches[i] as { name?: string } | undefined)?.name;
  return named || `Sketch ${i + 1}`;
});

// --- live state the engine does not publish --------------------------------

const pulse = ref(0);
let pulseRaf = 0;
function bump() {
  if (!pulseRaf) pulseRaf = requestAnimationFrame(() => { pulseRaf = 0; pulse.value++; });
}
let unsubs: (() => void)[] = [];
onMounted(() => {
  window.addEventListener("pointerup", bump);
  window.addEventListener("keyup", bump);
  unsubs = [engine.store.onDocChange(() => bump()), engine.store.onBuild(() => bump())];
});
onUnmounted(() => {
  window.removeEventListener("pointerup", bump);
  window.removeEventListener("keyup", bump);
  for (const off of unsubs) off();
  if (pulseRaf) cancelAnimationFrame(pulseRaf);
});

const anyHidden = useBuildValue((b) => (b.result?.bodies ?? []).some((x) => !engine.store.isBodyVisible(x.id)));
const sectionOn = computed(() => { pulse.value; return engine.tools.section.active || engine.tools.section.picking; });
const measureOn = computed(() => { pulse.value; return engine.tools.measure.active; });

// --- families: last used on the face, press and hold for the rest ----------

const chosen = ref<Record<string, string>>({});
watch(
  () => ribbon.activeSketchTool,
  (tool) => {
    const fam = tool ? familyOf(sketchRail(), tool) : null;
    if (fam) chosen.value = { ...chosen.value, [fam.id]: tool };
  },
);

const flyout = shallowRef<{ id: string; anchor: HTMLElement; items: RailTool[] } | null>(null);
const hold = shallowRef<HoldPhase>(IDLE);
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let pressDown = false;
const tiles = new Map<string, HTMLElement>();

function family(id: string): RailFamily | null {
  const e = entries.value.find((x) => x.kind === "family" && x.id === id);
  return e && e.kind === "family" ? e : null;
}
function tileOf(ev: Event): HTMLElement {
  return ev.currentTarget as HTMLElement;
}
function clearHoldTimer() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
}
function closeFlyout() {
  flyout.value = null;
  hold.value = IDLE;
  pressDown = false;
  clearHoldTimer();
}
function openFlyout(f: RailFamily) {
  const anchor = tiles.get(f.id);
  if (anchor) flyout.value = { id: f.id, anchor, items: f.items };
}

function sendHold(ev: HoldEvent) {
  const { next, effect } = holdStep(hold.value, ev);
  hold.value = next;
  if (next.phase !== "pressing") clearHoldTimer();
  if (next.phase === "idle") pressDown = false;
  const f = "groupId" in effect ? family(effect.groupId) : null;
  switch (effect.kind) {
    case "open":
      if (f) openFlyout(f);
      break;
    case "close":
      flyout.value = null;
      break;
    case "runDefault":
      if (f) run(faceOf(f, chosen.value[f.id]).action);
      break;
    case "pick":
      chosen.value = { ...chosen.value, [effect.groupId]: effect.action };
      flyout.value = null;
      run(effect.action);
      break;
    case "none":
      break;
  }
}

function onFamilyDown(e: PointerEvent, f: RailFamily) {
  if (e.button !== 0 || f.style === "category") return;
  pressDown = true;
  tiles.set(f.id, tileOf(e));
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  sendHold({ type: "press", groupId: f.id, hasVariants: f.items.length > 1 });
  clearHoldTimer();
  holdTimer = setTimeout(() => sendHold({ type: "hold" }), HOLD_MS);
}

function onFamilyClick(e: MouseEvent, f: RailFamily) {
  if (f.style !== "category") return;
  tiles.set(f.id, tileOf(e));
  if (flyout.value?.id === f.id) closeFlyout();
  else openFlyout(f);
}

function onFamilyContext(e: MouseEvent, f: RailFamily) {
  e.preventDefault();
  tiles.set(f.id, tileOf(e));
  if (f.style === "category") return onFamilyClick(e, f);
  sendHold({ type: "contextmenu", groupId: f.id, hasVariants: f.items.length > 1 });
}

function rowAt(x: number, y: number): { groupId: string; action: string } | null {
  const open = flyout.value;
  if (!open) return null;
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pick]");
  const action = el?.dataset["pick"];
  return action ? { groupId: open.id, action } : null;
}
function onWindowUp(e: PointerEvent) {
  if (e.button !== 0 || !pressDown) return;
  sendHold({ type: "release", over: rowAt(e.clientX, e.clientY) });
}
function onWindowCancel() {
  if (hold.value.phase !== "idle") sendHold({ type: "cancel" });
}
onMounted(() => {
  window.addEventListener("pointerup", onWindowUp, true);
  window.addEventListener("pointercancel", onWindowCancel, true);
  window.addEventListener("blur", onWindowCancel);
});
onUnmounted(() => {
  clearHoldTimer();
  window.removeEventListener("pointerup", onWindowUp, true);
  window.removeEventListener("pointercancel", onWindowCancel, true);
  window.removeEventListener("blur", onWindowCancel);
});

/** Rows per flyout column: a list taller than the window wraps into columns. */
const FLYOUT_ROW_PX = 46;
const flyoutRows = computed(() => {
  const n = flyout.value?.items.length ?? 1;
  return Math.max(1, Math.min(n, Math.floor((window.innerHeight - 64) / FLYOUT_ROW_PX)));
});

// A mode swap replaces every button, so a flyout would be hanging off nothing.
watch(mode, async () => { closeFlyout(); await nextTick(); measureFit(); });

function pickFromFlyout(t: RailTool, ev: MouseEvent) {
  const open = flyout.value;
  const f = open ? family(open.id) : null;
  if (f?.style === "variants") chosen.value = { ...chosen.value, [f.id]: t.action };
  closeFlyout();
  run(t.action, ev);
}

// --- running ---------------------------------------------------------------

function run(action: string, ev?: MouseEvent) {
  if (action.startsWith("offer:")) {
    const o = sel.offers.value.find((x) => `offer:${x.tool}` === action);
    if (o) sel.run(o);
    return;
  }
  if (action.startsWith("look:")) {
    const o = sel.looks.value.find((x) => `look:${x.id}` === action);
    const r = (ev?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
    if (o) sel.look(o, r ? { x: r.right + 8, y: r.top } : { x: ev?.clientX ?? 0, y: ev?.clientY ?? 0 });
    return;
  }
  ribbon.act(action);
}

function isActive(action: string): boolean {
  return mode.value === "sketch" && ribbon.activeSketchTool === action;
}

function toggleIsolate() {
  if (anyHidden.value) {
    engine.handleAction("show-all-bodies");
    return;
  }
  const ids = engine.viewport.getSelectedBodies();
  if (!ids.length) {
    engine.setStatus("Isolate: select the bodies to keep", "");
    return;
  }
  const all = engine.store.buildState.result?.bodies ?? [];
  const keep = new Set(ids);
  engine.store.setBodiesVisibility(new Map(all.map((b) => [b.id, keep.has(b.id)])));
}
</script>

<template>
  <nav id="toolrail" ref="railEl" class="tool-rail" :class="{ compact }" :data-mode="mode" aria-label="Tools">
    <div ref="listEl" class="rail-list">
      <RailButton
        icon="search"
        label="Search"
        keys="Ctrl F"
        data-action="search"
        @click="cmdk.toggle(ribbon.context)"
      />
      <RailButton
        v-if="mode === 'sketch'"
        icon="close"
        label="Exit Sketching"
        :sub="sketchName"
        data-action="finish"
        @click="ribbon.act('finish')"
      />
      <RailButton
        v-else-if="mode === 'selection'"
        icon="select-all"
        label="Deselect All"
        :sub="sel.summary.value"
        keys="Esc"
        data-action="deselect"
        @click="sel.clear()"
      />
      <div class="rail-sep" aria-hidden="true"></div>

      <template v-for="e in entries" :key="e.kind === 'tool' ? e.action : e.id">
        <RailButton
          v-if="e.kind === 'tool'"
          :icon="e.icon"
          :label="e.label"
          :keys="e.keys"
          :active="isActive(e.action)"
          :data-action="e.action"
          @click="run(e.action, $event)"
        />
        <RailButton
          v-else
          :icon="e.style === 'variants' ? faceOf(e, chosen[e.id]).icon : e.icon"
          :label="e.label"
          :sub="e.style === 'variants' && faceOf(e, chosen[e.id]).label !== e.label ? faceOf(e, chosen[e.id]).label : ''"
          :keys="e.style === 'variants' ? faceOf(e, chosen[e.id]).keys : ''"
          :active="e.items.some((t) => isActive(t.action)) || flyout?.id === e.id"
          menu
          :data-family="e.id"
          :class="{ holding: hold.phase !== 'idle' && 'groupId' in hold && hold.groupId === e.id }"
          @pointerdown="onFamilyDown($event, e)"
          @click="onFamilyClick($event, e)"
          @contextmenu="onFamilyContext($event, e)"
        />
      </template>
    </div>

    <div class="rail-list rail-foot">
      <template v-if="mode === 'sketch'">
        <RailButton
          icon="offset"
          label="Construction"
          :sub="sketchPalette.state.construction ? 'On' : 'Off'"
          :active="sketchPalette.state.construction"
          data-action="construction"
          @click="sketchPalette.set('construction', !sketchPalette.state.construction)"
        />
      </template>
      <template v-else>
        <RailButton
          icon="isolate"
          label="Isolate"
          :sub="anyHidden ? 'On' : 'Off'"
          :active="anyHidden"
          data-action="isolate"
          @click="toggleIsolate()"
        />
        <RailButton
          icon="section"
          label="Section View"
          :sub="sectionOn ? 'On' : 'Off'"
          :active="sectionOn"
          data-action="section"
          @click="ribbon.act('section')"
        />
        <RailButton
          icon="measure"
          label="Measure"
          :active="measureOn"
          data-action="measure"
          @click="ribbon.act('measure')"
        />
      </template>
    </div>

    <Popover
      v-if="flyout"
      :anchor="flyout.anchor"
      side="right"
      :gap="6"
      kind="rail-flyout"
      @close="closeFlyout()"
    >
      <div class="rail-flyout-grid" :style="{ gridTemplateRows: `repeat(${flyoutRows}, auto)` }">
      <RailButton
        v-for="t in flyout.items"
        :key="t.action"
        :icon="t.icon"
        :label="t.label"
        :keys="t.keys"
        :active="isActive(t.action)"
        :data-pick="t.action"
        @click="pickFromFlyout(t, $event)"
      />
      </div>
    </Popover>
  </nav>
</template>
