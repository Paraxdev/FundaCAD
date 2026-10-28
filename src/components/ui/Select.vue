<script setup lang="ts" generic="T extends string">
// A themed stand-in for <select>: the browser draws the open popup itself, out of reach of CSS, so this opens the
// shared Popover and ChoiceList instead. Focus stays on the trigger, the list follows by aria-activedescendant.

import { computed, mergeProps, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from "vue";
import Popover from "./Popover.vue";
import ChoiceList from "./ChoiceList.vue";
import { rovingIndex, rovingStop } from "./useRovingFocus";
import { useDisabled } from "./useDisabled";
import { useName, type Named } from "./useName";
import { fmtKeys } from "../../input/platform";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<
    {
      modelValue: T;
      options: readonly { value: T; label: string; hint?: string | undefined; disabled?: boolean | undefined }[];
      id?: string | undefined;
      testid?: string | undefined;
      disabled?: boolean | undefined;
      disabledReason?: string | undefined;
      /** Shown when no option holds the value. */
      placeholder?: string | undefined;
      size?: "sm" | "md";
      /** `chip` draws the trigger as a UnitChip picker, a quiet word beside a value instead of a well. */
      variant?: "field" | "chip";
      tip?: string | undefined;
      keys?: string | undefined;
    } & Named
  >(),
  { disabled: false, size: "md", variant: "field" },
);

const emit = defineEmits<{ "update:modelValue": [T] }>();

const d = useDisabled(props);
const name = useName(props, "Select");
// The open list carries the trigger's own name: labelledby the trigger would read its value when the trigger is
// itself labelledby another element.
const listName = computed<Named>(() => {
  const by = name.value["aria-labelledby"];
  return by ? { labelledby: by } : { label: name.value["aria-label"] ?? "" };
});
const open = ref(false);
const active = ref(-1);
const btn = useTemplateRef<HTMLButtonElement>("btn");
const listId = `${useId()}-list`;
/** Measured on open: the list reads as this field's list when it is at least as
 *  wide as the field, and these fields stretch to fill their row. */
const width = ref(0);

const flags = computed(() => props.options.map((o) => !!o.disabled));
const selected = computed(() => props.options.findIndex((o) => o.value === props.modelValue));
const tipText = computed(() => (props.tip ? fmtKeys(props.keys ? `${props.tip} (${props.keys})` : props.tip) : null));
const shown = computed(() => props.options[selected.value]?.label ?? props.placeholder ?? props.modelValue);

function openAt(at: number) {
  if (d.isDisabled.value) return;
  width.value = btn.value?.offsetWidth ?? 0;
  active.value = at;
  open.value = true;
}

function close() {
  open.value = false;
  buffer = "";
  btn.value?.focus();
}

function toggle() {
  if (open.value) close();
  else openAt(rovingStop(selected.value, flags.value));
}

function pick(v: T) {
  close();
  if (v !== props.modelValue) emit("update:modelValue", v);
}

function pickActive() {
  const o = props.options[active.value];
  if (o && !o.disabled) pick(o.value);
  else close();
}

// Escape or a press outside, through the Popover. Only a focus the list took (a pointer pick, a scrollbar) or lost
// to the body comes back; a press on another control keeps the focus it moved there.
function onPopoverClose() {
  const f = document.activeElement;
  const back = !f || f === document.body || !!document.getElementById(listId)?.contains(f);
  open.value = false;
  buffer = "";
  if (back) btn.value?.focus();
}

let buffer = "";
let bufferTimer = 0;
const TYPE_AHEAD_MS = 500;

function typeAhead(ch: string) {
  window.clearTimeout(bufferTimer);
  bufferTimer = window.setTimeout(() => (buffer = ""), TYPE_AHEAD_MS);
  buffer += ch.toLowerCase();
  // A repeated letter cycles through the options it starts; a word keeps the current match while it still fits.
  const cycling = [...buffer].every((c) => c === buffer[0]);
  const needle = cycling ? buffer[0]! : buffer;
  const n = props.options.length;
  const from = cycling ? active.value + 1 : Math.max(active.value, 0);
  for (let k = 0; k < n; k++) {
    const i = (((from + k) % n) + n) % n;
    const o = props.options[i]!;
    if (!o.disabled && o.label.toLowerCase().startsWith(needle)) {
      active.value = i;
      return;
    }
  }
}

const typed = (e: KeyboardEvent) => e.key.length === 1 && !e.altKey && (e.key !== " " || buffer !== "");

// Firefox clicks a button on the Space keyup, which would reopen a list that Space just picked from.
let swallowSpaceUp = false;

function onKeydown(e: KeyboardEvent) {
  handleKey(e);
  if (e.key === " ") swallowSpaceUp = e.defaultPrevented;
}

function onKeyup(e: KeyboardEvent) {
  if (e.key !== " " || !swallowSpaceUp) return;
  swallowSpaceUp = false;
  e.preventDefault();
}

function handleKey(e: KeyboardEvent) {
  if (d.isDisabled.value || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
  const k = e.key;
  if (!open.value) {
    if (k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End") {
      e.preventDefault();
      const at = k === "Home" || k === "End" ? rovingIndex(k, -1, flags.value) : null;
      openAt(at ?? rovingStop(selected.value, flags.value));
    } else if (typed(e)) {
      e.preventDefault();
      openAt(rovingStop(selected.value, flags.value));
      typeAhead(k);
    }
    return;
  }
  if (k === "ArrowUp" && e.altKey) {
    e.preventDefault();
    pickActive();
    return;
  }
  if (e.altKey) return;
  if (k === "Enter" || (k === " " && buffer === "")) {
    e.preventDefault();
    pickActive();
    return;
  }
  if (k === "Tab") {
    open.value = false;
    buffer = "";
    return;
  }
  const next = rovingIndex(k, active.value, flags.value, { orientation: "vertical", wrap: false });
  if (next !== null) {
    e.preventDefault();
    active.value = next;
  } else if (typed(e)) {
    e.preventDefault();
    typeAhead(k);
  }
}

watch(active, async (i) => {
  if (!open.value || i < 0) return;
  await nextTick();
  document.getElementById(`${listId}-${i}`)?.scrollIntoView?.({ block: "nearest" });
});

onBeforeUnmount(() => window.clearTimeout(bufferTimer));
</script>

<template>
  <button
    ref="btn"
    v-bind="mergeProps($attrs, d.bind.value, name)"
    :id="id"
    type="button"
    role="combobox"
    :class="[
      variant === 'chip' ? 'ui-unit-chip is-picker' : 'sm-select select-trigger',
      `ui-select-${size}`,
      { open, 'is-open': open },
    ]"
    :title="d.title(tipText ?? ($attrs.title as string | undefined))"
    :data-testid="testid"
    :data-value="modelValue"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? listId : undefined"
    :aria-activedescendant="open && active >= 0 ? `${listId}-${active}` : undefined"
    @click="toggle"
    @keydown="onKeydown"
    @keyup="onKeyup"
  >
    <span class="select-value">{{ shown }}</span>
  </button>

  <Popover
    v-if="open"
    :anchor="btn"
    side="bottom"
    align="start"
    kind="select-pop"
    :min-width="width"
    @close="onPopoverClose"
  >
    <ChoiceList
      v-bind="listName"
      :id="listId"
      :options="options"
      :model-value="modelValue"
      :active="active"
      @update:model-value="pick"
      @update:active="active = $event"
    />
  </Popover>
</template>
