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

/** Cap: oldest is evicted first. Unchanged from the original stack. */
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
    // Two-phase removal so the CSS exit transition still runs, exactly as the
    // imperative version did with classList.add("toast-out") + a 180ms timer.
    t.leaving = true;
    window.setTimeout(() => {
      items.value = items.value.filter((x) => x.id !== id);
    }, EXIT_MS);
  }

  function push(message: string, kind: ToastItem["kind"], action: ToastAction | undefined, timeout: number) {
    const id = nextId++;
    // keep the stack short, oldest goes first
    while (items.value.length >= MAX) {
      const oldest = items.value[0];
      if (!oldest) break;
      window.clearTimeout(timers.get(oldest.id));
      timers.delete(oldest.id);
      items.value.shift();
    }
    // markRaw: `action` carries a closure over raw engine objects (it is how a
    // failed-feature toast offers "Show" / "Re-pick face"). There is nothing to
    // gain from proxying it and a real cost if a Feature rides along.
    items.value.push({ id, message, kind, ...(action ? { action: markRaw(action) } : {}), leaving: false });
    timers.set(id, window.setTimeout(() => dismiss(id), timeout));
  }

  return { items, push, dismiss };
});
