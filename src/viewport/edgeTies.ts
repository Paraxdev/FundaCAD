// Edges tied within TIE_BAND_PX of a click (two bodies' shared boundary) turn the pick into a menu. Ties with the same
// label are not a choice, so this works on labels rather than geometry.

/** Not a grab radius: the distance below which the cursor cannot express a preference, about a mouse's jitter. */
export const TIE_BAND_PX = 3;

export interface Candidate {
  /** distance from the cursor to this candidate, in screen px */
  screenDist: number;
  /** how this candidate would describe itself to the user */
  label: string;
}

/** Nearest first, or empty when the pick is not ambiguous; callers then take the nearest, it is not an error. */
export function ambiguousCandidates<T extends Candidate>(cands: readonly T[], band: number = TIE_BAND_PX): T[] {
  if (cands.length < 2) return [];
  const sorted = [...cands].filter((c) => Number.isFinite(c.screenDist)).sort((a, b) => a.screenDist - b.screenDist);
  const best = sorted[0];
  if (!best) return [];

  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of sorted) {
    if (c.screenDist > best.screenDist + band) break;
    // Nearest of each label is preferred, so the entry the user picks is the one they
    // were closest to among the ones that call themselves that.
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c);
  }
  // One distinct label is not a question. Neither is none.
  return out.length > 1 ? out : [];
}
