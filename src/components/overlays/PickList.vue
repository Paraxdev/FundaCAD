<script setup lang="ts">
// One titled list of picked items with Clear all and a remove button per row, worn by the target editor and Mirror.

import Icon from "../shell/Icon.vue";

defineProps<{
  label: string;
  rows: readonly { label: string; resolved?: boolean }[];
  empty: string;
  /** The section taking the next picks. */
  active?: boolean;
  held?: number | null;
}>();
defineEmits<{
  clear: [];
  remove: [i: number];
  enter: [i: number];
  leave: [];
  pick: [i: number];
}>();
</script>

<template>
  <section class="tgt-section" :class="{ 'tgt-active': active }">
    <div class="tgt-fieldrow">
      <span class="tgt-field">{{ label }}</span>
      <button
        type="button"
        class="tgt-clear"
        :disabled="rows.length === 0"
        title="Remove every entry"
        @click.stop="$emit('clear')"
      >
        Clear all
      </button>
    </div>

    <!-- Scrolls rather than grows: a face set on an imported mesh can be dozens, and a taller panel loses Done. -->
    <ul class="tgt-list">
      <li
        v-for="(r, i) in rows"
        :key="i"
        class="tgt-item"
        :class="{ 'tgt-unresolved': r.resolved === false, 'tgt-held': held === i }"
        @pointerenter="$emit('enter', i)"
        @pointerleave="$emit('leave')"
        @click="$emit('pick', i)"
      >
        <span class="tgt-label">{{ r.label }}</span>
        <button
          type="button"
          class="tgt-remove"
          title="Remove this one"
          :aria-label="`Remove ${r.label}`"
          @click.stop="$emit('remove', i)"
        >
          <Icon name="minus" :size="14" />
        </button>
      </li>
      <!-- Not an empty box: several targets mean something specific with
           nothing in them, and the row above already says which. -->
      <li v-if="rows.length === 0" class="tgt-none">{{ empty }}</li>
    </ul>
  </section>
</template>
