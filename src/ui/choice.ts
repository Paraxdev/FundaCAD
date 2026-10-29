// Small one-shot modal chooser, resolves to the picked value or null on Esc or a backdrop click. Facade over
// stores/modals.ts. A second chooser queues behind the first instead of stacking two key traps.

import { useModalStore, type ChoiceOption } from "../stores/modals";

export type { ChoiceOption };

// True while any choose() or chooseMulti() is open: toolBusy() ORs it in so no global shortcut fires under a modal.
export function isChoiceOpen(): boolean {
  return useModalStore().depth > 0;
}

/** For modals built elsewhere (Home, sign-in, publish form), so global shortcuts stay blocked under them too. */
export function pushModal(): void {
  useModalStore().depth++;
}
export function popModal(): void {
  const m = useModalStore();
  m.depth = Math.max(0, m.depth - 1);
}

/** With `signal`, an abort takes the question down unanswered, as null. */
export function choose<T extends string>(
  title: string,
  options: ChoiceOption<T>[],
  signal?: AbortSignal,
  message?: string,
): Promise<T | null> {
  const m = useModalStore();
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    m.depth++;
    const answer = (v: string | null) => {
      signal?.removeEventListener("abort", withdraw);
      m.depth = Math.max(0, m.depth - 1);
      resolve(v as T | null);
    };
    const id = m.enqueue({
      kind: "choose",
      title,
      ...(message ? { message } : {}),
      options: options as ChoiceOption[],
      resolve: answer,
    });
    const withdraw = () => {
      if (m.withdraw(id)) answer(null);
    };
    signal?.addEventListener("abort", withdraw, { once: true });
  });
}

/** Returns the checked values (>= `min`), or null on cancel or Esc. */
export function chooseMulti<T extends string>(
  title: string,
  options: ChoiceOption<T>[],
  opts: { min?: number; confirmLabel?: string } = {},
): Promise<T[] | null> {
  const m = useModalStore();
  return new Promise<T[] | null>((resolve) => {
    m.depth++;
    m.enqueue({
      kind: "multi",
      title,
      options: options as ChoiceOption[],
      min: opts.min ?? 1,
      confirmLabel: opts.confirmLabel ?? "OK",
      resolve: (v: string[] | null) => {
        m.depth = Math.max(0, m.depth - 1);
        resolve(v as T[] | null);
      },
    });
  });
}

/** Leaves the modal depth alone: it is informational and opens after the operation it reports on has finished. */
export function listModal(title: string, items: string[]): Promise<void> {
  const m = useModalStore();
  return new Promise<void>((resolve) => {
    m.enqueue({ kind: "list", title, items, resolve });
  });
}
