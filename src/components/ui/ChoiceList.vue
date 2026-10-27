<script setup lang="ts" generic="T extends string">
import { computed, useTemplateRef } from "vue";
import { useRovingFocus } from "./useRovingFocus";

const props = defineProps<{
  options: readonly {
    value: T;
    label: string;
    hint?: string | undefined;
    disabled?: boolean | undefined;
    /** Greyed but still answers a click. */ clickable?: boolean | undefined;
    title?: string | undefined;
  }[];
  modelValue: T | null;
  /** Set by a combobox that keeps focus itself (Select): the highlighted row, and no row takes focus. Left out, the
   *  list holds one Tab stop and the arrows move focus. */
  active?: number | undefined;
  /** Names each option `${id}-${index}`, for `aria-activedescendant`. */
  id?: string | undefined;
}>();
const emit = defineEmits<{ "update:modelValue": [T]; "update:active": [number] }>();

const driven = computed(() => props.active !== undefined);
const list = useTemplateRef<HTMLElement>("list");
const roving = useRovingFocus({
  items: () => props.options,
  active: () => props.options.findIndex((o) => o.value === props.modelValue),
  container: list,
  orientation: "vertical",
  wrap: false,
});

function pick(o: (typeof props.options)[number]) {
  if (o.disabled && !o.clickable) return;
  emit("update:modelValue", o.value);
}

function hover(i: number) {
  if (driven.value && i !== props.active && !props.options[i]?.disabled) emit("update:active", i);
}
</script>

<template>
  <div :id="id" ref="list" class="opt-list" role="listbox" @keydown="driven || roving.onKeydown($event)">
    <!-- Driven rows never take focus from the combobox, so a pointer pick keeps it on the trigger. -->
    <button
      v-for="(o, i) in options"
      :id="id ? `${id}-${i}` : undefined"
      :key="o.value"
      type="button"
      role="option"
      data-roving
      class="opt-row"
      :class="{
        selected: o.value === modelValue,
        'is-selected': o.value === modelValue,
        disabled: o.disabled,
        'is-disabled': o.disabled,
        'is-active': driven && i === active,
      }"
      :tabindex="driven ? -1 : roving.tabindex(i)"
      :aria-selected="o.value === modelValue"
      :aria-disabled="o.disabled || undefined"
      :title="o.title"
      @focus="roving.onFocus(i)"
      @pointermove="hover(i)"
      @mousedown="driven && $event.preventDefault()"
      @click="pick(o)"
    >
      <span class="opt-label">{{ o.label }}</span>
      <span v-if="o.hint" class="opt-hint">{{ o.hint }}</span>
    </button>
  </div>
</template>
