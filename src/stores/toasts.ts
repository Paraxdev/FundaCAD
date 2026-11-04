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

/** Cap: a fourth toast evicts the oldest one without a button, so a pending Undo is the last to go. */
const MAX = 3;
/** Must match the .toast-out transition in styles/_utilities.scss. */
const EXIT_MS = 180;

export const useToastStore = defineStore("toasts", () => {
  const items = ref<ToastItem[]>([]);
  let nextId = 1;
  const timers = new Map<number, number>();
  const holds = new Map<number, number | null>();
  let paused = false;

  function arm(id: number) {
    window.clearTimeout(timers.get(id));
    timers.delete(id);
    const hold = holds.get(id);
    if (paused || hold == null) return;
    timers.set(
      id,
      window.setTimeout(() => dismiss(id), hold),
    );
  }

  /** While the pointer or focus is on the stack no toast times out, see resume(). */
  function pause() {
    paused = true;
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
  }

  /** Every showing toast starts its full time again, the rule the title bar notice already follows. */
  function resume() {
    paused = false;
    for (const t of items.value) if (!t.leaving) arm(t.id);
  }

  function dismiss(id: number) {
    const t = items.value.find((x) => x.id === id);
    if (!t || t.leaving) return;
    window.clearTimeout(timers.get(id));
    timers.delete(id);
    holds.delete(id);
    // Two-phase removal so the CSS exit transition still runs.
    t.leaving = true;
    window.setTimeout(() => {
      items.value = items.value.filter((x) => x.id !== id);
    }, EXIT_MS);
  }

  function push(message: string, kind: ToastItem["kind"], action: ToastAction | undefined, hold: number | null): number {
    // The same line restarts the one showing rather than stacking a copy that could take a click over the canvas.
    // With the same button it takes the newer action, the command that asked last.
    const same = items.value.find(
      (x) => !x.leaving && x.message === message && x.kind === kind && x.action?.label === action?.label,
    );
    if (same) {
      if (action) same.action = markRaw(action);
      holds.set(same.id, hold);
      arm(same.id);
      return same.id;
    }
    const id = nextId++;
    while (items.value.length >= MAX) {
      const gone = items.value.find((x) => x.leaving) ?? items.value.find((x) => !x.action) ?? items.value[0];
      if (!gone) break;
      window.clearTimeout(timers.get(gone.id));
      timers.delete(gone.id);
      holds.delete(gone.id);
      items.value = items.value.filter((x) => x !== gone);
    }
    // markRaw: `action` closes over raw engine objects, like a failed feature toast's "Show" or "Re-pick face".
    items.value.push({ id, message, kind, ...(action ? { action: markRaw(action) } : {}), leaving: false });
    holds.set(id, hold);
    arm(id);
    return id;
  }

  /** Starts a showing toast's time over; false when it is gone or leaving. */
  function restart(id: number): boolean {
    const t = items.value.find((x) => x.id === id);
    if (!t || t.leaving) return false;
    arm(id);
    return true;
  }

  return { items, push, dismiss, pause, resume, restart };
});
