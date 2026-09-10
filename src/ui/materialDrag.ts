// A material in flight, between the library and the model.
//
// WHY MODULE STATE AND NOT dataTransfer. A browser will not let you read
// `dataTransfer` during `dragover`, only on `drop`: the payload is deliberately
// hidden until the gesture completes, so that a page cannot snoop what is being
// dragged over it. That protection is exactly wrong here, because the whole
// point of this gesture is to show what WILL happen before the button is
// released, and the answer depends on which material it is (a see-through one
// and a lit one preview differently) and on what it would land on.
//
// So the payload also travels here, beside the drag, for the duration. The
// dataTransfer is still set, because that is what makes the cursor a copy cursor
// and what a drop out of the window means; this is the readable half.
//
// House shape, as ui/theme.ts and renderPrefs.ts: module state, a listener set,
// no Vue import so the headless suite can reach it.

/** What a dropped material lands on. The gesture chooses per-frame from the
 *  modifier keys, so this is not a setting anywhere, it is what the drag is
 *  saying at this instant. */
export type DropScope = "face" | "body";

export interface MaterialDrag {
  /** The material being dragged. */
  id: string;
  /** Its name, for the chip that follows the cursor: the pointer is over the
   *  model, not over the library, and by then the row is off the far side of
   *  the screen. */
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

/** Always called, from `dragend`, which fires whether the drop landed on the
 *  model, on the desktop or nowhere at all. A drag that could end without this
 *  would leave the viewport believing something is still in flight for the rest
 *  of the session. */
export function endMaterialDrag(): void {
  if (!held) return;
  held = null;
  for (const fn of listeners) fn(null);
}

export function onMaterialDragChange(fn: (d: MaterialDrag | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** What this drag is currently promising, from the modifier keys.
 *
 *  FACE is the default and the body is the modifier, which is the opposite of
 *  what it first looks like it should be. Assigning a material to a whole part
 *  already has two ways to do it that do not involve aiming (select it and press
 *  the material, or use its own menu), and neither of them can hit a face. This
 *  gesture is the only way to reach one, so it is the one the gesture is for,
 *  and the highlight says which it is before anything is committed. */
export function dropScopeFor(e: { shiftKey: boolean; altKey: boolean }): DropScope {
  return e.shiftKey || e.altKey ? "body" : "face";
}

/** The MIME type on the dataTransfer. Its own type rather than text/plain so
 *  that a drop of a file, a browser tab or a selection of text into the viewport
 *  is plainly not this. */
export const MATERIAL_MIME = "application/x-fundacad-material";
