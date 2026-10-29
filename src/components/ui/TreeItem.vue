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
    } & NameProps
  >(),
  { selected: false, selectable: true, describedby: undefined, as: "div", actions: undefined },
);

const tree = inject(TREE, null);
// A row names itself by its label element, its text content would also read the eye and caret names.
const name = useName(props, "TreeItem");
const s = computed(() => tree?.slot(props.itemKey));
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
  <component
    :is="as"
    v-if="tree"
    role="treeitem"
    data-tree-item
    v-bind="name"
    :tabindex="tree.tabindex(itemKey)"
    :aria-level="s?.level"
    :aria-posinset="s?.posinset"
    :aria-setsize="s?.setsize"
    :aria-selected="selectable ? (selected ? 'true' : 'false') : undefined"
    :aria-expanded="s?.expandable ? (s.expanded ? 'true' : 'false') : undefined"
    :aria-disabled="s?.disabled ? 'true' : undefined"
    :aria-describedby="describedby"
    @focus="tree.onItemFocus(itemKey)"
  >
    <slot />
  </component>
  <component :is="as" v-else><slot /></component>
</template>
