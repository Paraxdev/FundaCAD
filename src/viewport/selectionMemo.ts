// The drag handle is drawn from the selection, so it has to survive a rebuild: a reused body keeps its refs, a rebuilt
// one is matched by world point. Every installment of a stream makes a fresh Highlighter, hence the stream rules.

/** The fallback is O(model) each (faceIdNear walks every triangle), so a 200 face smart select would freeze every
 *  rebuild. Past the cap the selection is dropped, which one edge or one face never reaches. */
export const MAX_GEOMETRIC_REMATCH = 16;

/** `rematch` runs only for what `survivor` gave up on, while within `maxRematch`. Duplicates collapse: a fillet
 *  can merge two selected edges into one, and feeding both to a toggle would deselect it again. */
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

/** A body whose chunk has not landed is not a body whose entity is gone: the fallback would answer with another
 *  body's face, while the commit reruns this a few installments later and gets it right. */
export function remapStreamedSelection<M, E>(
  memos: readonly M[],
  survivor: (memo: M) => E | null,
  rematch: (memo: M) => E | null,
  landed: (memo: M) => boolean,
  maxRematch: number = MAX_GEOMETRIC_REMATCH,
): E[] {
  return remapSelection(memos, survivor, (m) => (landed(m) ? rematch(m) : null), maxRematch);
}

/** A commit announces either way, since "the selection is gone" is what takes a drag handle down. An installment
 *  must not: nothing back mid stream is normal, and announcing it would end the gesture just before the body lands. */
export function shouldAnnounce(captured: number, restored: number, duringStream: boolean): boolean {
  return duringStream ? restored > 0 : captured > 0;
}
