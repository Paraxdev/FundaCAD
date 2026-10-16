// How far the viewport has got putting in the lights of glowing bodies, for the
// cue beside the Emission control. Null when nothing is pending.

let current: number | null = null;
const listeners = new Set<(p: number | null) => void>();

export function emissionProgress(): number | null {
  return current;
}

export function setEmissionProgress(p: number | null) {
  if (p === current) return;
  current = p;
  for (const fn of listeners) fn(p);
}

export function onEmissionProgress(fn: (p: number | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
