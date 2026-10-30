<script lang="ts">
export interface ListboxItem<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean | undefined;
}
</script>

<script setup lang="ts" generic="T extends string, I extends ListboxItem<T> = ListboxItem<T>">
// A listbox whose options are the caller's own elements: the option slot draws every item, in order, and binds the
// attrs it is handed. Focus moves among them on one Tab stop, Space selects, Enter emits apply. A caller with its own
// pointer rules calls preventDefault in its click handler, else a click selects the option. With multiple set the
// model is an array: Space toggles, Shift with an arrow or Space takes the run from the anchor, Cmd+A or Ctrl+A all.

import { computed, onBeforeUnmount, useId, useTemplateRef } from "vue";
import { rovingIndex, useRovingFocus } from "./useRovingFocus";
import { useName, type Named } from "./useName";
import { isMac } from "../../input/platform";
import { modsOf, selectRow, type SelectMods } from "../../ui/rowSelection";

interface OptionAttrs {
  id: string;
  role: "option";
  tabindex: 0 | -1;
  "aria-selected": boolean;
  "aria-disabled": true | undefined;
  "data-roving": "";
  onFocus: () => void;
}

const props = defineProps<
  {
    items: readonly I[];
    modelValue: T | null | readonly T[];
    multiple?: boolean;
    /** The option a Shift run starts from; left out, the listbox keeps its own. */
    anchor?: T | null;
  } & Named
>();
const emit = defineEmits<{ "update:modelValue": [T | T[]]; "update:anchor": [T]; apply: [T] }>();
defineSlots<{
  option(p: { item: I; index: number; selected: boolean; attrs: OptionAttrs }): unknown;
}>();

const name = useName(props, "Listbox");
const id = useId();
const root = useTemplateRef<HTMLElement>("root");
const disabled = computed(() => props.items.map((it) => !!it.disabled));
const picked = computed(() => {
  const v = props.modelValue;
  return new Set<T>(typeof v === "string" ? [v] : (v ?? []));
});
const roving = useRovingFocus({
  items: () => props.items,
  active: () => props.items.findIndex((it) => picked.value.has(it.value)),
  container: root,
});

const elements = () => [...(root.value?.querySelectorAll<HTMLElement>("[data-roving]") ?? [])];

function attrsOf(item: I, i: number): OptionAttrs {
  return {
    id: `${id}-${i}`,
    role: "option",
    tabindex: roving.tabindex(i),
    "aria-selected": picked.value.has(item.value),
    "aria-disabled": item.disabled || undefined,
    "data-roving": "",
    onFocus: () => roving.onFocus(i),
  };
}

let ownAnchor: T | null = null;
const anchorValue = () => (props.anchor !== undefined ? props.anchor : ownAnchor);

function setAnchor(v: T) {
  if (v === anchorValue()) return;
  ownAnchor = v;
  emit("update:anchor", v);
}

// A disabled option joins no run, though one the caller already picked stays picked.
function commit(keys: readonly T[]) {
  const off = new Set(props.items.filter((it) => it.disabled).map((it) => it.value));
  const cur = picked.value;
  const next = keys.filter((k) => !off.has(k) || cur.has(k));
  if (next.length === cur.size && next.every((k) => cur.has(k))) return;
  emit("update:modelValue", next);
}

function choose(i: number, mods: SelectMods, anchor = anchorValue()) {
  const it = props.items[i];
  if (!it || it.disabled) return;
  if (!props.multiple) {
    if (it.value !== props.modelValue) emit("update:modelValue", it.value);
    return;
  }
  const order = props.items.map((x) => x.value);
  const next = selectRow({ keys: [...picked.value], anchor }, order, it.value, mods);
  commit(next.keys);
  if (next.anchor !== null) setAnchor(next.anchor);
}

// The anchor goes in by hand: a caller's v-model:anchor only reaches the prop on its next render.
function extend(from: number, to: number) {
  let a = anchorValue();
  if (a === null || !props.items.some((it) => it.value === a)) a = props.items[from]?.value ?? null;
  choose(to, { toggle: false, range: true }, a);
}

// Options outside this list stay picked, so a caller can share one selection between lists.
function selectAll() {
  const own = new Set(props.items.map((it) => it.value));
  const foreign = [...picked.value].filter((k) => !own.has(k));
  commit([...props.items.filter((it) => !it.disabled || picked.value.has(it.value)).map((it) => it.value), ...foreign]);
}

function isSelectAll(e: KeyboardEvent) {
  const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a";
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

function typeAhead(ch: string, from: number): number | null {
  const word = buffer + ch.toLowerCase();
  // A repeated letter cycles through the options it starts; a word keeps the current match while it still fits.
  const cycling = [...word].every((c) => c === word[0]);
  const needle = cycling ? word[0]! : word;
  const n = props.items.length;
  const start = cycling ? from + 1 : from;
  let hit = -1;
  for (let k = 0; k < n && hit < 0; k++) {
    const i = (start + k) % n;
    const it = props.items[i]!;
    if (!it.disabled && it.label.toLowerCase().startsWith(needle)) hit = i;
  }
  // A first letter no option starts belongs to the window, a single key shortcut such as F for fit.
  if (hit < 0 && buffer === "") return null;
  buffer = word;
  window.clearTimeout(bufferTimer);
  bufferTimer = window.setTimeout(() => (buffer = ""), TYPE_AHEAD_MS);
  return hit < 0 ? from : hit;
}

function target(k: string, from: number, els: readonly HTMLElement[]): number | null {
  if (k === "ArrowLeft") return step(from, -1);
  if (k === "ArrowRight") return step(from, 1);
  if (k === "ArrowUp") return step(from, -columns(els));
  if (k === "ArrowDown") return step(from, columns(els));
  if (k === "Home" || k === "End") return rovingIndex(k, from, disabled.value);
  return null;
}

// The window keymap reads no defaultPrevented, so a key this list used would also turn the view or start a tool.
function consume(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
}

// Firefox clicks a button on the Space keyup, which would select again after Space already did.
let swallowSpaceUp = false;

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  if (props.multiple && isSelectAll(e)) {
    consume(e);
    selectAll();
    return;
  }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const els = elements();
  const hit = els.findIndex((el) => el.contains(e.target as Node));
  const from = hit >= 0 ? hit : roving.stop.value;
  if (from < 0) return;
  const k = e.key;
  if (k === "Enter" || (k === " " && buffer === "")) {
    consume(e);
    const it = props.items[from];
    if (k === " ") {
      swallowSpaceUp = true;
      choose(from, { toggle: !e.shiftKey, range: e.shiftKey });
    } else if (it && !it.disabled) emit("apply", it.value);
    return;
  }
  const nav = target(k, from, els);
  const next = nav ?? (k.length === 1 ? typeAhead(k, from) : null);
  if (next === null) return;
  consume(e);
  if (next !== from || hit < 0) roving.focus(next);
  if (props.multiple && e.shiftKey && nav !== null && next !== from) extend(from, next);
}

function onKeyup(e: KeyboardEvent) {
  if (e.key !== " " || !swallowSpaceUp) return;
  swallowSpaceUp = false;
  e.preventDefault();
}

function onClick(e: MouseEvent) {
  if (e.defaultPrevented) return;
  const i = elements().findIndex((el) => el.contains(e.target as Node));
  if (i >= 0) choose(i, modsOf(e));
}

onBeforeUnmount(() => window.clearTimeout(bufferTimer));
</script>

<template>
  <div
    v-bind="name"
    ref="root"
    role="listbox"
    :aria-multiselectable="multiple || undefined"
    @keydown="onKeydown"
    @keyup="onKeyup"
    @click="onClick"
  >
    <template v-for="(item, i) in items" :key="item.value">
      <slot name="option" :item="item" :index="i" :selected="picked.has(item.value)" :attrs="attrsOf(item, i)" />
    </template>
  </div>
</template>
