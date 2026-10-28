<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import Button from "../ui/Button.vue";
import Menu from "../ui/Menu.vue";
import MenuItem from "../ui/MenuItem.vue";
import MenuSeparator from "../ui/MenuSeparator.vue";
import { guardMenuKeys, type MenuDef } from "../../ui/menu";

const props = defineProps<{ menus: MenuDef[] }>();

const root = useTemplateRef<HTMLElement>("root");
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

let releaseKeys = () => {};
onMounted(() => (releaseKeys = guardMenuKeys()));
onUnmounted(() => releaseKeys());
</script>

<template>
  <nav id="menubar" class="menubar" ref="root">
    <div v-for="(m, i) in menus" :key="m.label" :ref="(el) => (cells[i] = el as HTMLElement)" class="menu">
      <Button
        variant="ghost"
        size="sm"
        class="menu-btn"
        :class="{ 'is-open': openIndex === i }"
        aria-haspopup="menu"
        :aria-expanded="openIndex === i"
        @click.stop="toggle(i)"
        @keydown="onButtonKey($event, i)"
        >{{ m.label }}</Button
      >
    </div>
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
