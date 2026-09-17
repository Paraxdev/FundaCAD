// tests/vectors/face_colors.json, recorded from sidecar/face_colors.py and also
// replayed by fundacad-core (crates/fundacad-core/tests/shared_vectors.rs).

import { describe, expect, it } from "vitest";
import { decodeFaceColors, dominantFaceColor } from "../../src/document/faceColors";
import type { FaceColorRuns } from "../../src/types";
import RAW from "../vectors/face_colors.json";

interface Vectors {
  encode: { name: string; colors: (string | null)[]; packed: FaceColorRuns | null }[];
  decode: { packed: FaceColorRuns | null; count: number; colors: (string | null)[] }[];
  dominant: { colors: (string | null)[]; dominant: string | null }[];
}

const V = RAW as unknown as Vectors;

describe("face colour vectors shared with the engine", () => {
  it("unpacks what the engine packed", () => {
    for (const c of V.encode) {
      if (c.packed) expect(decodeFaceColors(c.packed, c.colors.length), c.name).toEqual(c.colors);
    }
  });

  it("decodes tolerantly", () => {
    for (const c of V.decode) {
      expect(decodeFaceColors(c.packed ?? undefined, c.count), JSON.stringify(c.packed)).toEqual(c.colors);
    }
  });

  it("picks the dominant colour", () => {
    for (const c of V.dominant) expect(dominantFaceColor(c.colors)).toBe(c.dominant);
  });
});
