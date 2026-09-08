// The timeline's two pure bits of arithmetic, split out so they can be tested
// without a DOM: how long to wait before offering Cancel, and what the
// "building" chip should say.

// A fast op must not flash a Cancel button; a slow one must offer it early.
export const CANCEL_DELAY_MS = 700;

/** Label and bar percentage for the "building" chip.
 *
 *  The meshing (payload) phase reports feature = -1 for its whole duration,
 *  measured at 136 s on the reference assembly, so it used to render as a bar
 *  pinned at 0% under a static "meshing…". When the sidecar supplies the
 *  per-body counts, show the real fraction; fall back to the indeterminate
 *  label when it can't. */
export function buildProgress(
  progress: number | null,
  meshed: number | null,
  meshTotal: number | null,
  total: number,
): { label: string; pct: number } {
  if (progress === null) return { label: "building…", pct: 0 };
  if (progress < 0) {
    if (meshed === null || meshTotal === null || meshTotal <= 0) {
      return { label: "meshing…", pct: 0 };
    }
    const done = Math.min(meshed, meshTotal);
    return { label: `meshing ${done}/${meshTotal}`, pct: Math.round((done / meshTotal) * 100) };
  }
  return {
    label: `building ${Math.min(progress + 1, total)}/${total}`,
    pct: total === 0 ? 0 : Math.round(((progress + 1) / total) * 100),
  };
}
