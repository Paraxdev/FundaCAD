// A material in flight between the library and the model. The payload lives in module state too, since `dataTransfer`
// is unreadable during `dragover` and the preview depends on which material it is. dataTransfer sets the copy cursor.

/** Chosen per frame from the modifier keys, not a setting. */
export type DropScope = "face" | "body";

export interface MaterialDrag {
  id: string;
  /** For the chip following the cursor, since the library row is off screen by then. */
  name: string;
  color: string;
}

let held: MaterialDrag | null = null;
const listeners = new Set<(d: MaterialDrag | null) => void>();

export function draggingMaterial(): MaterialDrag | null {
  return held;
}

export function beginMaterialDrag(d: MaterialDrag): void {
  held = d;
  for (const fn of listeners) fn(held);
}

/** Called from `dragend`, which fires wherever the drop lands, so no drag is left in flight for the session. */
export function endMaterialDrag(): void {
  if (!held) return;
  held = null;
  for (const fn of listeners) fn(null);
}

export function onMaterialDragChange(fn: (d: MaterialDrag | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Face is the default and the body the modifier: a whole part already has two ways to get a material, and this
 *  gesture is the only way to reach a face. */
export function dropScopeFor(e: { shiftKey: boolean; altKey: boolean }): DropScope {
  return e.shiftKey || e.altKey ? "body" : "face";
}

/** Its own type, not text/plain, so a dropped file, tab or text selection is plainly not this. */
export const MATERIAL_MIME = "application/x-fundacad-material";
