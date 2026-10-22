<script setup lang="ts">
// Commits on change (Enter, blur): `commit` returns an error, and the input turns red and keeps the rejected text.
// Bare on purpose, ValidatedRow and the Parameters grid wrap it in layouts with nothing else in common.

import { nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useDraft } from "../../composables/useDraft";

const props = defineProps<{
  /** Current committed value, in whatever spelling the panel wants shown. */
  value: string;
  commit: (raw: string) => string | null;
  /** Tooltip while there is no error; the error replaces it when there is one. */
  hint?: string | undefined;
  /** A refusal from outside: the kernel could not build what the value says. Kept apart from the local parse `error`
   *  because it arrives while typing, and only the next preview's build withdraws it, not a keystroke. */
  problem?: string | null | undefined;
  placeholder?: string | undefined;
  /** Shows what the typed text would do without committing, on a debounce while typing. Mid-word text is often
   *  nonsense, so the panel ignores what it cannot parse, errors come from `commit`. */
  preview?: ((raw: string) => void) | undefined;
  /** Takes the preview down. `committing` means a commit is about to land, so the panel can skip a redundant rebuild. */
  previewEnd?: ((committing: boolean) => void) | undefined;
}>();

/** A preview is a real kernel rebuild, not a repaint: long enough to sit out a digit, short enough that a pause reads
 *  as an answer. */
const PREVIEW_MS = 200;

// The draft ignores a background doc change while focused, so uncommitted keystrokes survive an async param commit.
const el = useTemplateRef<HTMLInputElement>("el");
const { draft, resync } = useDraft(() => props.value, el);
const error = ref<string | null>(null);

/** A commit succeeded and the field waits for the panel's spelling of the result. The next keystroke clears it, the
 *  user's text wins over the answer to the previous edit. */
let settling = false;

let previewTimer = 0;
/** Tracked, so a field nobody previewed never schedules a rebuild by being blurred. */
let previewing = false;

function schedulePreview() {
  if (!props.preview) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    previewTimer = 0;
    previewing = true;
    props.preview?.(draft.value.trim());
  }, PREVIEW_MS);
}

function endPreview(committing: boolean) {
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = 0;
  }
  if (!previewing) return;
  previewing = false;
  props.previewEnd?.(committing);
}

// Leaving without committing (Escape, a click elsewhere, the panel closing) takes the preview down too, or the model
// shows a number the document does not hold.
onBeforeUnmount(() => endPreview(false));

async function onChange() {
  endPreview(true); // the commit below schedules its own rebuild
  const err = props.commit(draft.value.trim());
  error.value = err;
  // On failure keep the rejected text so it can be fixed rather than retyped.
  if (err) return;
  settling = true;
  // On success re-read after a tick, since `value` is a prop that updates only on re-render: the panel may re-spell
  // what was sent (fx badge, canonical rounding, an adopted unit).
  await nextTick();
  resync();
}

// The draft ignores the source while focused, which is wrong for the answer to this edit: a parameter expression
// commits on a promise chain frames later, so without this, "20+5" then Enter looked like it did nothing.
watch(
  () => props.value,
  () => {
    if (!settling) return;
    settling = false;
    resync();
  },
);
</script>

<template>
  <input
    ref="el"
    v-model="draft"
    type="text"
    :class="{ 'input-error': !!error || !!problem, 'input-problem': !!problem }"
    :title="error ?? problem ?? hint"
    :placeholder="placeholder"
    @input="
      error = null;
      settling = false;
      schedulePreview();
    "
    @change="onChange"
    @blur="endPreview(false)"
    @keydown.esc="endPreview(false)"
  />
</template>
