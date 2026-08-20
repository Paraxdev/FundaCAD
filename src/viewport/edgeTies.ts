// When a click lands on more than one edge at once.
//
// pickEdge ranks candidates by screen distance and takes the nearest. That is
// the right rule right up until two of them are the SAME distance, which happens
// whenever two bodies meet: their shared boundary is two edges, one per body,
// lying exactly on top of each other. The winner was then whichever the
// raycaster happened to report first — stable within a session, arbitrary
// between them, and impossible to override from the keyboard or the mouse. Click
// the seam between two extrusions and you got one of them, with no way to say
// which.
//
// So the pick becomes a question when, and only when, there is something to ask.
// Two rules decide that, and the second is the one that keeps this from becoming
// a nuisance:
//
//   1. Candidates within TIE_BAND_PX of the nearest are tied. Below that the
//      user cannot aim between them anyway, so "the nearest" is not a decision
//      they made.
//   2. Tied candidates that would carry the SAME label are not a choice. Two
//      edges of one body a couple of pixels apart describe themselves
//      identically, and a menu offering the same sentence twice is worse than
//      picking one: it asks a question whose answers are indistinguishable.
//
// Rule 2 is why this takes labels rather than geometry. Whether two candidates
// are worth distinguishing is a question about what the user can be TOLD about
// them, not about how far apart they are.

/** Screen-space radius, in px, within which two edge candidates count as tied.
 *
 *  Small on purpose. This is not a grab radius — the picker's own threshold
 *  already decided what was hit — it is the distance below which the cursor
 *  cannot express a preference. Three pixels is about a mouse's own jitter. */
export const TIE_BAND_PX = 3;

export interface Candidate {
  /** distance from the cursor to this candidate, in screen px */
  screenDist: number;
  /** how this candidate would describe itself to the user */
  label: string;
}

/** The candidates worth asking about, nearest first — or NOTHING when the pick
 *  is not ambiguous.
 *
 *  An empty result means "just take the nearest", which is every ordinary click.
 *  Callers must treat it that way rather than as an error: a menu is a cost, and
 *  it is only worth paying when the alternative is guessing.
 */
export function ambiguousCandidates<T extends Candidate>(
  cands: readonly T[],
  band: number = TIE_BAND_PX,
): T[] {
  if (cands.length < 2) return [];
  const sorted = [...cands]
    .filter((c) => Number.isFinite(c.screenDist))
    .sort((a, b) => a.screenDist - b.screenDist);
  const best = sorted[0];
  if (!best) return [];

  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of sorted) {
    if (c.screenDist > best.screenDist + band) break;
    // Nearest of each label wins, so the entry the user picks is the one they
    // were closest to among the ones that call themselves that.
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c);
  }
  // One distinct label is not a question. Neither is none.
  return out.length > 1 ? out : [];
}
