<script setup lang="ts">
import { computed, mergeProps, useAttrs, useTemplateRef } from "vue";
import UnitChip from "./UnitChip.vue";
import { useCommitField } from "./useCommitField";
import { useDisabled } from "./useDisabled";
import { fmtKeys } from "../../input/platform";
import { formatMeasure, parseMeasure, roundForDisplay, toUnit, unitById, type UnitDef } from "../../ui/measure";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** Canonical when `unit` is a ui/measure unit: mm for a length, degrees for an angle. */
    modelValue: number | null;
    /** `change` commits on Enter or blur with Escape reverting, `live` on every input that reads. */
    commit?: "live" | "change";
    /** A ui/measure unit id is the shown unit: the field shows the model in it and a bare typed number means it,
     *  while a typed unit wins. Any other text is only a caption. */
    unit?: string | null | undefined;
    /** Unit ids the chip offers; picking one emits `update:unit`. */
    units?: readonly string[] | undefined;
    /** Reads typed text into the model's number, throwing an Error whose message is the reason. Default ui/measure. */
    parse?: ((raw: string, unit: UnitDef | null) => number) | undefined;
    /** The reason a read value cannot commit, or null. */
    validate?: ((value: number) => string | null) | undefined;
    /** A refusal from outside: the kernel could not build what the value says. Only the caller withdraws it. */
    problem?: string | null | undefined;
    min?: number | undefined;
    max?: number | undefined;
    /** In the shown unit, ten times with Shift. */
    step?: number;
    /** A blank field means null instead of the last value. */
    nullable?: boolean;
    /** Shows what the draft would do, on a debounce while typing in `change` mode; text that does not read is
     *  skipped. */
    preview?: ((value: number | null) => void) | undefined;
    previewEnd?: ((committing: boolean) => void) | undefined;
    /** The input width in characters, for a column of values. */
    widthCh?: number | undefined;
    placeholder?: string | undefined;
    selectOnFocus?: boolean;
    size?: "sm" | "md";
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean | undefined;
    disabledReason?: string | undefined;
  }>(),
  { commit: "change", step: 1, nullable: false, selectOnFocus: false, size: "md", disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [number | null]; "update:unit": [string] }>();

const attrs = useAttrs();
const el = useTemplateRef<HTMLInputElement>("el");
const d = useDisabled(props);
const unitDef = computed(() => unitById(props.unit));

const spell = (v: number | null) => (v === null ? "" : String(toUnit(v, unitDef.value)));
const caption = (v: number) =>
  unitDef.value ? formatMeasure(v, unitDef.value) : `${roundForDisplay(v)}${props.unit ? ` ${props.unit}` : ""}`;

function read(raw: string): number {
  const v = props.parse ? props.parse(raw, unitDef.value) : parseMeasure(raw, unitDef.value).value;
  if (!Number.isFinite(v)) throw new Error("Not a number");
  return v;
}

/** Null for blank text. */
function check(raw: string): { value: number | null; error: string | null } {
  if (raw.trim() === "") return { value: null, error: null };
  let v: number;
  try {
    v = read(raw);
  } catch (e) {
    return { value: null, error: e instanceof Error && e.message ? e.message : "Not a value" };
  }
  if (props.min !== undefined && v < props.min) return { value: v, error: `At least ${caption(props.min)}` };
  if (props.max !== undefined && v > props.max) return { value: v, error: `At most ${caption(props.max)}` };
  return { value: v, error: props.validate?.(v) ?? null };
}

function previewDraft(raw: string) {
  const c = check(raw);
  if (!c.error && (c.value !== null || props.nullable)) props.preview?.(c.value);
}

const field = useCommitField({
  source: () => spell(props.modelValue),
  el,
  live: () => props.commit === "live",
  apply(raw) {
    const c = check(raw);
    if (c.error) return c.error;
    // A blank required field commits nothing, and the field reads the model back.
    if (c.value === null && !props.nullable) return null;
    if (c.value !== props.modelValue) emit("update:modelValue", c.value);
    return null;
  },
  preview: () => (props.preview ? previewDraft : undefined),
  previewEnd: () => props.previewEnd,
});
const { draft } = field;

const shownError = computed(() => field.error.value ?? props.problem ?? null);
const tipText = computed(() => (props.tip ? fmtKeys(props.keys ? `${props.tip} (${props.keys})` : props.tip) : null));

function inputAttrs() {
  const { class: _c, style: _s, ...rest } = attrs;
  return mergeProps(rest, d.bind.value);
}

function onInput(e: Event) {
  const input = e.target as HTMLInputElement;
  if (d.isDisabled.value) input.value = draft.value;
  else field.input(input.value);
}

function stepBy(dir: 1 | -1, big: boolean) {
  const factor = unitDef.value?.factor ?? 1;
  let base = props.modelValue ?? props.min ?? 0;
  try {
    if (draft.value.trim() !== "") base = read(draft.value);
  } catch {
    // Unreadable text steps from the model.
  }
  let next = roundForDisplay(base / factor + dir * props.step * (big ? 10 : 1)) * factor;
  if (props.min !== undefined) next = Math.max(props.min, next);
  if (props.max !== undefined) next = Math.min(props.max, next);
  field.input(spell(next));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") field.commit();
  else if (e.key === "Escape") field.revert();
  else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (!d.isDisabled.value) stepBy(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
  }
}
</script>

<template>
  <span
    class="ui-field ui-number-field"
    :class="[
      `ui-field-${size}`,
      attrs.class,
      { 'is-error': !!shownError, 'is-disabled': d.isDisabled.value, 'has-ch': widthCh !== undefined },
    ]"
    :style="[attrs.style as string | undefined, widthCh !== undefined ? { '--field-ch': widthCh } : {}]"
    @mousedown.self.prevent="el?.focus()"
  >
    <input
      ref="el"
      v-bind="inputAttrs()"
      :value="draft"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      spellcheck="false"
      :placeholder="placeholder"
      :readonly="d.isDisabled.value || undefined"
      :aria-invalid="shownError ? 'true' : undefined"
      :title="d.title(shownError ?? tipText ?? (attrs.title as string | undefined))"
      :aria-label="tipText ?? (attrs['aria-label'] as string | undefined)"
      @input="onInput"
      @keydown="onKeydown"
      @blur="field.blur()"
      @focus="selectOnFocus && el?.select()"
    />
    <UnitChip
      v-if="unit"
      :unit="unit"
      :options="units"
      :disabled="disabled"
      @update:unit="emit('update:unit', $event)"
    />
    <slot name="trailing" />
  </span>
</template>
