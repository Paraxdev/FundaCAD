<script setup lang="ts">
import { computed, useId } from "vue";

const props = withDefaults(
  defineProps<{
    label: string;
    /** The control's id, when the caller owns it; else one is made and handed to the slot. Null draws no `for`, for a
     *  control named by `aria-labelledby`. */
    for?: string | null | undefined;
    hint?: string | undefined;
    /** `param` is the inspector's row and keeps the `.param-row` classes the harness reads. `inline` and `param` wrap: a control that does not fit beside its label moves under it. */
    layout?: "inline" | "stacked" | "param";
    /** Extra classes for the `param` layout's value column. */
    controlClass?: string | undefined;
    /** A fixed label column for the `param` layout, such as "96px". The control still moves under when it does not fit. */
    labelWidth?: string | undefined;
    /** Shown in place of the hint, and the control is marked invalid. */
    error?: string | undefined;
  }>(),
  {
    for: undefined,
    hint: undefined,
    layout: "inline",
    controlClass: undefined,
    labelWidth: undefined,
    error: undefined,
  },
);
defineSlots<{
  default(props: {
    id: string;
    labelId: string;
    /** The hint's id. The error is not in it: a field speaks its own, and a control that does not points at `errorId`. */
    describedby: string | undefined;
    errorId: string | undefined;
    invalid: boolean;
  }): unknown;
}>();

const ownId = useId();
const hintId = useId();
const errorId = useId();
const labelId = useId();
const controlId = computed(() => props.for ?? ownId);
const labelFor = computed(() => (props.for === null ? undefined : controlId.value));
const note = computed(() => props.error || props.hint);
</script>

<template>
  <div v-if="layout === 'param'" class="param-row">
    <label :id="labelId" :for="labelFor" :style="labelWidth ? { flex: `0 0 ${labelWidth}` } : undefined">{{
      label
    }}</label>
    <div class="param-value" :class="controlClass">
      <slot
        :id="controlId"
        :label-id="labelId"
        :describedby="hint && !error ? hintId : undefined"
        :error-id="error ? errorId : undefined"
        :invalid="!!error"
      />
    </div>
    <p v-if="error" :id="errorId" class="param-problem" aria-hidden="true">{{ error }}</p>
    <div v-else-if="hint" :id="hintId" class="ui-field-hint">{{ hint }}</div>
  </div>
  <div v-else class="ui-field-row" :class="[`ui-field-row-${layout}`, { 'is-error': !!error }]">
    <label :id="labelId" class="ui-field-label" :for="controlId">{{ label }}</label>
    <div class="ui-field-control">
      <slot
        :id="controlId"
        :label-id="labelId"
        :describedby="hint && !error ? hintId : undefined"
        :error-id="error ? errorId : undefined"
        :invalid="!!error"
      />
    </div>
    <div v-if="note" :id="error ? errorId : hintId" class="ui-field-hint" :aria-hidden="error ? 'true' : undefined">
      {{ note }}
    </div>
  </div>
</template>
