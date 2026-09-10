// Per-face colours as they arrive from an imported file.
//
// A STEP written by a mechanical CAD system colours FACES, not products: the
// reference PN532 board attaches a style to all 1,803 of its faces and only a
// near-useless per-product default to its 29 products, so a reader that only
// asks the product tree renders a red circuit board as a uniform pale grey.
// That is what this carries, and it is why a body's own colour is not enough.
//
// The wire form is packed, because there is one entry per face and a large
// assembly has six figures of them: a palette (a file uses a handful of distinct
// colours) plus run-length encoding (faces of one colour are contiguous, being
// the faces of one feature of one part). The reference board packs 843 faces
// into 3 palette entries and 9 runs.
//
// sidecar/face_colors.py writes it and holds the same two functions; the two are
// checked against one another on the same fixtures. Pure list arithmetic, no
// document and no renderer: what the colours MEAN is decided in rebuildBridge.

// The packed form itself is declared in types.ts with the rest of the wire
// contract, and re-exported here so a reader who found the decoder has the shape
// in front of them: `palette` is the distinct colours, `runs` is [count,
// paletteIndex] in face order, and an index of -1 means those faces carry no
// colour of their own.
import type { FaceColorRuns } from "../types";
export type { FaceColorRuns };

/** Unpack to exactly `count` entries, "#rrggbb" or null.
 *
 *  Tolerant on purpose. This reads a field of a saved document that may have
 *  been written by an older build, hand-edited, or truncated, and the honest
 *  answer to a run that overruns is "those faces have no colour of their own",
 *  never a throw in the middle of assembling a rebuild. A run naming a palette
 *  slot that is not there reads the same way. */
export function decodeFaceColors(
  enc: FaceColorRuns | undefined,
  count: number,
): (string | null)[] {
  const n = Math.max(0, Math.floor(count));
  const out: (string | null)[] = new Array(n).fill(null);
  if (!enc || !Array.isArray(enc.runs)) return out;
  const palette = Array.isArray(enc.palette) ? enc.palette : [];
  let at = 0;
  for (const run of enc.runs) {
    const len = Math.floor(Number(run?.[0]));
    const idx = Math.floor(Number(run?.[1]));
    if (!Number.isFinite(len) || !Number.isFinite(idx)) break;
    if (len <= 0) continue;
    const hex = idx >= 0 && idx < palette.length ? (palette[idx] ?? null) : null;
    for (let k = at; k < Math.min(at + len, n); k++) out[k] = hex;
    at += len;
    if (at >= n) break;
  }
  return out;
}

/** The colour to treat as the whole body's own, or null.
 *
 *  By face COUNT, matching sidecar/face_colors.py's `dominant`, and for the same
 *  reason: area is the better answer to "what colour does this part look" and it
 *  costs a surface integration per face, which nothing on either side of the
 *  wire is holding when this is asked. It matters less than it sounds like,
 *  because this is only what the faces the file did NOT colour fall back to, and
 *  a file that colours faces at all colours nearly all of them.
 *
 *  Ties fall to the colour that appears first, so the answer does not depend on
 *  map iteration order. */
export function dominantFaceColor(colors: readonly (string | null)[]): string | null {
  const tally = new Map<string, number>();
  for (const c of colors) if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
  if (tally.size === 0) return null;
  let best: string | null = null;
  for (const c of colors) {
    if (c && (best === null || (tally.get(c) ?? 0) > (tally.get(best) ?? 0))) best = c;
  }
  return best;
}

/** The per-FACE entries an imported document contributes to the viewport's face
 *  paint map: global face id → "#rrggbb".
 *
 *  SPARSE against the body's OWN dominant colour, which is what makes it sparse
 *  at all. A body's material carries its dominant colour already, so naming
 *  those faces here would be saying the same thing twice, six figures of times
 *  on a large assembly. Only the minority faces are named: on the reference
 *  circuit board, 17 of 843.
 *
 *  Deliberately NOT sparse against `bodyPaint`. The material a body ends up
 *  wearing is the NEAREST one in the library, not necessarily an exact match
 *  (materials.ts's `materialsForColors` explains why), so comparing against it
 *  makes the saving depend on whether the library happened to hold that shade:
 *  measured on the reference assembly, comparing against the material named all
 *  1,803 faces and comparing against the dominant named 50. The cost of the
 *  difference is that a face equal to its body's dominant is drawn in the
 *  material's shade rather than the file's, which is the same small tolerance
 *  the material match already accepted for the body as a whole.
 *
 *  `bodyPaint` is still read, for the one case where that reasoning does not
 *  hold: a body with NO colour at all is drawn in the neutral shade, and
 *  leaving its dominant faces to that would throw the file's colour away. Such
 *  a body names every coloured face it has. */
export function importedFacePaint(
  bodies: readonly {
    id: string;
    faceStart: number;
    faceCount: number;
    faceColors?: FaceColorRuns;
  }[] | undefined,
  bodyPaint: Readonly<Record<string, string>>,
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const b of bodies ?? []) {
    if (!b.faceColors) continue;
    const colors = decodeFaceColors(b.faceColors, b.faceCount);
    const covered = bodyPaint[b.id] ? dominantFaceColor(colors) : null;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      if (c && c !== covered) out[b.faceStart + i] = c;
    }
  }
  return out;
}
