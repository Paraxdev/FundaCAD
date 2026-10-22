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

/** The one-shot modal chooser queue and the app-wide "a modal is open" gate. `depth` feeds toolBusy() so a shortcut
 *  cannot fire under an awaiting modal. It counts modals built elsewhere too, hence public pushModal/popModal. */
export const useModalStore = defineStore("modals", () => {
  const current = ref<ModalReq | null>(null);
  const queue: ModalReq[] = [];
  const depth = ref(0);
  let nextId = 1;

  // markRaw: requests hold `resolve` closures, and choose() options come straight from caller code.
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
