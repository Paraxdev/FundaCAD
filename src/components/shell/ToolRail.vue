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
  faceOf, familyOf, modelRail, sketchRail, sketchTool,
  type RailEntry, type RailFamily, type RailTool,
} from "../../ui/railDefs";
import { HOLD_MS, IDLE, holdStep, type HoldEvent, type HoldPhase } from "../../ui/holdGesture";
import { contextMenu } from "../../ui/menu";
import { useSelectionOffers } from "../../composables/useSelectionOffers";
import { runningTool } from "../../ui/runningTool";
import RailButton from "../ui/RailButton.vue";
import Popover from "../ui/Popover.vue";
import Icon from "./Icon.vue";

const engine = useEngine();
const ribbon = useRibbonStore();
const cmdk = useCommandPaletteStore();
const sketchPalette = useSketchPaletteStore();
const sel = useSelectionOffers(engine);

const railEl = useTemplateRef<HTMLElement>("railEl");
const listEl = useTemplateRef<HTMLElement>("listEl");
/** Smaller tiles and no sub-labels once the tools no longer fit the height. */
const compact = ref(false);
/** The list is taller than its room even so, and scrolls. */
const scrolls = ref(false);
function measureFit() {
  const rail = railEl.value;
  const list = listEl.value;
  if (!rail || !list) return;
  const foot = rail.querySelector<HTMLElement>(".rail-foot")?.offsetHeight ?? 0;
  const needed = compact.value ? list.scrollHeight * 1.3 : list.scrollHeight;
  compact.value = needed + foot + 12 > rail.clientHeight;
  // After the compact tiles have laid out, they may be what makes it fit.
  void nextTick(() => {
    const l = listEl.value;
    if (l) scrolls.value = l.scrollHeight > l.clientHeight + 1;
  });
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

// A plugin's tool group starts open; folding it away is remembered by plugin id
// for the session. Collapsing changes the list height, so the fit is remeasured.
const collapsedGroups = ref<Set<string>>(new Set());
function isCollapsed(id: string): boolean {
  return collapsedGroups.value.has(id);
}
function toggleGroup(id: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedGroups.value = next;
  void nextTick(measureFit);
}

// While a modelling tool holds the screen the rail steps back to that one tool,
// so nothing competes with the model for attention mid drag.
const running = computed(() => {
  pulse.value;
  return sel.toolOwns.value && ribbon.context !== "sketch" ? runningTool(engine.tools) : null;
});

const mode = computed(() => {
  if (ribbon.context === "sketch") return "sketch";
  if (running.value) return "running";
  return sel.kind.value && !sel.toolOwns.value ? "selection" : "model";
});

const entries = computed<RailEntry[]>(() => {
  pluginTick.value;
  if (mode.value === "sketch") return sketchRail();
  if (mode.value === "running") return [];
  if (mode.value === "selection") {
    const onFace = sel.kind.value === "face" && engine.viewport.selectedFaceSketchPlane() ? sketchTool() : null;
    // App tools flat here; a plugin's tools are drawn below as their own
    // collapsible groups (see the template), so they are left out of this list.
    return [
      ...(onFace ? [onFace] : []),
      ...sel.appOffers.value.map((o): RailTool => ({
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

// Isolate/solo only, not any manual body hide (store.isolateActive tracks which).
const isolateActive = useBuildValue(() => engine.store.isolateActive);
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

// sketchRail() names the Constrain family `fam:constrain` (RailFamily.id is
// always `fam:${slot.id}`, see railDefs.ts's sketchRail).
const CONSTRAIN_FAMILY_ID = "fam:constrain";

/** The Constrain family's face click, with something already selected in the
 *  sketch: offer the constraint types that apply to that selection instead of
 *  always arming Horizontal (SK-3). Returns false (caller falls through to the
 *  normal default-tool click) when there's no sketch selection or nothing in
 *  it is constrainable, so an empty selection behaves exactly as before. */
function offerConstraintPopup(f: RailFamily): boolean {
  const sk = engine.sketch;
  if (!sk.active) return false;
  const items = sk.constraintOptions();
  if (!items.length) return false;
  const r = tiles.get(f.id)?.getBoundingClientRect();
  contextMenu(r ? r.right + 8 : 0, r ? r.top : 0, items.map((o) => ({ label: o.label, onClick: o.apply })));
  return true;
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
      if (f) {
        if (f.id === CONSTRAIN_FAMILY_ID && offerConstraintPopup(f)) break;
        run(faceOf(f, chosen.value[f.id]).action);
      }
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
  if (isolateActive.value) {
    engine.handleAction("show-all-bodies");
    return;
  }
  const ids = engine.viewport.getSelectedBodies();
  if (!ids.length) {
    engine.setStatus("Isolate: select the bodies to keep", "");
    return;
  }
  engine.store.isolateBodies(ids);
}
</script>

<template>
  <nav id="toolrail" ref="railEl" class="tool-rail" :class="{ compact, scrolls }" :data-mode="mode" aria-label="Tools">
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
        v-else-if="mode === 'running' && running"
        :icon="running.icon"
        :label="running.label"
        keys="Esc"
        active
        data-action="running-tool"
        @click="running.cancel()"
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

      <!-- A plugin's tools, folded under its own name (selection mode only). -->
      <template v-for="g in (mode === 'selection' ? sel.pluginGroups.value : [])" :key="`grp:${g.pluginId}`">
        <button
          type="button"
          class="rail-group"
          :class="{ collapsed: isCollapsed(g.pluginId) }"
          :title="`${g.name} · ${g.offers.length} tool${g.offers.length === 1 ? '' : 's'}`"
          :aria-expanded="!isCollapsed(g.pluginId)"
          :data-group="g.pluginId"
          @click="toggleGroup(g.pluginId)"
        >
          <span class="rail-tile rail-group-tile">
            <Icon :name="isCollapsed(g.pluginId) ? 'caretRight' : 'caretDown'" :size="18" />
          </span>
          <span class="rail-pill rail-group-pill">
            <span class="rail-group-name">{{ g.name }}</span>
          </span>
        </button>
        <RailButton
          v-for="o in (isCollapsed(g.pluginId) ? [] : g.offers)"
          :key="`offer:${o.tool}`"
          class="rail-child"
          :icon="o.iconName"
          :label="o.label"
          :keys="o.hint"
          :data-action="`offer:${o.tool}`"
          @click="run(`offer:${o.tool}`, $event)"
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
          :sub="isolateActive ? 'On' : 'Off'"
          :active="isolateActive"
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
      :clear="railEl"
      side="right"
      :gap="6"
      kind="rail-flyout"
      @close="closeFlyout()"
    >
      <div class="rail-flyout-grid" :style="{ gridTemplateRows: `repeat(${flyoutRows}, auto)` }">
      <RailButton
        v-for="(t, i) in flyout.items"
        :key="t.action"
        :style="{ '--i': i }"
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
