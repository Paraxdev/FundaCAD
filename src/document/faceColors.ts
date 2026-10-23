// Per-face colours of an imported STEP: mechanical CAD colours faces, not products (the PN532 board styles all 1,803
// faces). Twin of the Python engine's `face_colors.py`, checked on the same fixtures.

// Wire form: `palette` of distinct colours plus `runs` of [count, paletteIndex] in face order, -1 meaning no colour.
// The reference board packs 843 faces into 3 palette entries and 9 runs.
import type { FaceColorRuns, ImportColorSource } from "../types";
import { nodeColors } from "./materials";
export type { FaceColorRuns, ImportColorSource };

// Tolerant on purpose: an overrunning run or a missing palette slot reads as "no colour" and never throws mid rebuild,
// since an old, hand-edited or truncated document may hold it.
export function decodeFaceColors(enc: FaceColorRuns | undefined, count: number): (string | null)[] {
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

// By face count like `face_colors.py`'s `dominant`: area would need a surface integral per face, and this is only what
// the few faces the file left uncoloured fall back to. Ties go to the colour seen first, so map order does not matter.
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

// Sparse against the body's dominant colour, not `bodyPaint`: the library material is only the nearest shade, and
// comparing against it named all 1,803 faces versus 50. The cost, a dominant face drawn in the material's shade, is the
// tolerance the material match already accepted. A body with no colour at all names every coloured face.
export function importedFacePaint(
  bodies:
    | readonly {
        id: string;
        faceStart: number;
        faceCount: number;
        faceColors?: FaceColorRuns;
      }[]
    | undefined,
  bodyPaint: Readonly<Record<string, string>>,
  picks?: ReadonlyMap<string, BodyColorPick>,
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const b of bodies ?? []) {
    if (!b.faceColors) continue;
    // The body's own colour was chosen over its faces, so they are not painted.
    if (picks?.get(b.id)?.bodyWins) continue;
    const colors = decodeFaceColors(b.faceColors, b.faceCount);
    const covered = bodyPaint[b.id] ? dominantFaceColor(colors) : null;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      if (c && c !== covered) out[b.faceStart + i] = c;
    }
  }
  return out;
}

// A file can style a part twice and disagree: the reference frame's faces wear feature colours (red cuts) over a black
// solid, the PN532 board the opposite. So the preference is per import (importColorSource), "bodies" by default.

// Colours written when nobody picked one; #cad1ee is SolidWorks' default part lavender.
const UNCHOSEN_COLORS = new Set(["#cad1ee"]);

function chosen(hex: string | undefined | null): string | null {
  return hex && !UNCHOSEN_COLORS.has(hex.toLowerCase()) ? hex : null;
}

export interface BodyColorPick {
  color: string | null;
  bodyWins: boolean;
}

// `partColor` is the solid's style, `ownColor` the product's, `inheritedColor` the nearest coloured ancestor's.
// With "bodies" a chosen body or product colour wins outright, otherwise the faces decide.
export function pickBodyColor(
  input: {
    partColor?: string | undefined;
    ownColor?: string | undefined;
    inheritedColor?: string | undefined;
    faceColors?: readonly (string | null)[] | undefined;
  },
  source: ImportColorSource,
): BodyColorPick {
  if (source === "bodies") {
    const own = chosen(input.partColor) ?? chosen(input.ownColor);
    if (own) return { color: own, bodyWins: true };
  }
  const faces = input.faceColors ? dominantFaceColor(input.faceColors) : null;
  return {
    color: faces ?? input.partColor ?? input.inheritedColor ?? null,
    bodyWins: false,
  };
}

// Keyed by body id; bodies not from an imported assembly are absent.
export function importedBodyColors(
  bodies:
    | readonly {
        id: string;
        faceCount: number;
        nodeRef?: string | undefined;
        faceColors?: FaceColorRuns | undefined;
        partColor?: string | undefined;
      }[]
    | undefined,
  features: readonly {
    id: string;
    type: string;
    nodes?: readonly { parent: number | null; color?: string | undefined }[] | undefined;
  }[],
  sourceOf: (featureId: string) => ImportColorSource,
): Map<string, BodyColorPick> {
  const out = new Map<string, BodyColorPick>();
  const trees = new Map<
    string,
    {
      source: ImportColorSource;
      nodes: NonNullable<(typeof features)[number]["nodes"]>;
      inherited: (string | undefined)[];
    }
  >();
  for (const f of features) {
    if (f.type !== "import" || !f.nodes) continue;
    trees.set(f.id, { source: sourceOf(f.id), nodes: f.nodes, inherited: nodeColors(f.nodes) });
  }
  if (!trees.size) return out;
  for (const b of bodies ?? []) {
    const slash = b.nodeRef ? b.nodeRef.lastIndexOf("/") : -1;
    if (slash <= 0) continue;
    const tree = trees.get(b.nodeRef!.slice(0, slash));
    if (!tree) continue;
    const index = Number(b.nodeRef!.slice(slash + 1));
    out.set(
      b.id,
      pickBodyColor(
        {
          partColor: b.partColor,
          ownColor: tree.nodes[index]?.color,
          inheritedColor: tree.inherited[index],
          faceColors: b.faceColors ? decodeFaceColors(b.faceColors, b.faceCount) : undefined,
        },
        tree.source,
      ),
    );
  }
  return out;
}
