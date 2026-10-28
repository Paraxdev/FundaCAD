<script setup lang="ts">
import { computed, mergeProps, useAttrs, useTemplateRef, watch } from "vue";
import UnitChip from "./UnitChip.vue";
import { useCommitField } from "./useCommitField";
import { useDisabled } from "./useDisabled";
import { fmtKeys } from "../../input/platform";
import {
  formatMeasure,
  parseMeasure,
  roundForDisplay,
  toUnit,
  tryParseMeasure,
  unitById,
  type UnitDef,
} from "../../ui/measure";

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
    /** The chip's title. */
    unitTip?: string | undefined;
    /** A unit written in committed text becomes the shown unit, through `update:unit`. */
    adoptUnit?: boolean;
    /** Reads typed text into the model's number, throwing an Error whose message is the reason. Default ui/measure.
     *  Null hands the text to `expression`. */
    parse?: ((raw: string, unit: UnitDef | null) => number | null) | undefined;
    /** Commits, trimmed, the text `parse` returned null for (a parameter name, an expression), returning the refusal
     *  or null. It never previews. */
    expression?: ((raw: string) => string | null) | undefined;
    /** Shown in place of the model, such as the expression that drives it. Its arrows move the caret, not the value,
     *  and a typed number commits even when it equals the model. */
    text?: string | null | undefined;
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
  {
    commit: "change",
    adoptUnit: false,
    step: 1,
    nullable: false,
    selectOnFocus: false,
    size: "md",
    disabled: false,
  },
);
const emit = defineEmits<{
  "update:modelValue": [number | null];
  "update:unit": [string];
  /** The reason the field refuses its text, and null once it does not, for a row that prints it. */
  error: [string | null];
}>();

const attrs = useAttrs();
const el = useTemplateRef<HTMLInputElement>("el");
const d = useDisabled(props);
const unitDef = computed(() => unitById(props.unit));

const spell = (v: number | null) => (v === null ? "" : String(toUnit(v, unitDef.value)));
const caption = (v: number) =>
  unitDef.value ? formatMeasure(v, unitDef.value) : `${roundForDisplay(v)}${props.unit ? ` ${props.unit}` : ""}`;

/** Null for an expression. */
function read(raw: string): number | null {
  const v = props.parse ? props.parse(raw, unitDef.value) : parseMeasure(raw, unitDef.value).value;
  if (v === null) {
    if (props.expression) return null;
    throw new Error("Not a number");
  }
  if (!Number.isFinite(v)) throw new Error("Not a number");
  return v;
}

/** A null value is blank text, or an expression when `expr` says so. */
function check(raw: string): { value: number | null; error: string | null; expr?: true } {
  if (raw.trim() === "") return { value: null, error: null };
  let v: number | null;
  try {
    v = read(raw);
  } catch (e) {
    return { value: null, error: e instanceof Error && e.message ? e.message : "Not a value" };
  }
  if (v === null) return { value: null, error: null, expr: true };
  if (props.min !== undefined && v < props.min) return { value: v, error: `At least ${caption(props.min)}` };
  if (props.max !== undefined && v > props.max) return { value: v, error: `At most ${caption(props.max)}` };
  return { value: v, error: props.validate?.(v) ?? null };
}

function previewDraft(raw: string) {
  const c = check(raw);
  if (!c.error && !c.expr && (c.value !== null || props.nullable)) props.preview?.(c.value);
}

function adopt(raw: string) {
  const u = tryParseMeasure(raw, unitDef.value)?.unit;
  if (u && u.id !== unitDef.value?.id && (!unitDef.value || u.dim === unitDef.value.dim)) emit("update:unit", u.id);
}

const field = useCommitField({
  source: () => props.text ?? spell(props.modelValue),
  el,
  live: () => props.commit === "live",
  apply(raw) {
    const c = check(raw);
    if (c.error) return c.error;
    if (c.expr) return props.expression?.(raw.trim()) ?? null;
    // A blank required field commits nothing, and the field reads the model back.
    if (c.value === null && !props.nullable) return null;
    if (c.value !== props.modelValue || props.text != null) emit("update:modelValue", c.value);
    if (props.adoptUnit) adopt(raw);
    return null;
  },
  preview: () => (props.preview ? previewDraft : undefined),
  previewEnd: () => props.previewEnd,
});
const { draft } = field;
watch(field.error, (e) => emit("error", e));

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
    if (draft.value.trim() !== "") base = read(draft.value) ?? base;
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
  else if (
    (e.key === "ArrowUp" || e.key === "ArrowDown") &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    props.text == null
  ) {
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
      :tip="unitTip"
      :disabled="disabled"
      @update:unit="emit('update:unit', $event)"
    />
    <slot name="trailing" />
  </span>
</template>
