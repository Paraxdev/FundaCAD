// Carrying a selection across a rebuild, and across a STREAM.
//
// A completed rebuild replaces the Highlighter and every trace of what was
// selected. Tolerable while selecting only lit an edge up, but direct manipulation
// makes the selection a live control: the drag handle is drawn FROM it, so
// cancelling a fillet returned you to the sharp model with no arrow, the geometry
// was back, the affordance was not.
//
// Two ways to find an entity again, in cost order:
//
//  1. It came through untouched. A body whose etag is unchanged is REUSED whole by
//     setModel, same BodyMesh, same EdgeRefs, same faceId numbering, so the old
//     reference is still right. The common case, since a rebuild usually touches
//     one body out of however many exist.
//  2. Its body was rebuilt. Ids are not stable (the client renumbers), so geometry
//     is the only identity left: match by the world-space point convention the
//     selectors already use. Correct, but each lookup walks the model.
//
// A chunked reply is the harder half, and it was missed for a long time. The
// commit is one moment and the two tiers above are enough for it; a stream is
// several, and EVERY installment publishes a fresh ModelView with a fresh
// Highlighter. So the selection was gone long before the commit ran, and the
// commit's own capture, reading that empty Highlighter, correctly reported
// "nothing is selected" and restored nothing. It looked like a tool losing its
// own gesture at random, because whether a reply streams at all depends on how
// big it is.
//
// Two rules come out of that, and both are here rather than in the viewport
// because both are decisions, not drawing.
//
// Generic over entity type so survivor reuse, the fallback, its cap and
// de-duplication can all be tested with no scene, camera or GPU.

/** Above this many entities needing the geometric fallback, drop them instead.
 *
 *  The fallback is O(model) EACH: faceIdNear walks every triangle of every
 *  body. One or two of those is invisible; a coplanar smart-select of 200 faces
 *  would turn every rebuild into a freeze. Losing the selection there is the
 *  behaviour that existed before any of this, so the cap degrades to the old
 *  outcome rather than to a new bug, and the cases direct manipulation is
 *  built around (one edge, one face) are nowhere near it. */
export const MAX_GEOMETRIC_REMATCH = 16;

/** Re-point a captured selection at a freshly rebuilt model.
 *
 *  `survivor` returns the entity when the memo came through the rebuild
 *  verbatim, else null. `rematch` is the expensive geometric fallback, called
 *  ONLY for what `survivor` gave up on, and only while the number of those
 *  stays within `maxRematch`.
 *
 *  Order follows the capture, and duplicates collapse: two selected edges can
 *  legitimately resolve to the same rebuilt edge (a fillet merging two
 *  collinear stretches into one), and feeding that to a TOGGLE would select it
 *  and then immediately deselect it. */
export function remapSelection<M, E>(
  memos: readonly M[],
  survivor: (memo: M) => E | null,
  rematch: (memo: M) => E | null,
  maxRematch: number = MAX_GEOMETRIC_REMATCH,
): E[] {
  const pairs = memos.map((m) => ({ memo: m, entity: survivor(m) }));
  const missing = pairs.filter((p) => p.entity === null).length;
  const out: E[] = [];
  const seen = new Set<E>();
  for (const p of pairs) {
    // Compared against null explicitly, never for truthiness: faceId 0 is a
    // real face and an entity type is allowed to be a number.
    const e = p.entity === null && missing <= maxRematch ? rematch(p.memo) : p.entity;
    if (e === null || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** Re-point a captured selection at ONE INSTALLMENT of a streamed rebuild.
 *
 *  The same two tiers, plus the one rule a stream adds: A BODY WHOSE CHUNK HAS
 *  NOT LANDED YET IS NOT A BODY WHOSE ENTITY IS GONE.
 *
 *  The survivor path needs no help, a body reused whole is on screen from the
 *  first installment. The geometric fallback does: it finds the nearest thing
 *  to a point, and with the right body still in flight the nearest thing is
 *  some other body's face. Answering with that is worse than not answering,
 *  because the commit re-runs this a few installments later and would have got
 *  it right. `landed` is what holds it back until then. */
export function remapStreamedSelection<M, E>(
  memos: readonly M[],
  survivor: (memo: M) => E | null,
  rematch: (memo: M) => E | null,
  landed: (memo: M) => boolean,
  maxRematch: number = MAX_GEOMETRIC_REMATCH,
): E[] {
  return remapSelection(memos, survivor, (m) => (landed(m) ? rematch(m) : null), maxRematch);
}

/** Whether a restore should tell the app the selection moved.
 *
 *  A COMMIT announces either way, and deliberately: "the selection is gone" is
 *  exactly the news a drag handle needs in order to take itself down, so the
 *  test is on what was captured, not on what came back.
 *
 *  AN INSTALLMENT MUST NOT. Mid-stream "nothing came back" is the ordinary
 *  state of a reply that has not delivered the right body yet, and announcing
 *  it takes the handle down, and ends the gesture, a few milliseconds before
 *  the body lands. Only a real restore is news. */
export function shouldAnnounce(captured: number, restored: number, duringStream: boolean): boolean {
  return duringStream ? restored > 0 : captured > 0;
}
