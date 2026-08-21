// A tiny modal chooser: title + a row of buttons, returns the picked value (or
// null on Esc / backdrop click). Used for small one-shot decisions like the
// Split's keep-mode or Section's axis, where a full dialog/tool
// would be overkill. Resolves once.
//
// Facade over stores/modals.ts, rendered by components/overlays/ModalHost.vue.
// Every exported signature is unchanged.
//
// One deliberate behaviour change: opening a second chooser while one is up
// used to stack two backdrops with two competing capture-phase key traps. They
// queue now — the second opens when the first resolves. Nothing in the app does
// this today (toolBusy blocks it), but it was a live footgun.

import { useModalStore, type ChoiceOption } from "../stores/modals";

export type { ChoiceOption };

// Module-level modal-open counter: true for the lifetime of any open choose()/
// chooseMulti(). toolBusy() ORs this in so a global shortcut (e.g. "e" ->
// Extrude) can't fire underneath an awaiting modal (Mirror, Split,
// Revolve, Sweep, Primitive, Pattern, Section axis-pick, ...).
export function isChoiceOpen(): boolean {
  return useModalStore().depth > 0;
}

/** For modals built outside this module (welcome screen, sign-in, publish form):
 *  count them in the same gate so global shortcuts stay blocked underneath. */
export function pushModal(): void {
  useModalStore().depth++;
}
export function popModal(): void {
  const m = useModalStore();
  m.depth = Math.max(0, m.depth - 1);
}

export function choose<T extends string>(
  title: string,
  options: ChoiceOption<T>[],
): Promise<T | null> {
  const m = useModalStore();
  return new Promise<T | null>((resolve) => {
    m.depth++;
    m.enqueue({
      kind: "choose",
      title,
      options: options as ChoiceOption[],
      resolve: (v: string | null) => {
        m.depth = Math.max(0, m.depth - 1);
        resolve(v as T | null);
      },
    });
  });
}

/** A multi-select variant of `choose`: a checkbox list + confirm/Cancel buttons.
 *  Returns the checked values (>= `min`), or null on cancel/Esc. Used where the
 *  data model takes several items (e.g. a boolean's tool bodies). */
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

/** A read-only modal that lists `items` (e.g. the files an export wrote) with a
 *  single dismiss button. Resolves when closed.
 *
 *  Note it does NOT touch the modal depth — same as before. It is informational
 *  and appears after the operation it reports on has finished. */
export function listModal(title: string, items: string[]): Promise<void> {
  const m = useModalStore();
  return new Promise<void>((resolve) => {
    m.enqueue({ kind: "list", title, items, resolve });
  });
}
