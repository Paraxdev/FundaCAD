<script setup lang="ts">
// A text input that commits on `change` (Enter / blur): `commit` returns an
// error message to show — the input turns red and KEEPS the rejected text so
// the user can fix it — or null on success. Typing clears the error.
//
// Replaces liveInputs.ts's validatedInput. Bare on purpose: ValidatedRow wraps
// it in a labelled row (ValidatedRow), while the Parameters dialog drops it
// straight into a grid cell, and those two layouts have nothing in common
// beyond this behaviour.

import { nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { useDraft } from "../../composables/useDraft";

const props = defineProps<{
  /** Current committed value, in whatever spelling the panel wants shown. */
  value: string;
  commit: (raw: string) => string | null;
  /** Tooltip while there is no error; the error replaces it when there is one. */
  hint?: string | undefined;
  placeholder?: string | undefined;
  /** Show what the typed text WOULD do, without committing it.
   *
   *  A field that only answers on Enter is a field you have to guess at: you
   *  type 1600 into a revolve's angle, nothing on screen moves, and the only way
   *  to find out whether that was the number you meant is to commit it, look,
   *  undo and try again. Called on a debounce while typing; the panel decides
   *  what a preview is and how to withdraw it.
   *
   *  Free text, so it will often be nonsense mid-word ("1", "16", "16m"). The
   *  panel is expected to ignore what it cannot parse rather than to flash an
   *  error at every keystroke — the ERROR path is still `commit`, which is what
   *  the user asked for by pressing Enter. */
  preview?: ((raw: string) => void) | undefined;
  /** Take the preview back down. `committing` is true when a commit is about to
   *  land, which is the panel's cue not to pay for a rebuild it is about to pay
   *  for again a line later. */
  previewEnd?: ((committing: boolean) => void) | undefined;
}>();

/** How long the typing has to stop before the preview is worth building.
 *
 *  A preview is a real rebuild through the kernel, so this is not a repaint
 *  throttle: at one per keystroke a four-digit angle would queue four sweeps,
 *  three of them for numbers the user was only passing through on the way to
 *  the fourth. Long enough to sit out a digit, short enough that a pause reads
 *  as an answer rather than as a delay. */
const PREVIEW_MS = 200;

// The keystrokeGuard replacement: a background doc change re-runs `value`, but
// the draft ignores it while this input has focus, so uncommitted keystrokes
// survive an async param commit landing from elsewhere.
const el = useTemplateRef<HTMLInputElement>("el");
const { draft, resync } = useDraft(() => props.value, el);
const error = ref<string | null>(null);

/** A commit succeeded and the field is waiting to be told how the panel spells
 *  the result. Cleared by the next keystroke, which means the user has moved on
 *  and their text outranks the answer to the previous edit. */
let settling = false;

let previewTimer = 0;
/** A preview has been asked for and not yet withdrawn. Tracked rather than
 *  withdrawing unconditionally, so a field nobody previewed never schedules a
 *  rebuild by being blurred. */
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
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = 0; }
  if (!previewing) return;
  previewing = false;
  props.previewEnd?.(committing);
}

// Leaving the field without committing — Escape, a click elsewhere, the panel
// closing under a selection change — has to take the preview down too, or the
// model is left showing a number the document does not hold and nothing on
// screen says so.
onBeforeUnmount(() => endPreview(false));

async function onChange() {
  endPreview(true); // the commit below schedules its own rebuild
  const err = props.commit(draft.value.trim());
  error.value = err;
  // On failure keep the rejected text so it can be fixed rather than retyped.
  if (err) return;
  settling = true;
  // On success, re-read: the panel may re-spell what we sent (fx badge,
  // canonical rounding, a unit the row adopted). AFTER a tick, because `value`
  // is a prop and props do not update until the re-render, so reading it here
  // resyncs the field to the value that was just replaced.
  await nextTick();
  resync();
}

// The draft ignores the source while this input has focus, which is right for an
// edit landing from somewhere else and wrong for the answer to the edit made
// here: a parameter expression commits on a promise chain and arrives several
// frames after the change event, long past the tick above. Skipped rather than
// deferred, the field sat on its pre-edit number for as long as it kept focus,
// so typing "20+5" and pressing Enter looked like it had done nothing.
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
    :class="{ 'input-error': !!error }"
    :title="error ?? hint"
    :placeholder="placeholder"
    @input="error = null; settling = false; schedulePreview()"
    @change="onChange"
    @blur="endPreview(false)"
    @keydown.esc="endPreview(false)"
  />
</template>
