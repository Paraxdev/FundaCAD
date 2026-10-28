<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { fmtKeys } from "../../input/platform";
import { useDisabled } from "./useDisabled";
import { announce } from "../../ui/announce";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    label?: string | undefined;
    showValue?: boolean;
    unit?: string | undefined;
    /** `end` holds update:modelValue back until the drag is released. */
    commit?: "live" | "end";
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean;
    disabledReason?: string | undefined;
  }>(),
  { min: 0, max: 100, step: 1, showValue: false, commit: "live", disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [number]; commit: [number] }>();
defineSlots<{ value?(p: { value: number }): unknown }>();

const d = useDisabled(props);
const id = useId();
const tipText = computed(() => (props.tip && props.keys ? `${props.tip} (${fmtKeys(props.keys)})` : props.tip));
const draft = ref<number | null>(null);
const shown = computed(() => draft.value ?? props.modelValue);
// A drag that ends where it began fires no change, so an outside update has to drop the draft.
watch(
  () => props.modelValue,
  () => (draft.value = null),
);
const fill = computed(() => {
  const span = props.max - props.min;
  return span > 0 ? `${((Math.min(Math.max(shown.value, props.min), props.max) - props.min) / span) * 100}%` : "0%";
});
const readoutOf = (v: number) => (!props.unit ? String(v) : props.unit === "%" ? `${v}%` : `${v} ${props.unit}`);
const readout = computed(() => readoutOf(shown.value));

const decimals = computed(() => (String(props.step).split(".")[1] ?? "").length);
function snap(v: number) {
  const n = Math.round((v - props.min) / props.step);
  const s = Math.min(Math.max(props.min + n * props.step, props.min), props.max);
  return Number(s.toFixed(decimals.value));
}

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  if (d.isDisabled.value) {
    el.value = String(props.modelValue);
    return;
  }
  const v = Number(el.value);
  if (props.commit === "live") emit("update:modelValue", v);
  else draft.value = v;
}
// A focused range speaks its own value for keys and a screen reader's own steps, so only a pointer drag is announced.
let dragged = false;
const onPointerdown = () => (dragged = true);
function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  const wasDrag = dragged;
  dragged = false;
  if (d.isDisabled.value) {
    el.value = String(props.modelValue);
    return;
  }
  const v = Number(el.value);
  draft.value = null;
  if (props.commit === "end" && v !== props.modelValue) emit("update:modelValue", v);
  emit("commit", v);
  if (wasDrag) announce([props.label ?? tipText.value, readoutOf(v)].filter(Boolean).join(" "), "polite", { key: id });
}

// The keys are stepped here, not natively, so a key press is one update and one commit in every engine.
function onKeydown(e: KeyboardEvent) {
  const big = Math.max(props.step, (props.max - props.min) / 10);
  const to: Record<string, (v: number) => number> = {
    ArrowRight: (v) => v + props.step,
    ArrowUp: (v) => v + props.step,
    ArrowLeft: (v) => v - props.step,
    ArrowDown: (v) => v - props.step,
    PageUp: (v) => v + big,
    PageDown: (v) => v - big,
    Home: () => props.min,
    End: () => props.max,
  };
  const move = to[e.key];
  if (!move || e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  if (d.isDisabled.value) return;
  const v = snap(move(props.modelValue));
  if (v === props.modelValue) return;
  draft.value = null;
  emit("update:modelValue", v);
  emit("commit", v);
}
</script>

<template>
  <div class="ui-slider" v-bind="d.bind.value" :title="d.title(tipText)">
    <span v-if="label" :id="`${id}-label`" class="ui-slider-label">{{ label }}</span>
    <input
      type="range"
      class="ui-slider-input"
      :min="min"
      :max="max"
      :step="step"
      :value="shown"
      :style="{ '--ui-slider-fill': fill }"
      :aria-labelledby="label ? `${id}-label` : undefined"
      :aria-label="label ? undefined : tipText"
      :aria-valuetext="unit ? readout : undefined"
      :aria-disabled="disabled ? 'true' : undefined"
      @pointerdown="onPointerdown"
      @input="onInput"
      @change="onChange"
      @keydown="onKeydown"
    />
    <output v-if="showValue || $slots.value" class="ui-slider-value" aria-live="off"
      ><slot name="value" :value="shown">{{ readout }}</slot></output
    >
  </div>
</template>
