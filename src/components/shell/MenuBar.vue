<script setup lang="ts">
import { fmtKeys } from "../../input/platform";
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { claimEscape } from "../../ui/escapeClaim";
import Icon from "./Icon.vue";
import type { MenuDef, MenuItem } from "../../ui/menu";

const props = defineProps<{ menus: MenuDef[] }>();

const root = useTemplateRef<HTMLElement>("root");
const openIndex = ref<number | null>(null);

// `disabled` and `checked` are thunks re-evaluated on every open, which is how Undo greys out without pushed state.
// Bumping this on open re-runs the computed below.
const openTick = ref(0);

interface RenderedItem {
  item: MenuItem;
  disabled: boolean;
  /** undefined = this row is not a toggle at all, so it claims no gutter slot. */
  checked: boolean | undefined;
}

const rendered = computed<RenderedItem[][]>(() => {
  openTick.value; // dependency: re-evaluate the thunks on every open
  return props.menus.map((m) =>
    m.items.map((item) => ({
      item,
      disabled: !!item.disabled?.(),
      checked: item.checked ? item.checked() : undefined,
    })),
  );
});

// One check gutter per menu, not per row, or a toggle shifts sideways against its neighbours as it turns on.
const hasChecks = computed(() => props.menus.map((m) => m.items.some((it) => it.checked)));

function toggle(i: number) {
  if (openIndex.value === i) {
    openIndex.value = null;
    return;
  }
  openTick.value++;
  openIndex.value = i;
}

function run(r: RenderedItem) {
  if (r.disabled) return;
  openIndex.value = null;
  r.item.onClick?.();
}

// dismiss on outside click / Escape
function onDown(e: PointerEvent) {
  if (openIndex.value !== null && !root.value?.contains(e.target as Node)) openIndex.value = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") openIndex.value = null;
}
let releaseEscape: (() => void) | null = null;
watch(openIndex, (i) => {
  if (i !== null) releaseEscape ??= claimEscape();
  else {
    releaseEscape?.();
    releaseEscape = null;
  }
});
onMounted(() => {
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  releaseEscape?.();
  document.removeEventListener("pointerdown", onDown);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <nav id="menubar" class="menubar" ref="root">
    <div v-for="(m, i) in menus" :key="m.label" class="menu">
      <button class="menu-btn" :class="{ active: openIndex === i }" @click.stop="toggle(i)">
        {{ m.label }}
      </button>
      <div class="menu-popup" :class="{ hidden: openIndex !== i }">
        <template v-for="(r, j) in rendered[i]" :key="j">
          <div v-if="r.item.separator" class="menu-sep"></div>
          <button v-else class="menu-item" :disabled="r.disabled" @click.stop="run(r)">
            <span v-if="hasChecks[i]" class="menu-check">
              <Icon v-if="r.checked" name="check" :size="12" />
            </span>
            <span>{{ r.item.label }}</span>
            <span v-if="r.item.shortcut" class="menu-shortcut">{{ fmtKeys(r.item.shortcut) }}</span>
          </button>
        </template>
      </div>
    </div>
  </nav>
</template>
