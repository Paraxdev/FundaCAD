<script setup lang="ts">
import { computed, mergeProps, ref, useAttrs, useId, watch } from "vue";
import { fmtKeys } from "../../input/platform";
import { useDisabled } from "./useDisabled";
import { useName, type Named } from "./useName";

defineOptions({ inheritAttrs: false });

// No withDefaults: over the Named union it collapses the type check to any props.
const props = defineProps<
  {
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    showValue?: boolean;
    unit?: string | undefined;
    /** `end` holds update:modelValue back until the drag is released. */
    commit?: "live" | "end";
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean;
    disabledReason?: string | undefined;
  } & Named
>();
const emit = defineEmits<{ "update:modelValue": [number]; commit: [number] }>();
defineSlots<{ value?(p: { value: number }): unknown }>();

const attrs = useAttrs();
const d = useDisabled(props);
const id = useId();
const name = useName(props, "Slider");
const lo = computed(() => props.min ?? 0);
const hi = computed(() => props.max ?? 100);
const inc = computed(() => props.step ?? 1);
const rootAttrs = computed(() => {
  const { "aria-label": _l, "aria-labelledby": _b, ...rest } = attrs;
  return mergeProps(rest, d.bind.value);
});
// A label is drawn, so the range is named by that text; otherwise by labelledby or a plugin's aria attribute.
const inputName = computed(() => (props.label ? { "aria-labelledby": `${id}-label` } : name.value));
const tipText = computed(() => (props.tip && props.keys ? `${props.tip} (${fmtKeys(props.keys)})` : props.tip));
const draft = ref<number | null>(null);
const shown = computed(() => draft.value ?? props.modelValue);
// A drag that ends where it began fires no change, so an outside update has to drop the draft.
watch(
  () => props.modelValue,
  () => (draft.value = null),
);
const fill = computed(() => {
  const span = hi.value - lo.value;
  return span > 0 ? `${((Math.min(Math.max(shown.value, lo.value), hi.value) - lo.value) / span) * 100}%` : "0%";
});
const readout = computed(() =>
  !props.unit ? String(shown.value) : props.unit === "%" ? `${shown.value}%` : `${shown.value} ${props.unit}`,
);

const decimals = computed(() => (String(inc.value).split(".")[1] ?? "").length);
function snap(v: number) {
  const n = Math.round((v - lo.value) / inc.value);
  const s = Math.min(Math.max(lo.value + n * inc.value, lo.value), hi.value);
  return Number(s.toFixed(decimals.value));
}

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  if (d.isDisabled.value) {
    el.value = String(props.modelValue);
    return;
  }
  const v = Number(el.value);
  if (props.commit !== "end") emit("update:modelValue", v);
  else draft.value = v;
}
function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  if (d.isDisabled.value) {
    el.value = String(props.modelValue);
    return;
  }
  const v = Number(el.value);
  draft.value = null;
  if (props.commit === "end" && v !== props.modelValue) emit("update:modelValue", v);
  emit("commit", v);
}

// The keys are stepped here, not natively, so a key press is one update and one commit in every engine.
function onKeydown(e: KeyboardEvent) {
  const big = Math.max(inc.value, (hi.value - lo.value) / 10);
  const to: Record<string, (v: number) => number> = {
    ArrowRight: (v) => v + inc.value,
    ArrowUp: (v) => v + inc.value,
    ArrowLeft: (v) => v - inc.value,
    ArrowDown: (v) => v - inc.value,
    PageUp: (v) => v + big,
    PageDown: (v) => v - big,
    Home: () => lo.value,
    End: () => hi.value,
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
  <div class="ui-slider" v-bind="rootAttrs" :title="d.title(tipText)">
    <span v-if="label" :id="`${id}-label`" class="ui-slider-label">{{ label }}</span>
    <input
      type="range"
      class="ui-slider-input"
      :min="lo"
      :max="hi"
      :step="inc"
      :value="shown"
      :style="{ '--ui-slider-fill': fill }"
      v-bind="inputName"
      :aria-valuetext="unit ? readout : undefined"
      :aria-disabled="disabled ? 'true' : undefined"
      @input="onInput"
      @change="onChange"
      @keydown="onKeydown"
    />
    <output v-if="showValue || $slots.value" class="ui-slider-value"
      ><slot name="value" :value="shown">{{ readout }}</slot></output
    >
  </div>
</template>
