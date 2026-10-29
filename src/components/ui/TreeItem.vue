<script setup lang="ts">
import { computed, inject, watch } from "vue";
import { useName, type NameProps } from "./useName";
import { TREE, type TreeItemActions } from "./treeContext";

const props = withDefaults(
  defineProps<
    {
      itemKey: string;
      selected?: boolean;
      /** False for a row that cannot be picked, such as an empty note: it then carries no aria-selected. */
      selectable?: boolean;
      describedby?: string | undefined;
      as?: string;
      actions?: TreeItemActions | undefined;
      /** True while the row has nothing to show: its content stays mounted, hidden, and the row leaves the tree. The
       *  Tree's items must leave its key out too. */
      absent?: boolean;
    } & NameProps
  >(),
  { selected: false, selectable: true, describedby: undefined, as: "div", actions: undefined, absent: false },
);

const tree = inject(TREE, null);
// A row names itself by its label element, its text content would also read the eye and caret names.
const name = useName(props, "TreeItem");
const s = computed(() => tree?.slot(props.itemKey));
const row = computed(() => ({
  role: "treeitem",
  "data-tree-item": "",
  ...name.value,
  tabindex: tree?.tabindex(props.itemKey),
  "aria-level": s.value?.level,
  "aria-posinset": s.value?.posinset,
  "aria-setsize": s.value?.setsize,
  "aria-selected": props.selectable ? (props.selected ? "true" : "false") : undefined,
  "aria-expanded": s.value?.expandable ? (s.value.expanded ? "true" : "false") : undefined,
  "aria-disabled": s.value?.disabled ? "true" : undefined,
  "aria-describedby": props.describedby,
}));
// Outside a Tree a treeitem would be an orphan role, so the row draws as a plain element there.

watch(
  () => props.itemKey,
  (key, _, onCleanup) => {
    if (tree) onCleanup(tree.actions(key, () => props.actions ?? {}));
  },
  { immediate: true },
);
</script>

<template>
  <component :is="as" v-if="tree" v-bind="absent ? { hidden: true } : row" @focus="absent || tree.onItemFocus(itemKey)">
    <slot />
  </component>
  <component :is="as" v-else><slot /></component>
</template>
