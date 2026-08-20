<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch, useTemplateRef } from "vue";
import Icon from "../shell/Icon.vue";
import { useContextMenuStore, type CtxItem } from "../../stores/contextMenu";

const s = useContextMenuStore();

// The check gutter is all-or-nothing per menu, not per row: a menu with no
// toggles in it must not indent, and a menu with one must indent EVERY row or
// the checked entry shifts sideways relative to its neighbours the moment it
// turns on.
const hasChecks = computed(() => s.items.some((it) => it.checked !== undefined));

const menuEl = useTemplateRef<HTMLDivElement>("menuEl");
const subEl = useTemplateRef<HTMLDivElement>("subEl");
const rootRows = ref<HTMLElement[]>([]);

// Final on-screen position, after the overflow nudge below.
const pos = ref({ x: 0, y: 0 });
// First paint is hidden: the nudge needs the rendered size, and a visible
// pre-nudge frame would show the menu jumping. onMounted-equivalent timing
// (flush: "post") runs before the browser paints, so this is belt-and-braces.
const placed = ref(false);

// --- flyout submenu (one level; CtxItem.children is not recursive) ---
const subIndex = ref<number | null>(null);
const subPos = ref({ x: 0, y: 0 });
const subPlaced = ref(false);
let subCloseTimer: number | undefined;

function cancelSubClose() {
  clearTimeout(subCloseTimer);
  subCloseTimer = undefined;
}
function closeSub() {
  cancelSubClose();
  subIndex.value = null;
  subPlaced.value = false;
}
// Hover-intent: moving diagonally from the parent item toward a lower flyout
// entry crosses sibling rows — an instant close would retract the flyout mid-
// travel, so sibling hover only *schedules* the close and entering the flyout
// cancels it.
function scheduleSubClose() {
  cancelSubClose();
  subCloseTimer = window.setTimeout(closeSub, 300);
}

async function openSub(i: number) {
  if (subIndex.value === i) {
    cancelSubClose(); // re-hovering the parent keeps its open flyout
    return;
  }
  cancelSubClose();
  subIndex.value = i;
  subPlaced.value = false;
  await nextTick();
  const anchor = rootRows.value[i];
  const sub = subEl.value;
  if (!anchor || !sub) return;
  // to the right of the parent item; flip left / shift up when it would overflow
  const a = anchor.getBoundingClientRect();
  const r = sub.getBoundingClientRect();
  let sx = a.right + 2;
  if (sx + r.width > window.innerWidth) sx = Math.max(4, a.left - r.width - 2);
  let sy = a.top - 5;
  if (sy + r.height > window.innerHeight) sy = Math.max(4, window.innerHeight - r.height - 4);
  subPos.value = { x: sx, y: sy };
  subPlaced.value = true;
}

// --- row hover, for menus whose entries name something on screen ------------
//
// Tracked here rather than left to pointerenter/pointerleave alone, because the
// leave does not always come: clicking a row, pressing Escape, or a pointerdown
// outside all close the menu while the pointer is still over it, and each would
// strand the preview lit with nothing left to turn it off.
let hovered: CtxItem | null = null;

function setHover(it: CtxItem | null) {
  if (hovered === it) return;
  hovered?.onHover?.(false);
  hovered = it;
  it?.onHover?.(true);
}

function activate(it: CtxItem) {
  if (it.disabled || it.separator) return;
  setHover(null);
  s.close();
  it.onClick?.();
}

// --- dismissal ---
function onDown(e: PointerEvent) {
  const t = e.target as Node;
  if (!menuEl.value?.contains(t) && !subEl.value?.contains(t)) s.close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation(); // Escape only closes the menu — not the app's selection
    s.close();
  }
}
function bind() {
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
}
function unbind() {
  document.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("keydown", onKey, true);
}

watch(
  () => s.epoch,
  async () => {
    unbind();
    closeSub();
    setHover(null);
    if (!s.open) return;
    placed.value = false;
    pos.value = { x: s.x, y: s.y };
    await nextTick();
    const el = menuEl.value;
    if (el) {
      // nudge back on-screen if it would overflow
      const r = el.getBoundingClientRect();
      const nx = r.right > window.innerWidth ? Math.max(4, s.x - r.width) : s.x;
      const ny = r.bottom > window.innerHeight ? Math.max(4, s.y - r.height) : s.y;
      pos.value = { x: nx, y: ny };
    }
    placed.value = true;
    // Deferred so the right-click that opened the menu doesn't immediately
    // close it again. Re-checks `open` in case something dismissed it first.
    setTimeout(() => {
      if (s.open) bind();
    }, 0);
  },
  { flush: "post" },
);

// closing (from an item click, dismissContextMenu(), a doc change...) must also
// drop the global listeners
watch(
  () => s.open,
  (isOpen) => {
    if (!isOpen) {
      unbind();
      closeSub();
      setHover(null);
    }
  },
);

onUnmounted(() => {
  unbind();
  cancelSubClose();
  setHover(null);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="s.open"
      ref="menuEl"
      class="context-menu dynamic"
      :style="{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        visibility: placed ? undefined : 'hidden',
      }"
    >
      <template v-for="(it, i) in s.items" :key="i">
        <div v-if="it.separator" class="ctx-sep"></div>
        <div
          v-else
          :ref="(el) => { if (el) rootRows[i] = el as HTMLElement; }"
          class="ctx-item"
          :class="{ danger: it.danger, disabled: it.disabled }"
          @pointerenter="it.disabled ? undefined : (setHover(it), it.children ? openSub(i) : scheduleSubClose())"
          @pointerleave="setHover(null)"
          @click="it.children && !it.disabled ? openSub(i) : activate(it)"
        >
          <span v-if="hasChecks" class="ctx-check">
            <Icon v-if="it.checked" name="check" :size="12" />
          </span>
          <span v-if="it.swatch" class="ctx-swatch" :style="{ background: it.swatch }"></span>
          <span class="ctx-label">{{ it.label }}</span>
          <span v-if="it.shortcut" class="ctx-key">{{ it.shortcut }}</span>
          <span v-if="it.children" class="ctx-caret"><Icon name="caretRight" :size="10" /></span>
        </div>
      </template>
    </div>

    <!-- one-level flyout, also on body so it can escape the parent's bounds -->
    <div
      v-if="s.open && subIndex !== null"
      ref="subEl"
      class="context-menu dynamic submenu"
      :style="{
        left: `${subPos.x}px`,
        top: `${subPos.y}px`,
        visibility: subPlaced ? undefined : 'hidden',
      }"
      @pointerenter="cancelSubClose()"
    >
      <template v-for="(c, j) in s.items[subIndex]?.children ?? []" :key="j">
        <div v-if="c.separator" class="ctx-sep"></div>
        <div
          v-else
          class="ctx-item"
          :class="{ danger: c.danger, disabled: c.disabled }"
          @click="activate(c)"
        >
          <span v-if="c.swatch" class="ctx-swatch" :style="{ background: c.swatch }"></span>
          <span class="ctx-label">{{ c.label }}</span>
          <span v-if="c.shortcut" class="ctx-key">{{ c.shortcut }}</span>
        </div>
      </template>
    </div>
  </Teleport>
</template>
