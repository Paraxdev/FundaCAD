<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useName, type Named } from "./useName";
import { rovingIndex, type RovingOrientation } from "./useRovingFocus";

const props = withDefaults(
  defineProps<
    {
      orientation?: RovingOrientation;
      wrap?: boolean;
      tag?: string;
      role?: "toolbar" | "menubar";
    } & Named
  >(),
  { orientation: "horizontal", wrap: true, tag: "div", role: "toolbar" },
);

const name = useName(props, "Toolbar");
const root = ref<HTMLElement | null>(null);

const COMPOSITE = [
  "toolbar",
  "radiogroup",
  "tablist",
  "listbox",
  "menu",
  "menubar",
  "tree",
  "grid",
  "dialog",
  "alertdialog",
]
  .map((r) => `[role="${r}"]`)
  .join(",");
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]';
const OWN_FIELD = /^(button|checkbox|radio|reset|submit|image|color|file)$/;
const FIELD_ROLE = /^(textbox|searchbox|slider|spinbutton|combobox)$/;

// A nested composite (a Segmented radiogroup) keeps its own stop and keys, the toolbar only arrows onto it.
interface Item {
  key: HTMLElement;
  target: HTMLElement;
  owned: boolean;
}

let last: HTMLElement | null = null;

function shown(el: HTMLElement, top: HTMLElement): boolean {
  if (el.closest("[hidden], [inert]")) return false;
  for (let n: HTMLElement | null = el; n && n !== top; n = n.parentElement)
    if (getComputedStyle(n).display === "none") return false;
  return true;
}

const ownerOf = (el: HTMLElement) => el.parentElement?.closest<HTMLElement>(COMPOSITE) ?? null;

function outermost(el: HTMLElement, top: HTMLElement): HTMLElement | null {
  let c = ownerOf(el);
  while (c && c !== top) {
    const up = ownerOf(c);
    if (up === top) return c.matches('[role="dialog"], [role="alertdialog"]') ? null : c;
    c = up;
  }
  return null;
}

function scan(): Item[] {
  const top = root.value;
  if (!top) return [];
  const out: Item[] = [];
  const seen = new Set<HTMLElement>();
  for (const el of top.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (!shown(el, top)) continue;
    if (ownerOf(el) === top) {
      if (!el.matches(":disabled")) out.push({ key: el, target: el, owned: true });
      continue;
    }
    const group = outermost(el, top);
    if (!group || seen.has(group) || el.getAttribute("tabindex") !== "0") continue;
    seen.add(group);
    out.push({ key: group, target: el, owned: false });
  }
  return out;
}

function stopOf(items: Item[]): Item | undefined {
  return items.find((it) => it.key === last) ?? items[0];
}

function sync() {
  const items = scan();
  const stop = stopOf(items);
  for (const it of items) {
    if (!it.owned) continue;
    const want = it === stop ? "0" : "-1";
    if (it.target.getAttribute("tabindex") !== want) it.target.setAttribute("tabindex", want);
  }
}

const hitOf = (items: Item[], node: Node) => items.findIndex((it) => it.key === node || it.key.contains(node));

function onFocusin(e: FocusEvent) {
  const items = scan();
  const hit = hitOf(items, e.target as Node);
  if (hit < 0) return;
  last = items[hit]!.key;
  sync();
}

function typing(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) return true;
  if (el instanceof HTMLInputElement && !OWN_FIELD.test(el.type)) return true;
  const role = el.closest("[role]")?.getAttribute("role") ?? "";
  return FIELD_ROLE.test(role);
}

function onKeydown(e: KeyboardEvent) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
  if (!(e.target instanceof HTMLElement) || typing(e.target)) return;
  const items = scan();
  const from = hitOf(items, e.target);
  if (from < 0) return;
  const next = rovingIndex(
    e.key,
    from,
    items.map(() => false),
    { orientation: props.orientation, wrap: props.wrap },
  );
  if (next === null) return;
  e.preventDefault();
  if (next === from) return;
  const it = items[next]!;
  last = it.key;
  sync();
  it.target.focus();
}

/** Puts focus on the item that holds the toolbar's stop, as F10 does for a menu bar. */
function focus() {
  const it = stopOf(scan());
  if (it) {
    last = it.key;
    sync();
    it.target.focus();
  }
}
defineExpose({ focus });

let observer: MutationObserver | null = null;
onMounted(() => {
  sync();
  observer = new MutationObserver(sync);
  if (root.value)
    observer.observe(root.value, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "hidden", "inert", "tabindex", "role", "style"],
    });
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <component
    :is="tag"
    ref="root"
    :role="role"
    :aria-orientation="orientation === 'vertical' ? 'vertical' : undefined"
    v-bind="name"
    @keydown="onKeydown"
    @focusin="onFocusin"
  >
    <slot />
  </component>
</template>
