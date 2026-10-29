<script setup lang="ts" generic="T extends string">
// A listbox whose options are the caller's own elements: the option slot draws every item, in order, and binds the
// attrs it is handed. Focus moves among them on one Tab stop, Space selects, Enter emits apply. A caller with its own
// pointer rules calls preventDefault in its click handler, else a click selects the option.

import { computed, onBeforeUnmount, useId, useTemplateRef } from "vue";
import { rovingIndex, useRovingFocus } from "./useRovingFocus";
import { useName, type Named } from "./useName";

interface Item {
  value: T;
  label: string;
  disabled?: boolean | undefined;
}

interface OptionAttrs {
  id: string;
  role: "option";
  tabindex: 0 | -1;
  "aria-selected": boolean;
  "aria-disabled": true | undefined;
  "data-roving": "";
  onFocus: () => void;
}

const props = defineProps<{ items: readonly Item[]; modelValue: T | null } & Named>();
const emit = defineEmits<{ "update:modelValue": [T]; apply: [T] }>();
defineSlots<{
  option(p: { item: Item; index: number; selected: boolean; attrs: OptionAttrs }): unknown;
}>();

const name = useName(props, "Listbox");
const id = useId();
const root = useTemplateRef<HTMLElement>("root");
const disabled = computed(() => props.items.map((it) => !!it.disabled));
const roving = useRovingFocus({
  items: () => props.items,
  active: () => props.items.findIndex((it) => it.value === props.modelValue),
  container: root,
});

const elements = () => [...(root.value?.querySelectorAll<HTMLElement>("[data-roving]") ?? [])];

function attrsOf(item: Item, i: number): OptionAttrs {
  return {
    id: `${id}-${i}`,
    role: "option",
    tabindex: roving.tabindex(i),
    "aria-selected": item.value === props.modelValue,
    "aria-disabled": item.disabled || undefined,
    "data-roving": "",
    onFocus: () => roving.onFocus(i),
  };
}

function select(i: number) {
  const it = props.items[i];
  if (it && !it.disabled && it.value !== props.modelValue) emit("update:modelValue", it.value);
}

// Measured at the keypress, so a dock resized to fewer columns steps by the rows it draws now.
function columns(els: readonly HTMLElement[]): number {
  const top = els[0]?.offsetTop;
  const n = els.findIndex((el) => el.offsetTop !== top);
  return n < 0 ? Math.max(els.length, 1) : n;
}

function step(from: number, delta: number): number {
  for (let i = from + delta; i >= 0 && i < disabled.value.length; i += delta) if (!disabled.value[i]) return i;
  return from;
}

let buffer = "";
let bufferTimer = 0;
const TYPE_AHEAD_MS = 500;

function typeAhead(ch: string, from: number): number {
  window.clearTimeout(bufferTimer);
  bufferTimer = window.setTimeout(() => (buffer = ""), TYPE_AHEAD_MS);
  buffer += ch.toLowerCase();
  // A repeated letter cycles through the options it starts; a word keeps the current match while it still fits.
  const cycling = [...buffer].every((c) => c === buffer[0]);
  const needle = cycling ? buffer[0]! : buffer;
  const n = props.items.length;
  const start = cycling ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const it = props.items[i]!;
    if (!it.disabled && it.label.toLowerCase().startsWith(needle)) return i;
  }
  return from;
}

function target(k: string, from: number, els: readonly HTMLElement[]): number | null {
  if (k === "ArrowLeft") return step(from, -1);
  if (k === "ArrowRight") return step(from, 1);
  if (k === "ArrowUp") return step(from, -columns(els));
  if (k === "ArrowDown") return step(from, columns(els));
  if (k === "Home" || k === "End") return rovingIndex(k, from, disabled.value);
  return null;
}

// Firefox clicks a button on the Space keyup, which would select again after Space already did.
let swallowSpaceUp = false;

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const els = elements();
  const hit = els.findIndex((el) => el.contains(e.target as Node));
  const from = hit >= 0 ? hit : roving.stop.value;
  if (from < 0) return;
  const k = e.key;
  if (k === "Enter" || (k === " " && buffer === "")) {
    e.preventDefault();
    const it = props.items[from];
    if (k === " ") {
      swallowSpaceUp = true;
      select(from);
    } else if (it && !it.disabled) emit("apply", it.value);
    return;
  }
  let next = target(k, from, els);
  if (next === null && k.length === 1) next = typeAhead(k, from);
  if (next === null) return;
  e.preventDefault();
  if (next !== from || hit < 0) roving.focus(next);
}

function onKeyup(e: KeyboardEvent) {
  if (e.key !== " " || !swallowSpaceUp) return;
  swallowSpaceUp = false;
  e.preventDefault();
}

function onClick(e: MouseEvent) {
  if (e.defaultPrevented) return;
  const i = elements().findIndex((el) => el.contains(e.target as Node));
  if (i >= 0) select(i);
}

onBeforeUnmount(() => window.clearTimeout(bufferTimer));
</script>

<template>
  <div v-bind="name" ref="root" role="listbox" @keydown="onKeydown" @keyup="onKeyup" @click="onClick">
    <template v-for="(item, i) in items" :key="item.value">
      <slot name="option" :item="item" :index="i" :selected="item.value === modelValue" :attrs="attrsOf(item, i)" />
    </template>
  </div>
</template>
