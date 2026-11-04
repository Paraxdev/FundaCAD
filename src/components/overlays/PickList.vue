<script setup lang="ts">
// One titled list of picked items with Clear all and a remove button per row, worn by the target editor and Mirror.
// A pickable row is a ListRow beside its Remove button, never around it: a button may not nest in a button.

import { computed } from "vue";
import { distinctNames } from "../../ui/pickNames";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
import ListRow from "../ui/ListRow.vue";

const props = defineProps<{
  label: string;
  rows: readonly { label: string; resolved?: boolean }[];
  empty: string;
  /** The section taking the next picks. */
  active?: boolean;
  held?: number | null;
  /** Rows take focus, light their geometry like a hover and pin on click. */
  pickable?: boolean;
}>();
const names = computed(() => distinctNames(props.rows.map((r) => r.label)));
defineEmits<{
  clear: [];
  remove: [i: number];
  hover: [i: number | null];
  focus: [i: number | null];
  pick: [i: number];
}>();
</script>

<template>
  <section class="tgt-section" :class="{ 'tgt-active': active }">
    <div class="tgt-fieldrow">
      <span class="tgt-field">{{ label }}</span>
      <Button
        class="tgt-clear"
        size="sm"
        tip="Remove every entry"
        :disabled="rows.length === 0"
        @click.stop="$emit('clear')"
      >
        Clear all
      </Button>
    </div>

    <!-- Scrolls rather than grows: a face set on an imported mesh can be dozens, and a taller panel loses Done. -->
    <ul class="tgt-list">
      <li v-for="(r, i) in rows" :key="i" class="tgt-item" :class="{ 'tgt-unresolved': r.resolved === false }">
        <ListRow
          v-if="pickable"
          class="tgt-label"
          :label="names[i]!"
          :selected="held === i"
          @focus="$emit('focus', i)"
          @blur="$emit('focus', null)"
          @pointerenter="$emit('hover', i)"
          @pointerleave="$emit('hover', null)"
          @click="$emit('pick', i)"
        />
        <span v-else class="tgt-label">{{ names[i] }}</span>
        <IconButton
          class="tgt-remove"
          icon="minus"
          :tip="`Remove ${names[i]}`"
          size="sm"
          variant="danger"
          @click.stop="$emit('remove', i)"
        />
      </li>
      <!-- Not an empty box: several targets mean something specific with
           nothing in them, and the row above already says which. -->
      <li v-if="rows.length === 0" class="tgt-none">{{ empty }}</li>
    </ul>
  </section>
</template>
