export const SHOW_EVERY_MS = 1000;

export interface TraceProgress {
  readonly total: number;
  readonly shown: number;
  readonly shownAt: number;
  /** The highest quarter passed so far. */
  readonly quarter: 0 | 1 | 2 | 3;
}

export interface ProgressStep {
  progress: TraceProgress;
  quarter: 1 | 2 | 3 | null;
}

export function startProgress(total: number, now: number): TraceProgress {
  return { total: Math.max(1, Math.floor(total)), shown: 0, shownAt: now, quarter: 0 };
}

// Both tracers repeat unchanged counts and report faster than a screen reader can follow, so a new shown count
// is let through once a second, at a quarter, and at the total. No timer, so nothing to clean up.
export function stepProgress(p: TraceProgress, samples: number, now: number): ProgressStep {
  const same = { progress: p, quarter: null };
  if (!Number.isFinite(samples)) return same;
  const n = Math.min(p.total, Math.floor(samples));
  if (n <= p.shown) return same;
  const q = n >= p.total ? p.quarter : (Math.min(3, Math.floor((n * 4) / p.total)) as 0 | 1 | 2 | 3);
  const crossed = q > p.quarter ? (q as 1 | 2 | 3) : null;
  if (crossed === null && n < p.total && now - p.shownAt < SHOW_EVERY_MS) return same;
  return { progress: { ...p, shown: n, shownAt: now, quarter: crossed ?? p.quarter }, quarter: crossed };
}
