import { defineStore } from "pinia";
import { markRaw, ref } from "vue";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: "error" | "warning" | "info";
  action?: ToastAction;
  /** Set while the exit transition plays; the row leaves the array 180ms later. */
  leaving: boolean;
}

/** Cap: oldest is evicted first. */
const MAX = 3;
/** Must match the .toast-out transition in styles/_utilities.scss. */
const EXIT_MS = 180;

export const useToastStore = defineStore("toasts", () => {
  const items = ref<ToastItem[]>([]);
  let nextId = 1;
  const timers = new Map<number, number>();

  function dismiss(id: number) {
    const t = items.value.find((x) => x.id === id);
    if (!t || t.leaving) return;
    window.clearTimeout(timers.get(id));
    timers.delete(id);
    // Two-phase removal so the CSS exit transition still runs.
    t.leaving = true;
    window.setTimeout(() => {
      items.value = items.value.filter((x) => x.id !== id);
    }, EXIT_MS);
  }

  function push(message: string, kind: ToastItem["kind"], action: ToastAction | undefined, timeout: number): number {
    // The same line restarts the one showing rather than stacking a copy that could take a click over the canvas.
    // With the same button it takes the newer action, the command that asked last.
    const same = items.value.find(
      (x) => !x.leaving && x.message === message && x.kind === kind && x.action?.label === action?.label,
    );
    if (same) {
      if (action) same.action = markRaw(action);
      window.clearTimeout(timers.get(same.id));
      timers.set(
        same.id,
        window.setTimeout(() => dismiss(same.id), timeout),
      );
      return same.id;
    }
    const id = nextId++;
    while (items.value.length >= MAX) {
      const oldest = items.value[0];
      if (!oldest) break;
      window.clearTimeout(timers.get(oldest.id));
      timers.delete(oldest.id);
      items.value.shift();
    }
    // markRaw: `action` closes over raw engine objects, like a failed feature toast's "Show" or "Re-pick face".
    items.value.push({ id, message, kind, ...(action ? { action: markRaw(action) } : {}), leaving: false });
    timers.set(
      id,
      window.setTimeout(() => dismiss(id), timeout),
    );
    return id;
  }

  return { items, push, dismiss };
});
