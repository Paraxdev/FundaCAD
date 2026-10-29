<script setup lang="ts">
import { computed, mergeProps, useAttrs, useTemplateRef, watch } from "vue";
import { useCommitField } from "./useCommitField";
import { useDisabled } from "./useDisabled";
import { useName, type Named } from "./useName";
import { fmtKeys } from "../../input/platform";

defineOptions({ inheritAttrs: false });

// No withDefaults: over the Named union it collapses the type check to any props.
const props = defineProps<
  {
    modelValue: string;
    /** `live` emits on every input, `change` on Enter or blur with Escape reverting. */
    commit?: "live" | "change";
    type?: "text" | "search" | "url";
    /** A textarea: Enter types a new line, so `change` mode commits on blur only. Pass `rows` as an attribute. */
    multiline?: boolean;
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
  } & Named
>();
const emit = defineEmits<{ "update:modelValue": [string] }>();

const attrs = useAttrs();
const el = useTemplateRef<HTMLInputElement | HTMLTextAreaElement>("el");
const d = useDisabled(props);
const name = useName(props, "TextField");
const field = useCommitField({
  source: () => props.modelValue,
  el,
  live: () => props.commit !== "change",
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
    if (props.commit !== "change" && v !== draft.value && !field.error.value) field.revert();
  },
);

defineExpose({ focus: () => el.value?.focus() });

const shownError = computed(() => field.error.value ?? props.error ?? null);
const tipText = computed(() => (props.tip ? fmtKeys(props.keys ? `${props.tip} (${props.keys})` : props.tip) : null));

/** Everything a caller passes lands on the input, except the layout of the well. */
function inputAttrs() {
  const { class: _c, style: _s, ...rest } = attrs;
  return mergeProps(rest, d.bind.value, name.value);
}

function onInput(e: Event) {
  const input = e.target as HTMLInputElement | HTMLTextAreaElement;
  if (d.isDisabled.value) input.value = draft.value;
  else field.input(input.value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !props.multiline) field.commit();
  else if (e.key === "Escape") field.revert();
}
</script>

<template>
  <span
    class="ui-field ui-text-field"
    :class="[
      `ui-field-${size ?? 'md'}`,
      attrs.class,
      { 'is-error': !!shownError, 'is-disabled': d.isDisabled.value, 'is-multiline': multiline },
    ]"
    :style="attrs.style as string | undefined"
    @mousedown.self.prevent="el?.focus()"
  >
    <slot name="leading" />
    <component
      :is="multiline ? 'textarea' : 'input'"
      ref="el"
      v-bind="inputAttrs()"
      :value="draft"
      :type="multiline ? undefined : (type ?? 'text')"
      :placeholder="placeholder"
      :readonly="d.isDisabled.value || undefined"
      :aria-invalid="shownError ? 'true' : undefined"
      :title="d.title(shownError ?? tipText ?? (attrs.title as string | undefined))"
      @input="onInput"
      @keydown="onKeydown"
      @blur="field.blur()"
      @focus="selectOnFocus && el?.select()"
    />
    <slot name="trailing" />
  </span>
</template>
