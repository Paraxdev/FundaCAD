import { nextTick, onBeforeUnmount, ref, watch, type Ref } from "vue";

/** A preview is a real kernel rebuild, not a repaint: long enough to sit out a digit, short enough that a pause reads
 *  as an answer. */
export const PREVIEW_MS = 200;

export interface CommitField {
  /** The text in the field. */
  draft: Ref<string>;
  /** The reason the last commit refused the draft, kept until the next keystroke. */
  error: Ref<string | null>;
  /** Typed text, or a step: the draft changes as if typed. */
  input: (text: string) => void;
  /** Enter, and blur in `change` mode. */
  commit: () => void;
  /** Escape: back to the committed text, any preview taken down. */
  revert: () => void;
  blur: () => void;
}

/** One field model for TextField and NumberField. In `change` mode the draft commits on Enter or blur, Escape reverts
 *  it, refused text stays with its reason, and a preview runs on a debounce while typing. In `live` mode each input
 *  commits. A focused draft with uncommitted keystrokes ignores the source, so a value landing mid edit (parameter
 *  commits resolve on a promise chain) cannot clobber it; an untouched or committed field follows it. */
export function useCommitField(o: {
  /** The committed value, spelled as the field shows it. */
  source: () => string;
  /** Owned by the caller so it stays type checked; vue-tsc cannot see a string `ref` inside a composable. */
  el: Readonly<Ref<HTMLInputElement | HTMLTextAreaElement | null>>;
  /** Commits the text, or returns why not. */
  apply: (raw: string) => string | null;
  live?: () => boolean;
  /** Runs `PREVIEW_MS` after the last keystroke in `change` mode, with the draft. */
  preview?: () => ((raw: string) => void) | undefined;
  /** Takes the preview down; `committing` means a commit is about to land, so the caller can skip a rebuild. */
  previewEnd?: () => ((committing: boolean) => void) | undefined;
}): CommitField {
  const draft = ref(o.source());
  const error = ref<string | null>(null);
  /** Keystrokes the source has not seen. Refused text stays dirty, so it survives an outside change while focused. */
  let dirty = false;
  const live = () => o.live?.() ?? false;
  const focused = () => !!o.el.value && document.activeElement === o.el.value;

  watch(o.source, (v) => {
    if (dirty && focused()) return;
    dirty = false;
    error.value = null;
    draft.value = v;
  });

  let previewTimer = 0;
  /** Tracked, so a field nobody previewed never ends a preview by being blurred. */
  let previewing = false;

  function schedulePreview() {
    if (!o.preview?.()) return;
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      const run = o.preview?.();
      if (!run) return;
      previewing = true;
      run(draft.value);
    }, PREVIEW_MS);
  }

  function endPreview(committing: boolean) {
    window.clearTimeout(previewTimer);
    previewTimer = 0;
    if (!previewing) return;
    previewing = false;
    o.previewEnd?.()?.(committing);
  }

  onBeforeUnmount(() => endPreview(false));

  async function commitDraft() {
    if (!dirty) return;
    const err = o.apply(draft.value);
    endPreview(!err);
    error.value = err;
    if (err) return;
    dirty = false;
    // The caller may answer in another spelling (an adopted unit, rounding) or not at all, so re-read after the
    // render; an async answer arrives later through the watch, since the field is no longer dirty.
    await nextTick();
    if (!dirty) draft.value = o.source();
  }

  return {
    draft,
    error,
    input(text) {
      draft.value = text;
      dirty = true;
      error.value = null;
      if (!live()) return schedulePreview();
      // Live keeps the typed text while focused: echoing the model back would eat a trailing "1." mid number.
      error.value = o.apply(text);
    },
    commit() {
      if (!live()) void commitDraft();
    },
    revert() {
      endPreview(false);
      dirty = false;
      error.value = null;
      draft.value = o.source();
    },
    blur() {
      if (!live()) {
        if (dirty) void commitDraft();
        else endPreview(false);
        return;
      }
      if (error.value) return;
      dirty = false;
      draft.value = o.source();
    },
  };
}
