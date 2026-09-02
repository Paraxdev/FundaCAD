// The kernel's refusal of the value somebody is in the middle of choosing.
//
// A live preview asks the sidecar to build a value before it is committed, and
// the sidecar sometimes says no: a thread whose turns would run into each other,
// a fillet larger than the edge it is on, a shell thicker than its wall. The
// answer used to go nowhere a user was looking. rebuildBridge deliberately does
// not toast a preview's failures — a drag through a bad range would emit one a
// frame — and the status bar is a strip at the far edge of the window from the
// value box under the cursor. So the model went on showing the last thing that
// DID build while the boxes read the number that did not, which is the one
// arrangement in which the screen is lying rather than merely unhelpful.
//
// A CHANNEL rather than a field on each tool, because every previewing tool has
// the same need and there are nine of them. One writer (rebuildBridge, which
// already watches every build settle) and any number of readers, so a tool opts
// in by subscribing rather than by threading a store through its constructor.
//
// This is NOT the same thing as a build error, and must not be merged with one.
// A committed feature that fails stays failed until somebody fixes it, and earns
// a toast and a red row in the timeline. A preview that fails is a question
// still being asked: it has to answer where the question is being typed, and
// vanish the moment the value changes.

/** What the sidecar said, or null when the previewed value builds (or when
 *  nothing is being previewed). */
let current: string | null = null;

const listeners = new Set<(message: string | null) => void>();

/** Publish the current preview's refusal. Called once per settled build. */
export function setPreviewError(message: string | null): void {
  const next = message && message.trim() ? message : null;
  if (next === current) return; // a drag settles many times on the same refusal
  current = next;
  for (const fn of listeners) fn(current);
}

/** What the preview is failing with right now. For a reader that appears
 *  mid-failure and needs the state before the next build settles. */
export function previewError(): string | null {
  return current;
}

/** Subscribe. Fires immediately with the current value, so a box that opens
 *  while a preview is already failing shows it rather than waiting for a build
 *  that may never come. Returns the unsubscribe. */
export function onPreviewError(fn: (message: string | null) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}
