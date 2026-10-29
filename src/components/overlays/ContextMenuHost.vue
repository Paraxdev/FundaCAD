<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import Menu from "../ui/Menu.vue";
import MenuItem from "../ui/MenuItem.vue";
import MenuSeparator from "../ui/MenuSeparator.vue";
import { useContextMenuStore, type CtxItem } from "../../stores/contextMenu";
import { isEditableTarget } from "../../ui/focus";
import { guardMenuKeys } from "../../ui/menu";

const s = useContextMenuStore();
const menu = useTemplateRef<InstanceType<typeof Menu>>("menu");

// A menu opened over a text field leaves focus in it: moving focus would blur a rename into committing, and the field's
// own Cut, Copy and Paste need it back with its selection. A press on a row then keeps it there too.
let fieldKept = false;
function keepField(e: MouseEvent) {
  if (fieldKept) e.preventDefault();
}

// Row hover is tracked here, not left to pointerleave: a click, Escape or outside press closes the menu under the
// pointer with no leave event, stranding the preview lit.
let hovered: CtxItem | null = null;

function setHover(it: CtxItem | null) {
  if (hovered === it) return;
  hovered?.onHover?.(false);
  hovered = it;
  it?.onHover?.(true);
}
function unhover(it: CtxItem) {
  if (hovered === it) setHover(null);
}
// Keyboard focus lights a row as the pointer does, but not the focus the menu itself takes as a click opens it.
function onFocus(e: FocusEvent, it: CtxItem) {
  if (e.currentTarget instanceof HTMLElement && e.currentTarget.matches(":focus-visible")) setHover(it);
}

function rowAttrs(it: CtxItem) {
  return {
    class: ["ctx-item", { "has-swatch": !!it.swatch }],
    style: it.swatch ? { "--swatch": it.swatch } : undefined,
    label: it.label,
    icon: it.icon,
    keys: it.shortcut,
    checked: it.checked,
    danger: !!it.danger,
    disabled: !!it.disabled,
  };
}

function pick(it: CtxItem) {
  setHover(null);
  it.onClick?.();
}

function onClose() {
  setHover(null);
  s.close();
}

watch(
  () => s.epoch,
  () => {
    setHover(null);
    fieldKept = s.open && isEditableTarget(document.activeElement);
  },
  { flush: "sync" },
);

// A row added to an open menu (a late engine answer) can overflow the bottom. The menu places itself again, which
// leaves it where it is while it still fits, so the rows under the pointer stay put.
watch(
  () => s.items,
  async () => {
    const opened = s.epoch;
    await nextTick();
    if (s.open && opened === s.epoch) menu.value?.place();
  },
);

watch(
  () => s.open,
  (isOpen) => {
    if (!isOpen) setHover(null);
  },
);

let releaseKeys = () => {};
onMounted(() => (releaseKeys = guardMenuKeys()));
onUnmounted(() => {
  releaseKeys();
  setHover(null);
});
</script>

<template>
  <Menu
    v-if="s.open"
    ref="menu"
    :key="s.epoch"
    :at="{ x: s.x, y: s.y }"
    :focus="fieldKept ? 'none' : 'first'"
    @close="onClose"
  >
    <template v-for="(it, i) in s.items" :key="i">
      <MenuSeparator v-if="it.separator" />
      <MenuItem
        v-else-if="it.children"
        v-bind="rowAttrs(it)"
        @pointerenter="it.disabled || setHover(it)"
        @pointerleave="unhover(it)"
        @focus="onFocus($event, it)"
        @blur="unhover(it)"
        @mousedown="keepField"
      >
        <template v-for="(c, j) in it.children" :key="j">
          <MenuSeparator v-if="c.separator" />
          <MenuItem
            v-else
            v-bind="rowAttrs(c)"
            @select="pick(c)"
            @pointerenter="c.disabled || setHover(c)"
            @pointerleave="unhover(c)"
            @focus="onFocus($event, c)"
            @blur="unhover(c)"
            @mousedown="keepField"
          />
        </template>
      </MenuItem>
      <MenuItem
        v-else
        v-bind="rowAttrs(it)"
        @select="pick(it)"
        @pointerenter="it.disabled || setHover(it)"
        @pointerleave="unhover(it)"
        @focus="onFocus($event, it)"
        @blur="unhover(it)"
        @mousedown="keepField"
      />
    </template>
  </Menu>
</template>
