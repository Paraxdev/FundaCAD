<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  useTemplateRef,
} from "vue";
import { placeBeside, type Side } from "../../ui/anchor";
import { claimEscape } from "../../ui/escapeClaim";
import { escapeLayer } from "./escapeLayer";
import { focusReturn } from "./focusables";
import { MENU, type MenuContext, type MenuEntry } from "./menuContext";
import { useRovingFocus } from "./useRovingFocus";

const props = withDefaults(
  defineProps<{
    /** The element that opened it, placed beside. */
    anchor?: HTMLElement | null;
    /** A point instead, for a context menu. */
    at?: { x: number; y: number } | null;
    side?: Side;
    align?: "start" | "center";
    gap?: number;
    label?: string | undefined;
    /** "first" focuses the first enabled item on open. */
    focus?: "first" | "none";
    /** Set by MenuItem on the menu it opens. */
    submenu?: boolean;
  }>(),
  { anchor: null, at: null, side: "bottom", align: "start", gap: 4, label: undefined, focus: "first", submenu: false },
);
const emit = defineEmits<{ close: [] }>();

const parent = props.submenu ? inject(MENU, null) : null;
const el = useTemplateRef<HTMLElement>("el");
const entries = shallowRef<MenuEntry[]>([]);

function before(a: MenuEntry, b: MenuEntry): number {
  const x = a.el();
  const y = b.el();
  if (!x || !y) return 0;
  return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

const roving = useRovingFocus({
  items: computed(() => entries.value.map((e) => ({ disabled: e.disabled() }))),
  container: el,
  orientation: "vertical",
});

const openItem = shallowRef<MenuEntry | null>(null);
const subFocus = ref(false);
let subTimer: ReturnType<typeof setTimeout> | undefined;

function cancelSubClose() {
  clearTimeout(subTimer);
  subTimer = undefined;
}
function closeSub() {
  cancelSubClose();
  openItem.value = null;
}
function openSub(entry: MenuEntry, focus: boolean) {
  cancelSubClose();
  if (openItem.value === entry) {
    if (!focus) return;
    // Opened by the pointer and now asked for by a key: reopen so the submenu takes focus on mount.
    openItem.value = null;
    void nextTick(() => openSub(entry, true));
    return;
  }
  subFocus.value = focus;
  openItem.value = entry;
}

function closeAll() {
  if (parent) parent.closeAll();
  else emit("close");
}

function activate(entry: MenuEntry) {
  if (entry.disabled()) return;
  if (entry.hasSub()) {
    openSub(entry, true);
    return;
  }
  closeAll();
  entry.select();
}

const treeEls = new Set<HTMLElement>();
const inTree = (n: Node) => !!el.value?.contains(n) || [...treeEls].some((t) => t.contains(n));

const ctx: MenuContext = {
  register(entry) {
    entries.value = [...entries.value, entry].sort(before);
    return () => {
      entries.value = entries.value.filter((e) => e !== entry);
      if (openItem.value === entry) closeSub();
    };
  },
  hasChecks: computed(() => entries.value.some((e) => e.checkable())),
  tabindex: (entry) => roving.tabindex(entries.value.indexOf(entry)),
  onItemFocus: (entry) => roving.onFocus(entries.value.indexOf(entry)),
  openItem,
  subFocus,
  activate,
  openSub,
  closeSub,
  // Hover intent: a diagonal move toward an open submenu crosses sibling rows, so a sibling only schedules the close.
  hoverItem(entry) {
    if (entry.hasSub() && !entry.disabled()) openSub(entry, false);
    else if (openItem.value) {
      cancelSubClose();
      subTimer = setTimeout(closeSub, 300);
    }
  },
  cancelSubClose,
  closeAll,
  addTreeEl(node) {
    if (parent) return parent.addTreeEl(node);
    treeEls.add(node);
    return () => treeEls.delete(node);
  },
};
provide(MENU, ctx);

let typed = "";
let typedAt = 0;
function typeahead(e: KeyboardEvent, cur: MenuEntry | undefined) {
  if (e.key.length !== 1 || e.key === " ") return;
  const now = Date.now();
  typed = now - typedAt > 500 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
  typedAt = now;
  const list = entries.value;
  // The same letter pressed again steps through the items it starts.
  const repeat = [...typed].every((c) => c === typed[0]);
  const needle = repeat ? typed[0]! : typed;
  const from = cur ? list.indexOf(cur) : -1;
  const start = repeat || from < 0 ? from + 1 : from;
  for (let k = 0; k < list.length; k++) {
    const i = (start + k) % list.length;
    const it = list[i]!;
    if (!it.disabled() && it.label().toLowerCase().startsWith(needle)) {
      e.preventDefault();
      roving.focus(i);
      return;
    }
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const cur = entries.value.find((x) => {
    const n = x.el();
    return !!n && (n === e.target || n.contains(e.target as Node));
  });
  switch (e.key) {
    case "Enter":
    case " ":
      if (cur) {
        e.preventDefault();
        activate(cur);
      }
      return;
    case "ArrowRight":
      if (cur?.hasSub() && !cur.disabled()) {
        e.preventDefault();
        openSub(cur, true);
      }
      return;
    case "ArrowLeft":
      if (props.submenu) {
        e.preventDefault();
        emit("close");
      }
      return;
    case "Tab":
      e.preventDefault();
      closeAll();
      return;
    case "Escape":
      return;
  }
  roving.onKeydown(e);
  if (!e.defaultPrevented) typeahead(e, cur);
}

function onEsc(e: KeyboardEvent) {
  if (e.key !== "Escape" || !layer.isTop()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  emit("close");
}

function onDown(e: PointerEvent) {
  const t = e.target as Node;
  if (inTree(t) || props.anchor?.contains(t)) return;
  emit("close");
}

const pos = ref({ left: -9999, top: -9999 });
const placed = ref(false);
function place() {
  const box = el.value;
  if (!box) return;
  const a = props.at;
  const r = a ? { left: a.x, top: a.y, right: a.x, bottom: a.y } : props.anchor?.getBoundingClientRect();
  if (!r) return;
  const p = placeBeside(
    r,
    { width: box.offsetWidth, height: box.offsetHeight },
    a ? "right" : props.side,
    { width: window.innerWidth, height: window.innerHeight },
    { gap: a ? 0 : props.gap, align: a ? "start" : props.align, margin: 4 },
  );
  pos.value = { left: p.left, top: p.top };
}

const releaseEscape = claimEscape();
const layer = escapeLayer();
const back = focusReturn(() => props.anchor);
let releaseTree = () => {};

onMounted(async () => {
  if (parent && el.value) releaseTree = parent.addTreeEl(el.value);
  await nextTick();
  place();
  placed.value = true;
  await nextTick();
  if (props.focus === "first") roving.focus(roving.stop.value);
  window.addEventListener("keydown", onEsc, true);
  window.addEventListener("resize", place);
  if (!parent) document.addEventListener("pointerdown", onDown, true);
});
onBeforeUnmount(() => {
  if (!parent) back.restore(inTree);
  else if (el.value?.contains(document.activeElement) || document.activeElement === document.body) {
    props.anchor?.focus();
  }
});
onUnmounted(() => {
  releaseEscape();
  layer.release();
  releaseTree();
  cancelSubClose();
  window.removeEventListener("keydown", onEsc, true);
  window.removeEventListener("resize", place);
  document.removeEventListener("pointerdown", onDown, true);
});

defineExpose({ place });
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="ui-menu"
      :class="{ 'ui-submenu': submenu, 'has-checks': ctx.hasChecks.value }"
      role="menu"
      :aria-label="label"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, visibility: placed ? undefined : 'hidden' }"
      @keydown="onKeydown"
      @pointerenter="parent?.cancelSubClose()"
    >
      <slot />
    </div>
  </Teleport>
</template>
