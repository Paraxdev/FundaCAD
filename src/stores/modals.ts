import { defineStore } from "pinia";
import { markRaw, ref } from "vue";

export interface ChoiceOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface ChooseReq {
  kind: "choose";
  title: string;
  options: ChoiceOption[];
  resolve: (v: string | null) => void;
}
export interface MultiReq {
  kind: "multi";
  title: string;
  options: ChoiceOption[];
  min: number;
  confirmLabel: string;
  resolve: (v: string[] | null) => void;
}
export interface ListReq {
  kind: "list";
  title: string;
  items: string[];
  resolve: () => void;
}

export type ModalReq = (ChooseReq | MultiReq | ListReq) & { id: number };

/** The one-shot modal chooser queue, plus the app-wide "a modal is open" gate.
 *
 *  `depth` is what toolBusy() reads (via isChoiceOpen) so a global shortcut,
 *  "e" for Extrude, say, can't fire underneath an awaiting modal. It counts
 *  modals built OUTSIDE this module too (welcome screen, sign-in, publish),
 *  which is why pushModal/popModal are public. */
export const useModalStore = defineStore("modals", () => {
  const current = ref<ModalReq | null>(null);
  const queue: ModalReq[] = [];
  const depth = ref(0);
  let nextId = 1;

  // markRaw: every request holds a `resolve` closure, and the choose() options
  // come straight from caller code. Nothing here benefits from being proxied.
  function enqueue(req: ChooseReq | MultiReq | ListReq) {
    const full = markRaw({ ...req, id: nextId++ }) as ModalReq;
    if (current.value) queue.push(full);
    else current.value = full;
  }

  /** Finish the open modal and promote the next queued one. */
  function close() {
    current.value = queue.shift() ?? null;
  }

  return { current, depth, enqueue, close };
});
