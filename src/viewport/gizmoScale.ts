// Screen space glyphs keep a constant pixel size (20mm origin arrows measured 1253 px on a fitted 6mm block) until they
// cover GLYPH_MODEL_FRACTION of the model on screen, then shrink to a floor. In viewport/ as manipulator.ts imports it.

/** Most of the model's on-screen size a glyph may occupy. */
export const GLYPH_MODEL_FRACTION = 0.45;

/** Multiplier on the constant pixel scale: 1 with nothing to measure against, never 0, which would collapse the grab
 *  volume too. `minScale` is the caller's floor, as a glyph too small to aim at is a lost control: a handle must stay
 *  hittable, a marker only visible. */
export function glyphScale(
  glyphPx: number,
  modelDiagonal: number | null,
  pixelWorldSize: number | null,
  minScale: number,
): number {
  if (!Number.isFinite(glyphPx) || glyphPx <= 0) return 1;
  if (modelDiagonal == null || !Number.isFinite(modelDiagonal) || modelDiagonal <= 0) return 1;
  if (pixelWorldSize == null || !Number.isFinite(pixelWorldSize) || pixelWorldSize <= 0) return 1;
  const modelPx = modelDiagonal / pixelWorldSize;
  if (!Number.isFinite(modelPx) || modelPx <= 0) return 1;
  const allowed = modelPx * GLYPH_MODEL_FRACTION;
  return Math.max(minScale, Math.min(1, allowed / glyphPx));
}

/** World units per glyph unit, ready for `scale.setScalar`. An unusable pixel size gives 0, since a glyph at a guessed
 *  scale looks like geometry. */
export function glyphWorldScale(
  glyphPx: number,
  modelDiagonal: number | null,
  pixelWorldSize: number | null,
  minScale: number,
): number {
  if (pixelWorldSize == null || !Number.isFinite(pixelWorldSize) || pixelWorldSize <= 0) return 0;
  return pixelWorldSize * glyphScale(glyphPx, modelDiagonal, pixelWorldSize, minScale);
}
