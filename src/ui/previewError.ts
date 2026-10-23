// The kernel's refusal of a value still being previewed, shown where it is typed, since rebuildBridge never toasts
// preview failures (a drag would emit one a frame). Not a build error: it vanishes the moment the value changes.

/** What the engine said, or null when the previewed value builds (or when
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

/** Fires immediately, so a box opening while a preview already fails shows it without waiting for a build. */
export function onPreviewError(fn: (message: string | null) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}
