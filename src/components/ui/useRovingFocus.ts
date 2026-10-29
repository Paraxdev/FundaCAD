import { computed, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from "vue";

export type RovingOrientation = "horizontal" | "vertical" | "both";

export interface RovingOptions {
  orientation?: RovingOrientation | undefined;
  /** Default true. */
  wrap?: boolean | undefined;
}

const STEP: Record<RovingOrientation, Record<string, 1 | -1>> = {
  horizontal: { ArrowRight: 1, ArrowLeft: -1 },
  vertical: { ArrowDown: 1, ArrowUp: -1 },
  both: { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 },
};

/** Where `key` moves focus from item `from` (-1 for none). null when the key is not one of the group's or no item is
 *  enabled; `from` itself when the key is the group's but there is nowhere to go, so the caller still claims it. */
export function rovingIndex(
  key: string,
  from: number,
  disabled: readonly boolean[],
  { orientation = "horizontal", wrap = true }: RovingOptions = {},
): number | null {
  const n = disabled.length;
  const first = disabled.indexOf(false);
  if (first < 0) return null;
  const last = disabled.lastIndexOf(false);
  if (key === "Home") return first;
  if (key === "End") return last;
  const step = STEP[orientation][key];
  if (!step) return null;
  if (from < 0 || from >= n) return step > 0 ? first : last;
  for (let k = 1; k < n; k++) {
    const raw = from + step * k;
    if (!wrap && (raw < 0 || raw >= n)) return from;
    const i = (raw + n) % n;
    if (!disabled[i]) return i;
  }
  return from;
}

/** The item that holds the group's one Tab stop: `active` when enabled, else the first enabled item, else -1. */
export function rovingStop(active: number, disabled: readonly boolean[]): number {
  if (active >= 0 && active < disabled.length && !disabled[active]) return active;
  return disabled.indexOf(false);
}

/** One Tab stop for a group, arrows, Home and End move focus among the items, disabled ones skipped. The items are
 *  the elements under `container` matching `itemSelector`, in the order of `items`. */
export function useRovingFocus(o: {
  items: MaybeRefOrGetter<readonly { disabled?: boolean | undefined }[]>;
  /** The selected item, which holds the stop until focus moves; -1 for none. */
  active?: MaybeRefOrGetter<number>;
  container: Readonly<Ref<HTMLElement | null>>;
  /** Pass a `:scope > ...` selector when groups nest, a submenu inside a menu. */
  itemSelector?: string;
  orientation?: MaybeRefOrGetter<RovingOrientation>;
  wrap?: MaybeRefOrGetter<boolean>;
  /** After focus moved to `index`, a Segmented picks it here. */
  onMove?: (index: number) => void;
}): {
  stop: ComputedRef<number>;
  tabindex: (index: number) => 0 | -1;
  /** On the container. */
  onKeydown: (e: KeyboardEvent) => void;
  /** On each item, so a click or programmatic focus takes the stop with it. */
  onFocus: (index: number) => void;
  focus: (index: number) => void;
} {
  const selector = o.itemSelector ?? "[data-roving]";
  const disabled = computed(() => toValue(o.items).map((it) => !!it.disabled));
  const active = computed(() => toValue(o.active) ?? -1);
  const focused = ref(-1);
  watch(active, () => (focused.value = -1));

  const stop = computed(() =>
    focused.value >= 0 && focused.value < disabled.value.length && !disabled.value[focused.value]
      ? focused.value
      : rovingStop(active.value, disabled.value),
  );
  const elements = () => [...(o.container.value?.querySelectorAll<HTMLElement>(selector) ?? [])];
  const focus = (index: number) => {
    focused.value = index;
    elements()[index]?.focus();
  };

  return {
    stop,
    tabindex: (index) => (index === stop.value ? 0 : -1),
    onFocus: (index) => {
      focused.value = index;
    },
    focus,
    onKeydown: (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      const els = elements();
      const hit = els.findIndex((el) => el === e.target || el.contains(e.target as Node));
      const from = hit >= 0 ? hit : stop.value;
      const next = rovingIndex(e.key, from, disabled.value, {
        orientation: toValue(o.orientation) ?? "horizontal",
        wrap: toValue(o.wrap) ?? true,
      });
      if (next === null) return;
      e.preventDefault();
      if (next === from && hit >= 0) return;
      focus(next);
      o.onMove?.(next);
    },
  };
}
