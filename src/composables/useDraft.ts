import { ref, watch, type Ref } from "vue";

/** An input draft that follows `source` except while the input has focus, so a document change landing mid-edit
 *  (parameter commits resolve asynchronously) cannot clobber uncommitted keystrokes. */
export function useDraft(
  source: () => string,
  /** Owned by the caller so it stays type-checked, vue-tsc cannot see a string `ref="el"` inside a composable. */
  el: Readonly<Ref<HTMLInputElement | null>>,
): {
  draft: Ref<string>;
  /** Call after a successful commit to re-sync from the source. */
  resync: () => void;
} {
  const draft = ref(source());

  watch(source, (v) => {
    if (el.value && document.activeElement === el.value) return;
    draft.value = v;
  });

  return {
    draft,
    resync: () => {
      draft.value = source();
    },
  };
}
