// The command palette's fuzzy matcher, lifted out of the palette itself so it
// stays testable as plain logic (no DOM, so it lives in the *.test.ts suite).

/** Subsequence fuzzy score: every query char must appear in order; contiguous
 *  runs and start-of-string matches score higher; mild preference for short
 *  labels. Returns 0 for "no match", callers filter on `> 0`. */
export function score(q: string, text: string): number {
  if (!q) return 1;
  let ti = 0;
  let s = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = text.indexOf(ch, ti);
    if (idx === -1) return 0;
    s += idx === ti ? 2 + streak : 1;
    streak = idx === ti ? streak + 1 : 0;
    if (idx === 0) s += 3;
    ti = idx + 1;
  }
  return s + Math.max(0, 10 - text.length) * 0.1;
}
