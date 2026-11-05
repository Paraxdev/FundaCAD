// The file crates/fundacad-mcp/tests/materials.rs saves through the MCP, read by the app's own store.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { normalizeGraph, normalizeMaterial, normalizeSurface, type MaterialDef } from "../../src/document/materials";
import { compileGraph } from "../../src/viewport/proceduralSurface";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import fixture from "../fixtures/mcp-materials.json?raw";

vi.stubGlobal("window", globalThis);

const SAVED = JSON.parse(fixture) as CadDocument & {
  materials: MaterialDef[];
  faceMaterials: Record<string, string>;
  facePrints: Record<string, unknown>;
};

// The 30 by 20 by 10 box of the fixture, faces numbered as OCCT lists them: -x, +x, -y, +y, -z, +z.
function boxResult(order = [0, 1, 2, 3, 4, 5]): RebuildResult {
  const [x, y, z] = [15, 10, 5];
  const quads = [
    [-x, -y, -z, -x, -y, z, -x, y, z, -x, y, -z],
    [x, -y, -z, x, y, -z, x, y, z, x, -y, z],
    [-x, -y, -z, x, -y, -z, x, -y, z, -x, -y, z],
    [-x, y, -z, -x, y, z, x, y, z, x, y, -z],
    [-x, -y, -z, -x, y, -z, x, y, -z, x, -y, -z],
    [-x, -y, z, x, -y, z, x, y, z, -x, y, z],
  ];
  const faceIds = quads.flatMap((_, q) => [order[q]!, order[q]!]);
  return {
    mesh: {
      positions: new Float32Array(quads.flat()),
      indices: new Uint32Array(quads.flatMap((_, q) => [0, 1, 2, 0, 2, 3].map((v) => v + 4 * q))),
      faceIds: new Uint32Array(faceIds),
    },
    bodies: [{ id: "body1", faceStart: 0, faceCount: 6 }],
  } as unknown as RebuildResult;
}

function opened() {
  const box = { result: boxResult() };
  const backend = {
    async rebuild() {
      return { ok: true, result: box.result };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
  const store = new DocumentStore(backend, { parameters: {}, features: [] as Feature[] });
  store.load(fixture);
  return { store, box };
}

const entries = (s: DocumentStore) => Object.fromEntries(s.faceMaterialEntries());

describe("a file an assistant saved with materials", () => {
  it("opens with its library as saved, nothing repaired or lost", () => {
    const { store } = opened();
    expect(store.materialLibrary).toEqual(SAVED.materials);
    for (const [i, m] of SAVED.materials.entries()) expect(normalizeMaterial(m, i)).toEqual(m);
  });

  it("gives the node editor a surface and a graph it can use", () => {
    const paint = opened().store.materialLibrary.find((m) => m.id === "m-teal-paint")!;
    expect(paint.clearcoat).toBe(1);
    expect(normalizeSurface(paint.surface)).toEqual(paint.surface);
    expect(normalizeGraph(paint.surfaceGraph)).toEqual(paint.surfaceGraph);
    expect(compileGraph(paint.surfaceGraph!)).toContain("o.rough = g_n");
  });

  it("wears the assigned materials on the body and the faces", () => {
    const { store } = opened();
    expect(store.bodyMaterialId("body1")).toBe("m-teal-paint");
    expect(store.bodyMaterialOf("body1")?.name).toBe("Teal paint");
    expect(entries(store)).toEqual({ "body1#5": "m-green-glass", "body1#4": "m-steel" });
  });

  it("finds each face by its print on a build that holds the same faces, and on one that renumbers them", async () => {
    const { store, box } = opened();
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#5": "m-green-glass", "body1#4": "m-steel" });
    box.result = boxResult([3, 5, 0, 1, 2, 4]);
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#4": "m-green-glass", "body1#2": "m-steel" });
  });

  it("saves the same project state again", () => {
    const again = JSON.parse(opened().store.toJSON());
    expect(again.materials).toEqual(SAVED.materials);
    expect(again.bodyMaterial).toEqual(SAVED.bodyMaterial);
    expect(again.faceMaterials).toEqual(SAVED.faceMaterials);
    expect(again.facePrints).toEqual(SAVED.facePrints);
  });
});
