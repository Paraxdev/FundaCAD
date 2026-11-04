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

export type PauseReason = "stack" | "modal";

/** Cap: a fourth toast evicts the oldest one without a button, so a pending Undo is the last to go. */
const MAX = 3;
/** Must match the .toast-out transition in styles/_utilities.scss. */
const EXIT_MS = 180;

export const useToastStore = defineStore("toasts", () => {
  const items = ref<ToastItem[]>([]);
  let nextId = 1;
  const timers = new Map<number, number>();
  const holds = new Map<number, number | null>();
  const pausedBy = new Set<PauseReason>();

  function held(id: number): boolean {
    if (pausedBy.has("stack")) return true;
    return pausedBy.has("modal") && !!items.value.find((x) => x.id === id)?.action;
  }

  function arm(id: number) {
    window.clearTimeout(timers.get(id));
    timers.delete(id);
    const hold = holds.get(id);
    if (hold == null || held(id)) return;
    timers.set(
      id,
      window.setTimeout(() => dismiss(id), hold),
    );
  }

  /** "stack": the pointer or focus is on the stack, no toast times out. "modal": a modal holds the page inert, so
   *  only a toast with a button waits, its button out of reach until the modal closes. See resume(). */
  function pause(by: PauseReason = "stack") {
    pausedBy.add(by);
    for (const [id, t] of timers) {
      if (!held(id)) continue;
      window.clearTimeout(t);
      timers.delete(id);
    }
  }

  /** Every toast that `by` held starts its full time again, the rule the title bar notice already follows. */
  function resume(by: PauseReason = "stack") {
    if (!pausedBy.delete(by)) return;
    for (const t of items.value) if (!t.leaving && (by === "stack" || t.action)) arm(t.id);
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

  function push(
    message: string,
    kind: ToastItem["kind"],
    action: ToastAction | undefined,
    hold: number | null,
  ): number {
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
