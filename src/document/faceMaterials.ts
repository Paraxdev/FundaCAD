// A material on ONE FACE rather than on a whole body.
//
// WHY THIS EXISTS SEPARATELY FROM `bodyMaterial`. A body is one lump of one
// stuff most of the time, and that is the assignment worth having: it is one
// choice for a part, it survives every edit, and it is what an imported
// assembly's own colours land in. But a great deal of what gets modelled is not
// like that. A knob with a chrome ring, a panel with a brushed insert, a lens on
// a printed housing: one solid, several surfaces. Without this the only way to
// say so is to cut the part in two, which changes the geometry to describe the
// picture.
//
// HOW A FACE IS NAMED, and the honest limit of it. `bodyId#localFaceIndex`, the
// face's position in its own body's face list. That is the same name the colours
// inside an imported STEP travel under (document/faceColors.ts), so it is not a
// new kind of promise, and it is stable for exactly as long as the body's face
// list is: moving the part, changing a dimension it does not add faces to, or
// reopening the file all keep it. Adding a fillet does NOT: the new faces
// renumber the ones after them, and an assignment can land on a neighbour.
//
// That is a real limit and it is the reason this is display state rather than a
// feature. Nothing downstream reads it, no geometry depends on it, and an
// assignment that drifts is a face wearing the wrong finish, which is visible,
// undoable in one gesture, and costs nothing else. Making it drift-proof means a
// selector the kernel re-resolves on every rebuild, which is the machinery
// fillets use, and it is a lot of machinery to spend on which of two greys a
// face is.
//
// Pure: no store, no Vue, no renderer. What a key is, and how a set of
// assignments plus a build result becomes the two maps the viewport wants.

import { finishOf, type BodyFinish, type MaterialDef } from "./materials";

/** Between the body id and the face index. "#" rather than ":" because a body id
 *  is a slug and may contain a colon in a document somebody hand-edited, while
 *  "#" is not produced by any id generator here. */
export const FACE_KEY_SEP = "#";

export function faceKey(body: string, localFace: number): string {
  return `${body}${FACE_KEY_SEP}${localFace}`;
}

/** The inverse, or null when the string is not one of ours. Tolerant because it
 *  reads a saved file: a hand-edited document must not be able to throw here. */
export function parseFaceKey(k: string): { body: string; face: number } | null {
  const at = k.lastIndexOf(FACE_KEY_SEP);
  if (at <= 0) return null;
  const body = k.slice(0, at);
  const tail = k.slice(at + 1);
  // Explicitly, because `Number("")` is 0 and 0 is a perfectly good face index:
  // without this, "body1#" reads as the first face of body1 rather than as the
  // malformed key it is.
  if (!/^\d+$/.test(tail)) return null;
  const face = Number(tail);
  if (!Number.isSafeInteger(face)) return null;
  return { body, face };
}

/** What a build result says about where one body's faces start. The subset of
 *  the body metadata this module needs, so it can be tested without one. */
export interface BodyFaceSpan {
  id: string;
  faceStart: number;
  faceCount: number;
}

/** Assignments, plus the model they are against, as GLOBAL face ids.
 *
 *  Global because that is the only face number the renderer has: the viewport
 *  paints by the id a pick returns, which is body-independent. Doing the
 *  arithmetic here, once, is what keeps the render bridge from having to know
 *  what a face key is.
 *
 *  Three ways an entry is dropped, all silent and all deliberate:
 *   * the body is gone (deleted, or renamed by a Join),
 *   * the face index is past the end of the body's list (the part got simpler),
 *   * the material has been deleted from the library.
 *  Each is the same situation as a body assignment naming a deleted material:
 *  nothing to draw, and the face goes back to what its body says. */
export function resolveFaceMaterials(
  assigned: Iterable<readonly [string, string]>,
  bodies: readonly BodyFaceSpan[] | undefined,
  library: readonly MaterialDef[],
): Map<number, MaterialDef> {
  const out = new Map<number, MaterialDef>();
  if (!bodies?.length) return out;
  const span = new Map(bodies.map((b) => [b.id, b]));
  for (const [key, matId] of assigned) {
    const parsed = parseFaceKey(key);
    if (!parsed) continue;
    const b = span.get(parsed.body);
    if (!b || parsed.face >= b.faceCount) continue;
    const m = library.find((x) => x.id === matId);
    if (!m) continue;
    out.set(b.faceStart + parsed.face, m);
  }
  return out;
}

/** Global face id → colour, the map the viewport paints per vertex. */
export function faceMaterialPaint(resolved: Map<number, MaterialDef>): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [fid, m] of resolved) out[fid] = m.color;
  return out;
}

/** Global face id → finish, the map that becomes a second material on the body's
 *  mesh. Sparse against the app's DEFAULT finish rather than against the body's:
 *  a face whose material only says "this colour" needs no material of its own,
 *  and the colour has already travelled through the paint map above. */
export function faceMaterialFinishes(
  resolved: Map<number, MaterialDef>,
): Record<number, BodyFinish> {
  const out: Record<number, BodyFinish> = {};
  for (const [fid, m] of resolved) out[fid] = finishOf(m);
  return out;
}

/** Every face key that names a body no longer in the model, so a document does
 *  not accumulate assignments to bodies that were deleted five edits ago. */
export function staleFaceKeys(
  assigned: Iterable<readonly [string, string]>,
  bodies: readonly BodyFaceSpan[] | undefined,
): string[] {
  if (!bodies) return [];
  const live = new Set(bodies.map((b) => b.id));
  const out: string[] = [];
  for (const [key] of assigned) {
    const parsed = parseFaceKey(key);
    if (!parsed || !live.has(parsed.body)) out.push(key);
  }
  return out;
}
