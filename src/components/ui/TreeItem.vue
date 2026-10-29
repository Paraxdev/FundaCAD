<script setup lang="ts">
import { computed, inject } from "vue";
import { useName, type NameProps } from "./useName";
import { TREE } from "./treeContext";

const props = withDefaults(
  defineProps<
    {
      itemKey: string;
      selected?: boolean;
      /** False for a row that cannot be picked, such as an empty note: it then carries no aria-selected. */
      selectable?: boolean;
      describedby?: string | undefined;
      as?: string;
    } & NameProps
  >(),
  { selected: false, selectable: true, describedby: undefined, as: "div" },
);

const tree = inject(TREE, null);
// A row names itself by its label element, its text content would also read the eye and caret names.
const name = useName(props, "TreeItem");
const s = computed(() => tree?.slot(props.itemKey));
</script>

<template>
  <component
    :is="as"
    role="treeitem"
    data-tree-item
    v-bind="name"
    :tabindex="tree ? tree.tabindex(itemKey) : -1"
    :aria-level="s?.level"
    :aria-posinset="s?.posinset"
    :aria-setsize="s?.setsize"
    :aria-selected="selectable ? (selected ? 'true' : 'false') : undefined"
    :aria-expanded="s?.expandable ? (s.expanded ? 'true' : 'false') : undefined"
    :aria-disabled="s?.disabled ? 'true' : undefined"
    :aria-describedby="describedby"
    @focus="tree?.onItemFocus(itemKey)"
  >
    <slot />
  </component>
</template>
