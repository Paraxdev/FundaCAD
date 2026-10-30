// tests/vectors/materials.json, replayed by the MCP too (crates/fundacad-mcp/tests/unit/materials.rs), so an
// assistant's material is repaired exactly as the Render workspace repairs it.

import { describe, expect, it } from "vitest";
import {
  asHex,
  freshMaterialName,
  normalizeMaterial,
  slugId,
  STARTER_LIBRARY,
  uniqueId,
  type MaterialDef,
} from "../../src/document/materials";
import { bodyPrints, loadFaceRefs, resolveFaceRefs, savedFaceRefs, type FacePrint } from "../../src/document/faceRefs";
import type { RebuildResult } from "../../src/types";
import vectorsJson from "../vectors/materials.json?raw";

interface Vectors {
  starter: MaterialDef[];
  normalize: { name: string; raw: unknown; index?: number; out: MaterialDef | null }[];
  hex: { raw: unknown; out: string | null }[];
  slug: { name: string; id: string }[];
  unique: { id: string; taken: string[]; out: string }[];
  fresh: { names: string[]; base: string; out: string }[];
  prints: PrintCase[];
  rekey: RekeyCase[];
}

interface RekeyCase {
  name: string;
  positions: number[];
  indices: number[];
  faceIds: number[];
  faceCount: number;
  materials: Record<string, string>;
  prints: Record<string, FacePrint>;
  out: { materials: Record<string, string>; prints: Record<string, FacePrint> };
}

interface PrintCase {
  name: string;
  positions: number[];
  indices: number[];
  faceIds: number[];
  faceCount: number;
  prints: FacePrint[];
}

function resultOf(c: Pick<PrintCase, "positions" | "indices" | "faceIds" | "faceCount">): RebuildResult {
  return {
    mesh: {
      positions: new Float32Array(c.positions),
      indices: new Uint32Array(c.indices),
      faceIds: new Uint32Array(c.faceIds),
    },
    bodies: [{ id: "body1", faceStart: 0, faceCount: c.faceCount }],
  } as unknown as RebuildResult;
}

// Parsed by hand: an import would turn the "__proto__" key of one case into a prototype.
const V = JSON.parse(vectorsJson) as Vectors;

describe("material vectors shared with the MCP", () => {
  it("offers the same starter library", () => {
    expect(JSON.stringify(STARTER_LIBRARY)).toBe(JSON.stringify(V.starter));
  });

  it("normalizes each case to the recorded material, keys in the same order", () => {
    for (const c of V.normalize) {
      expect(JSON.stringify(normalizeMaterial(c.raw, c.index ?? 0)), c.name).toBe(JSON.stringify(c.out));
    }
  });

  it("reads hex, ids and names the same way", () => {
    for (const c of V.hex) expect(asHex(c.raw), String(c.raw)).toBe(c.out);
    for (const c of V.slug) expect(slugId(c.name), c.name).toBe(c.id);
    for (const c of V.unique) expect(uniqueId(c.id, new Set(c.taken))).toBe(c.out);
    for (const c of V.fresh) {
      const library = c.names.map((name, i) => ({ id: `m-${i}`, name, color: "#ffffff" }));
      expect(freshMaterialName(library, c.base)).toBe(c.out);
    }
  });

  it("prints each face the same way", () => {
    for (const c of V.prints) {
      const result = resultOf(c);
      expect(JSON.stringify(bodyPrints(result, result.bodies![0]!)), c.name).toBe(JSON.stringify(c.prints));
    }
  });

  it("saves each face at the number it finds itself on", () => {
    for (const c of V.rekey) {
      const result = resultOf(c);
      const entries = loadFaceRefs(c.materials, c.prints).map((ref, i): [string, typeof ref] => [String(i), ref]);
      const saved = savedFaceRefs(entries, resolveFaceRefs(entries, result, null), result);
      expect(JSON.stringify(saved), c.name).toBe(JSON.stringify(c.out));
    }
  });

  it("finds a printed face after a build reorders the faces, where a bare key would stay on the old number", () => {
    const box = V.prints[0]!;
    const order = [3, 5, 0, 1, 2, 4];
    const reordered = resultOf({ ...box, faceIds: box.faceIds.map((f) => order[f]!) });
    const materials = { "body1#2": "m-steel" };
    const entries = (prints: unknown) =>
      loadFaceRefs(materials, prints).map((ref, i): [string, typeof ref] => [String(i), ref]);
    const lands = (prints: unknown) => resolveFaceRefs(entries(prints), reordered, null).faces.get("0");
    expect(lands({ "body1#2": box.prints[2] })).toEqual([order[2]]);
    expect(lands({})).toEqual([2]);
  });
});
