<script setup lang="ts">
import { computed, mergeProps, useAttrs, useTemplateRef, watch } from "vue";
import { useCommitField } from "./useCommitField";
import { useDisabled } from "./useDisabled";
import { fmtKeys } from "../../input/platform";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** `live` emits on every input, `change` on Enter or blur with Escape reverting. */
    commit?: "live" | "change";
    type?: "text" | "search" | "url";
    placeholder?: string | undefined;
    /** A refusal from outside, shown as a refused commit is. */
    error?: string | null | undefined;
    /** The reason the text cannot commit, or null. */
    validate?: ((text: string) => string | null) | undefined;
    selectOnFocus?: boolean;
    size?: "sm" | "md";
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean | undefined;
    disabledReason?: string | undefined;
  }>(),
  { commit: "live", type: "text", selectOnFocus: false, size: "md", disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [string] }>();

const attrs = useAttrs();
const el = useTemplateRef<HTMLInputElement>("el");
const d = useDisabled(props);
const field = useCommitField({
  source: () => props.modelValue,
  el,
  live: () => props.commit === "live",
  apply(raw) {
    const err = props.validate?.(raw) ?? null;
    if (!err && raw !== props.modelValue) emit("update:modelValue", raw);
    return err;
  },
});
const { draft } = field;
// Live mode emits each keystroke, so a value unlike the draft came from the owner (a search cleared on Escape) and
// shows even mid edit; only refused text holds.
watch(
  () => props.modelValue,
  (v) => {
    if (props.commit === "live" && v !== draft.value && !field.error.value) field.revert();
  },
);

const shownError = computed(() => field.error.value ?? props.error ?? null);
const tipText = computed(() => (props.tip ? fmtKeys(props.keys ? `${props.tip} (${props.keys})` : props.tip) : null));

/** Everything a caller passes lands on the input, except the layout of the well. */
function inputAttrs() {
  const { class: _c, style: _s, ...rest } = attrs;
  return mergeProps(rest, d.bind.value);
}

function onInput(e: Event) {
  const input = e.target as HTMLInputElement;
  if (d.isDisabled.value) input.value = draft.value;
  else field.input(input.value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") field.commit();
  else if (e.key === "Escape") field.revert();
}
</script>

<template>
  <span
    class="ui-field ui-text-field"
    :class="[`ui-field-${size}`, attrs.class, { 'is-error': !!shownError, 'is-disabled': d.isDisabled.value }]"
    :style="attrs.style as string | undefined"
    @mousedown.self.prevent="el?.focus()"
  >
    <slot name="leading" />
    <input
      ref="el"
      v-bind="inputAttrs()"
      :value="draft"
      :type="type"
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
    <slot name="trailing" />
  </span>
</template>
