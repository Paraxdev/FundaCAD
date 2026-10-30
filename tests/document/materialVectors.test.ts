// tests/vectors/materials.json, replayed by the MCP too (crates/fundacad-mcp/tests/unit/materials.rs), so an
// assistant's material is repaired exactly as the Render workspace repairs it.

import { readFileSync } from "node:fs";
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

interface Vectors {
  starter: MaterialDef[];
  normalize: { name: string; raw: unknown; index?: number; out: MaterialDef | null }[];
  hex: { raw: unknown; out: string | null }[];
  slug: { name: string; id: string }[];
  unique: { id: string; taken: string[]; out: string }[];
  fresh: { names: string[]; base: string; out: string }[];
}

// Parsed by hand: an import would turn the "__proto__" key of one case into a prototype.
const V = JSON.parse(readFileSync(new URL("../vectors/materials.json", import.meta.url), "utf8")) as Vectors;

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
});
