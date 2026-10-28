<script setup lang="ts">
import { computed, useId } from "vue";

const props = withDefaults(
  defineProps<{
    label: string;
    /** The control's id, when the caller owns it; else one is made and handed to the slot. */
    for?: string | undefined;
    hint?: string | undefined;
    layout?: "inline" | "stacked";
    /** Shown in place of the hint, and the control is marked invalid. */
    error?: string | undefined;
  }>(),
  { for: undefined, hint: undefined, layout: "inline", error: undefined },
);
defineSlots<{
  default(props: { id: string; labelId: string; describedby: string | undefined; invalid: boolean }): unknown;
}>();

const ownId = useId();
const hintId = useId();
const labelId = useId();
const controlId = computed(() => props.for ?? ownId);
const note = computed(() => props.error || props.hint);
</script>

<template>
  <div class="ui-field-row" :class="[`ui-field-row-${layout}`, { 'is-error': !!error }]">
    <label :id="labelId" class="ui-field-label" :for="controlId">{{ label }}</label>
    <div class="ui-field-control">
      <slot :id="controlId" :label-id="labelId" :describedby="note ? hintId : undefined" :invalid="!!error" />
    </div>
    <div v-if="note" :id="hintId" class="ui-field-hint">{{ note }}</div>
  </div>
</template>
