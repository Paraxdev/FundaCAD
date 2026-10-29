<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import { useName, type Named } from "./useName";
import { useRovingFocus } from "./useRovingFocus";
import {
  TREE,
  TREE_ITEM_SELECTOR,
  isMenuKeyEvent,
  treeSlots,
  typeAheadIndex,
  type TreeItemActions,
  type TreeMeta,
} from "./treeContext";

const props = withDefaults(
  defineProps<
    {
      items: readonly TreeMeta[];
      /** The row that holds the Tab stop until focus moves, the selected one; null for the first. */
      activeKey?: string | null | undefined;
      multiselectable?: boolean;
    } & Named
  >(),
  { activeKey: null, multiselectable: false },
);
const emit = defineEmits<{
  select: [key: string, e: KeyboardEvent];
  open: [key: string, e: KeyboardEvent];
  rename: [key: string];
  remove: [key: string];
  menu: [key: string, rect: DOMRect];
  reorder: [key: string, delta: -1 | 1];
  toggle: [key: string, expanded: boolean];
}>();

defineSlots<{ default?(): unknown }>();

const name = useName(props, "Tree");
const root = ref<HTMLElement | null>(null);
const slots = computed(() => treeSlots(props.items));
const indexOf = computed(() => new Map(props.items.map((it, i) => [it.key, i])));
const active = computed(() => (props.activeKey == null ? -1 : (indexOf.value.get(props.activeKey) ?? -1)));

const r = useRovingFocus({
  items: () => props.items,
  active,
  container: root,
  itemSelector: TREE_ITEM_SELECTOR,
  orientation: "vertical",
  wrap: false,
});

const own = new Map<string, () => TreeItemActions>();

provide(TREE, {
  slot: (key) => slots.value.get(key),
  tabindex: (key) => {
    const i = indexOf.value.get(key);
    return i === undefined ? -1 : r.tabindex(i);
  },
  onItemFocus: (key) => {
    const i = indexOf.value.get(key);
    if (i !== undefined) r.onFocus(i);
  },
  actions: (key, get) => {
    own.set(key, get);
    return () => {
      if (own.get(key) === get) own.delete(key);
    };
  },
});

function focusKey(key: string) {
  const i = indexOf.value.get(key);
  if (i !== undefined) r.focus(i);
}

// A reorder moves the row's element, which can drop its focus: put it back once the list is redrawn.
let refocus: { key: string; at: number } | null = null;
watch(
  () => props.items,
  () => {
    if (!refocus || performance.now() - refocus.at > 2000) return void (refocus = null);
    const key = refocus.key;
    refocus = null;
    const i = indexOf.value.get(key);
    const el = i === undefined ? undefined : root.value?.querySelectorAll<HTMLElement>(TREE_ITEM_SELECTOR)[i];
    if (el && document.activeElement !== el) focusKey(key);
  },
  { flush: "post" },
);

// Letters type ahead only once the tree was reached by keys, so a click on a row leaves them to the shortcuts.
const keyboard = ref(false);
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
let pointerAt = -Infinity;
let typed = "";
let typedAt = 0;
let menuKeyAt = -Infinity;

function onPointerdown() {
  keyboard.value = false;
  typed = "";
  pointerAt = performance.now();
}
function onFocusin() {
  if (performance.now() - pointerAt > 800) keyboard.value = true;
}
// Chromium and WebKitGTK follow the Menu key with a contextmenu event of their own, the menu is open already.
function onContextmenu(e: MouseEvent) {
  if (performance.now() - menuKeyAt > 1000) return;
  menuKeyAt = -Infinity;
  e.preventDefault();
  e.stopPropagation();
}

function claim(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function typeAhead(e: KeyboardEvent, from: number): boolean {
  if (!keyboard.value || e.key.length !== 1 || e.key === " " || e.ctrlKey || e.altKey || e.metaKey) return false;
  const now = performance.now();
  typed = now - typedAt > 600 ? e.key : typed + e.key;
  typedAt = now;
  const i = typeAheadIndex(props.items, from, typed);
  if (i >= 0) r.focus(i);
  return true;
}

const isChild = (i: number, level: number) => {
  const it = props.items[i];
  return !!it && it.level > level && !it.disabled;
};

function onKeydown(e: KeyboardEvent) {
  const el = e.target instanceof HTMLElement && e.target.matches(TREE_ITEM_SELECTOR) ? e.target : null;
  if (!el || e.defaultPrevented) return;
  const els = [...(root.value?.querySelectorAll<HTMLElement>(TREE_ITEM_SELECTOR) ?? [])];
  const i = els.indexOf(el);
  const it = props.items[i];
  if (!it) return;
  const s = slots.value.get(it.key)!;
  const a = own.get(it.key)?.() ?? {};
  const toggle = (open: boolean) => (a.toggle ? a.toggle(open) : emit("toggle", it.key, open));
  if (NAV_KEYS.has(e.key)) {
    keyboard.value = true;
    typed = "";
  }

  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    claim(e);
    refocus = { key: it.key, at: performance.now() };
    emit("reorder", it.key, e.key === "ArrowUp" ? -1 : 1);
    return;
  }
  if (isMenuKeyEvent(e)) {
    claim(e);
    menuKeyAt = performance.now();
    const rect = el.getBoundingClientRect();
    if (a.menu) a.menu(rect);
    else emit("menu", it.key, rect);
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  switch (e.key) {
    case " ":
      claim(e);
      if (a.select) a.select(e);
      else emit("select", it.key, e);
      return;
    case "Enter":
      claim(e);
      if (a.open) a.open(e);
      else emit("open", it.key, e);
      return;
    case "F2":
      claim(e);
      if (a.rename) a.rename();
      else emit("rename", it.key);
      return;
    case "Delete":
    case "Backspace":
      claim(e);
      if (a.remove) a.remove();
      else emit("remove", it.key);
      return;
    case "ArrowRight":
      claim(e);
      if (s.expandable && !s.expanded) toggle(true);
      else if (s.expanded && isChild(i + 1, it.level)) r.focus(i + 1);
      return;
    case "ArrowLeft": {
      claim(e);
      if (s.expanded) return toggle(false);
      for (let p = i - 1; p >= 0; p--) {
        const up = props.items[p]!;
        if (up.level < it.level) {
          if (!up.disabled) r.focus(p);
          return;
        }
      }
      return;
    }
  }
  if (typeAhead(e, i)) return claim(e);
  r.onKeydown(e);
  if (e.defaultPrevented) e.stopPropagation();
}

defineExpose({ focusKey });
</script>

<template>
  <div
    ref="root"
    role="tree"
    v-bind="name"
    :aria-multiselectable="multiselectable ? 'true' : undefined"
    @keydown="onKeydown"
    @pointerdown.capture="onPointerdown"
    @focusin="onFocusin"
    @contextmenu.capture="onContextmenu"
  >
    <slot />
  </div>
</template>
