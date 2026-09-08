import { ref, watch, type Ref } from "vue";

/** An uncontrolled input whose value tracks a source EXCEPT while it has focus.
 *
 *  Replaces liveInputs.ts's `keystrokeGuard`. Vue solves half the problem: keyed
 *  patching stops the element being destroyed and recreated, but a `:value` binding
 *  still re-fires when the document changes and clobbers uncommitted keystrokes just
 *  as thoroughly. Parameter commits are queued on a promise chain and land
 *  asynchronously, so this is not hypothetical.
 *
 *  Focus is the right guard HERE (unlike in keystrokeGuard, whose comment warns
 *  focus alone is wrong) because the scope is one input rather than a whole panel:
 *  if this field has focus the user is editing this value, and the incoming update
 *  is by definition staler than what they typed. */
export function useDraft(
  source: () => string,
  /** The input this draft belongs to, the caller owns the template ref so it
   *  stays type-checked (a string `ref="el"` resolved inside a composable is
   *  invisible to vue-tsc). */
  el: Readonly<Ref<HTMLInputElement | null>>,
): {
  draft: Ref<string>;
  /** Call after a successful commit to re-sync from the source. */
  resync: () => void;
} {
  const draft = ref(source());

  watch(source, (v) => {
    if (el.value && document.activeElement === el.value) return; // mid-edit: skip
    draft.value = v;
  });

  return { draft, resync: () => { draft.value = source(); } };
}
