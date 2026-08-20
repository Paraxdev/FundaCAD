// How big a screen-space glyph is allowed to be.
//
// Two kinds of thing get drawn into the 3D scene that are not part of the model:
// the manipulators you grab, and the markers that say where something is. Both
// want to be a fixed size ON SCREEN rather than a fixed size in millimetres,
// because both are aimed at with a mouse and a mouse does not zoom. A glyph
// modelled in millimetres is only ever right at one zoom: the origin arrows were
// 20mm arms, which on a fitted 6mm block measured 1253 PIXELS end to end, and
// 82,000 by the time the zoom reached the floor.
//
// Constant pixels is not quite the whole rule though. Zoom out until the part is
// a thumbnail and a constant-size glyph becomes a balloon with an object hanging
// off it, so the pixel size stands only until the glyph would take up more than
// a fraction of the model's own on-screen size, and from there the two shrink
// together. There is a floor under that, because a glyph shrunk past the point
// of being aimable is a control that has effectively disappeared, which is worse
// than one that merely looks too big.
//
// This lives in viewport/ rather than in features/ because both sides need it
// and features/manipulator.ts already imports the viewport: putting the rule the
// other way round would be a cycle. One copy either way, which is the point —
// two glyphs sized by two different rules drift, and the drift shows up as one
// of them looking wrong at a zoom nobody tested.

/** Most of the model's on-screen size a glyph may occupy. */
export const GLYPH_MODEL_FRACTION = 0.45;

/** Multiplier on the constant-pixel scale for a glyph `glyphPx` pixels long.
 *
 *  Returns 1 when there is nothing to measure against, and never 0: a scale of
 *  zero collapses the glyph AND any invisible grab volume with it, which is
 *  indistinguishable from the thing being broken.
 *
 *  `minScale` is the caller's, because what counts as too small depends on what
 *  the glyph is for. A handle has to stay big enough to hit; a marker only has
 *  to stay big enough to see. */
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

/** World units the glyph's own units become, ready for `scale.setScalar`.
 *
 *  The glyph is modelled in pixels, so one of its units is one screen pixel
 *  multiplied by whatever the cap above allows. Falls back to 0 world size for
 *  an unusable pixel size rather than to some guessed default, because a glyph
 *  drawn at the wrong scale in a 3D scene is worse than one not drawn: it is
 *  indistinguishable from geometry. */
export function glyphWorldScale(
  glyphPx: number,
  modelDiagonal: number | null,
  pixelWorldSize: number | null,
  minScale: number,
): number {
  if (pixelWorldSize == null || !Number.isFinite(pixelWorldSize) || pixelWorldSize <= 0) return 0;
  return pixelWorldSize * glyphScale(glyphPx, modelDiagonal, pixelWorldSize, minScale);
}
