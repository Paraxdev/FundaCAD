<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import Button from "../ui/Button.vue";
import Menu from "../ui/Menu.vue";
import MenuItem from "../ui/MenuItem.vue";
import MenuSeparator from "../ui/MenuSeparator.vue";
import Toolbar from "../ui/Toolbar.vue";
import { guardMenuKeys, type MenuDef } from "../../ui/menu";
import { inertDepth } from "../../composables/useModalGate";

const props = defineProps<{ menus: MenuDef[] }>();

const root = useTemplateRef<HTMLElement>("root");
const bar = useTemplateRef<{ focus: () => void }>("bar");
const openIndex = ref<number | null>(null);
const current = computed(() => (openIndex.value === null ? null : (props.menus[openIndex.value] ?? null)));
// The popup hangs from the `.menu` cell, not its button: the button sits inside the bar's margin.
const cells: HTMLElement[] = [];

// The popup hangs 6px below the bar, and keeps this margin above the window's bottom edge.
const POPUP_GAP = 6;
const WINDOW_MARGIN = 16;
const popupMaxHeight = ref("");
function capToWindow() {
  const bottom = root.value?.getBoundingClientRect().bottom ?? 0;
  popupMaxHeight.value = `${Math.max(120, window.innerHeight - bottom - POPUP_GAP - WINDOW_MARGIN)}px`;
}

function open(i: number) {
  capToWindow();
  openIndex.value = i;
}

function toggle(i: number) {
  if (openIndex.value === i) openIndex.value = null;
  else open(i);
}

function onButtonKey(e: KeyboardEvent, i: number) {
  if (e.key !== "ArrowDown" || e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  e.stopPropagation();
  open(i);
}

// ArrowLeft and ArrowRight on a row walk to the neighbouring menu. Its button takes focus first, so closing the new
// menu hands focus back there and not to the button of the menu that was open.
function onRowKey(e: KeyboardEvent) {
  const at = openIndex.value;
  if (at === null || e.ctrlKey || e.altKey || e.metaKey) return;
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const n = props.menus.length;
  const next = (at + step + n) % n;
  cells[next]?.querySelector<HTMLElement>(".menu-btn")?.focus();
  open(next);
}

// F10 reaches the menu bar as on Windows and Linux, and a second press goes back to where it came from.
let cameFrom: HTMLElement | null = null;
async function onF10(e: KeyboardEvent) {
  if (e.key !== "F10" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  const nav = root.value;
  if (!nav || inertDepth() > 0 || nav.closest("[inert]")) return;
  e.preventDefault();
  const at = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const was = openIndex.value;
  if (was !== null) {
    openIndex.value = null;
    await nextTick();
    cells[was]?.querySelector<HTMLElement>(".menu-btn")?.focus();
    return;
  }
  if (at && nav.contains(at)) {
    const back = cameFrom;
    cameFrom = null;
    if (back?.isConnected) back.focus();
    return;
  }
  cameFrom = at && at !== document.body ? at : null;
  bar.value?.focus();
}
// An open menu's rows sit outside the nav, so only focus moving on while no menu is open forgets the way back.
const onFocusin = (e: FocusEvent) => {
  if (openIndex.value === null && !root.value?.contains(e.target as Node | null)) cameFrom = null;
};

let releaseKeys = () => {};
onMounted(() => {
  releaseKeys = guardMenuKeys();
  window.addEventListener("keydown", onF10);
  document.addEventListener("focusin", onFocusin);
});
onUnmounted(() => {
  releaseKeys();
  window.removeEventListener("keydown", onF10);
  document.removeEventListener("focusin", onFocusin);
});
</script>

<template>
  <nav id="menubar" class="menubar" ref="root" aria-label="Menu">
    <Toolbar ref="bar" role="menubar" label="Menu" class="menubar-bar">
      <div
        v-for="(m, i) in menus"
        :key="m.label"
        :ref="(el) => (cells[i] = el as HTMLElement)"
        class="menu"
        role="none"
      >
        <Button
          variant="ghost"
          size="sm"
          class="menu-btn"
          :class="{ 'is-open': openIndex === i }"
          role="menuitem"
          popup="menu"
          :expanded="openIndex === i"
          @click.stop="toggle(i)"
          @keydown="onButtonKey($event, i)"
          >{{ m.label }}</Button
        >
      </div>
    </Toolbar>
    <!-- `disabled` and `checked` are thunks read as the menu mounts on each open, which is how Undo greys out. -->
    <Menu
      v-if="openIndex !== null && current"
      :key="openIndex"
      :anchor="cells[openIndex] ?? null"
      :gap="POPUP_GAP"
      :label="current.label"
      @close="openIndex = null"
    >
      <div class="menubar-rows" role="none" :style="{ maxHeight: popupMaxHeight }">
        <!-- Rows a parent adds above a menu's own, as TitleBar.vue does for the folded title bar. -->
        <slot name="head" :menu="current.label" />
        <template v-for="(it, j) in current.items" :key="j">
          <MenuSeparator v-if="it.separator" />
          <MenuItem
            v-else
            class="menu-item"
            :label="it.label"
            :keys="it.shortcut"
            :checked="it.checked ? it.checked() : undefined"
            :disabled="!!it.disabled?.()"
            @select="it.onClick?.()"
            @keydown="onRowKey"
          />
        </template>
      </div>
    </Menu>
  </nav>
</template>
