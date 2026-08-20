<script setup lang="ts">
// A labelled row whose value is on or off.
//
// A switch rather than a checkbox: the row already reads as a setting with a
// state, and a switch says "this is currently on" at a glance across a column
// of them, which is the thing a checkbox is worst at. It is still a real
// <input type="checkbox"> underneath, so it keeps the keyboard behaviour, the
// label association and the focus ring for free.

defineProps<{
  label: string;
  value: boolean;
  commit: (value: boolean) => void;
  rowTitle?: string | undefined;
}>();
</script>

<template>
  <div class="param-row" :title="rowTitle">
    <label :for="`tg-${label}`">{{ label }}</label>
    <div class="param-value">
      <label class="param-switch">
        <input
          :id="`tg-${label}`"
          type="checkbox"
          :checked="value"
          @change="commit(($event.target as HTMLInputElement).checked)"
        />
        <span class="track"><span class="knob"></span></span>
      </label>
    </div>
  </div>
</template>
