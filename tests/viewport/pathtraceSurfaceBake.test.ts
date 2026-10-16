import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { SurfaceGraph } from "../../src/document/materials";
import { BlasCache, mainThreadBuilder } from "../../src/viewport/pathtrace/blasCache";
import { colorSignature, type SurfaceBake, type SurfaceBaker } from "../../src/viewport/pathtrace/mirror";
import { createSurfaceBaker, type SurfaceShade } from "../../src/viewport/pathtrace/surfaceBake";
import { applySurface, applySurfaceGraph, surfaceBakeShader } from "../../src/viewport/proceduralSurface";

const RED_NOISE = { kind: "noise" as const, scale: 2, amount: 0.4, color: "#ff0000", colorAmount: 0.5 };

function surfaced(color = 0x808080): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.5 });
  applySurface(m, RED_NOISE);
  return m;
}

function body(mat: THREE.Material | THREE.Material[], base?: number): THREE.Mesh {
  const g = new THREE.BoxGeometry(10, 10, 10);
  const m = new THREE.Mesh(g, mat);
  const n = g.getAttribute("position").count;
  m.userData.owner = { id: "body1", ...(base === undefined ? {} : { baseColors: new Float32Array(n * 3).fill(base), baseVersion: 1 }) };
  return m;
}

/** Tints every vertex of the listed slot fully with one colour. */
function stubBaker(slotIndex: number, tint: [number, number, number], amount: number, rough: number): SurfaceBaker {
  return (src) => {
    const n = src.geometry.getAttribute("position").count;
    const slot = new Int16Array(n).fill(-1);
    const groups = Array.isArray(src.material) ? src.geometry.groups : [{ start: 0, count: src.geometry.index!.count, materialIndex: 0 }];
    for (const g of groups) {
      if (g.materialIndex !== slotIndex) continue;
      for (let i = g.start; i < g.start + g.count; i++) slot[src.geometry.index!.getX(i)] = slotIndex;
    }
    const bake: SurfaceBake = {
      slot,
      tint: new Float32Array(n * 3).map((_, i) => tint[i % 3]!),
      amount: new Float32Array(n).fill(amount),
      rough: new Map([[slotIndex, rough]]),
    };
    return bake;
  };
}

function mirrored(src: THREE.Mesh, bake?: SurfaceBaker): THREE.Mesh {
  const cache = new BlasCache(mainThreadBuilder);
  const sync = cache.sync([src], [src]);
  cache.syncMaterials();
  cache.syncColors(bake);
  return sync.meshes![0]!;
}

function slotMaterial(m: THREE.Mesh, i = 0): THREE.MeshPhysicalMaterial {
  return (Array.isArray(m.material) ? m.material[i] : m.material) as THREE.MeshPhysicalMaterial;
}

function colorAt(m: THREE.Mesh, v: number): number[] {
  const c = m.geometry.getAttribute("color");
  return [c.getX(v), c.getY(v), c.getZ(v)];
}

describe("procedural surface reaches the traced mirror", () => {
  it("the bake shader comes from the same pieces as the Realtime one", () => {
    expect(surfaceBakeShader(new THREE.MeshPhysicalMaterial())).toBeNull();
    const pick = surfaced();
    const s = surfaceBakeShader(pick)!;
    expect(s.glsl).toContain("SurfOut surfBake(vec3 wp, vec3 wn)");
    expect(s.glsl).toContain("float sGen(");
    expect(s.glsl).not.toContain("varying");
    expect(s.uniforms).toBe(pick.userData.surfUniforms);
    const graph: SurfaceGraph = {
      output: "out",
      nodes: [
        { id: "n", type: "noise", params: { scale: 3 } },
        { id: "out", type: "output", in: { rough: "n" } },
      ],
    };
    const gm = new THREE.MeshPhysicalMaterial();
    applySurfaceGraph(gm, graph);
    const gs = surfaceBakeShader(gm)!;
    expect(gs.glsl).toContain("SurfOut sGraph(vec3 wp, vec3 wn)");
    expect(gs.glsl).toContain("return sGraph(wp, wn);");
  });

  it("a surfaced body with no paint gets mix(colour, tint, amount) in the mirror's own colours", () => {
    const src = body(surfaced(0x808080));
    const m = mirrored(src, stubBaker(0, [1, 0, 0], 0.5, 0.2));
    const grey = new THREE.Color(0x808080).r;
    expect(colorAt(m, 0)[0]).toBeCloseTo(grey + (1 - grey) * 0.5);
    expect(colorAt(m, 0)[1]).toBeCloseTo(grey * 0.5);
    const mat = slotMaterial(m);
    expect(mat.vertexColors).toBe(true);
    expect(mat.color.getHex()).toBe(0xffffff);
    expect(mat.roughness).toBeCloseTo(0.7);
    expect(src.geometry.getAttribute("color")).toBeUndefined();
  });

  it("paint under a surface is kept and the viewport's base colours are untouched", () => {
    const src = body(surfaced(0xffffff), 0.25);
    const base = (src.userData.owner as { baseColors: Float32Array }).baseColors;
    const m = mirrored(src, stubBaker(0, [0, 0, 1], 0.5, 0));
    expect(colorAt(m, 3)).toEqual([0.125, 0.125, 0.625].map((x) => expect.closeTo(x, 5)));
    expect(base.every((x) => x === 0.25)).toBe(true);
    expect(m.geometry.getAttribute("color").array).not.toBe(base);
  });

  it("only the surfaced face slot is tinted and turned white", () => {
    const plain = new THREE.MeshPhysicalMaterial({ color: 0x00ff00 });
    const src = body([plain, surfaced()]);
    const m = mirrored(src, stubBaker(1, [1, 0, 0], 1, 0));
    const g = src.geometry;
    const first = g.groups.find((x) => x.materialIndex === 0)!;
    const second = g.groups.find((x) => x.materialIndex === 1)!;
    expect(colorAt(m, g.index!.getX(first.start))).toEqual([1, 1, 1]);
    expect(colorAt(m, g.index!.getX(second.start))).toEqual([1, 0, 0]);
    expect(slotMaterial(m, 0).color.getHex()).toBe(0x00ff00);
    expect(slotMaterial(m, 1).color.getHex()).toBe(0xffffff);
  });

  it("removing the surface brings the plain material back", () => {
    const mat = surfaced(0x336699);
    const src = body(mat);
    const cache = new BlasCache(mainThreadBuilder);
    const m = cache.sync([src], [src]).meshes![0]!;
    cache.syncColors(stubBaker(0, [1, 0, 0], 1, 0.3));
    expect(slotMaterial(m).color.getHex()).toBe(0xffffff);
    applySurface(mat, undefined);
    cache.syncMaterials();
    cache.syncColors(stubBaker(0, [1, 0, 0], 1, 0.3));
    expect(m.geometry.getAttribute("color")).toBeUndefined();
    expect(slotMaterial(m).vertexColors).toBe(false);
    expect(slotMaterial(m).color.getHex()).toBe(0x336699);
    expect(slotMaterial(m).roughness).toBeCloseTo(0.5);
  });

  it("the colour signature follows a surface edit and the colour under it, not a plain slot", () => {
    const plain = new THREE.MeshPhysicalMaterial();
    const surf = surfaced();
    const src = body([plain, surf]);
    const sig = () => colorSignature([src]);
    const a = sig();
    plain.color.set(0x123456);
    expect(sig()).toBe(a);
    surf.color.set(0x654321);
    const b = sig();
    expect(b).not.toBe(a);
    applySurface(surf, { ...RED_NOISE, colorAmount: 0.9 });
    expect(sig()).not.toBe(b);
  });
});

describe("surface baker", () => {
  // Fully red where the sample sits at x > 0 in world space, rough offset 0.2.
  const shade: SurfaceShade = (pos, _nrm, count) => {
    const tint = new Float32Array(count * 4);
    const rough = new Float32Array(count).fill(0.2);
    for (let i = 0; i < count; i++) {
      tint[i * 4] = 1;
      tint[i * 4 + 3] = pos[i * 3]! > 0 ? 1 : 0;
    }
    return { tint, rough };
  };

  it("averages area weighted samples per vertex, in world space", () => {
    const src = body(surfaced());
    const bake = createSurfaceBaker(shade)(src)!;
    const pos = src.geometry.getAttribute("position");
    const nrm = src.geometry.getAttribute("normal");
    for (let v = 0; v < pos.count; v++) {
      expect(bake.slot[v]).toBe(0);
      if (nrm.getX(v) > 0.5) expect(bake.amount[v]).toBeCloseTo(1);
      if (nrm.getX(v) < -0.5) expect(bake.amount[v]).toBeCloseTo(0);
      if (bake.amount[v]! > 0) expect(bake.tint[v * 3]).toBeCloseTo(1);
    }
    expect(bake.rough.get(0)).toBeCloseTo(0.2);
    src.position.x = 100;
    src.geometry.getAttribute("position").needsUpdate = true;
    const moved = createSurfaceBaker(shade)(src)!;
    expect([...moved.amount].every((a) => a > 0.999)).toBe(true);
  });

  it("bakes once per surface and geometry, and skips bodies with no surface", () => {
    const spy = vi.fn(shade);
    const bake = createSurfaceBaker(spy);
    expect(bake(body(new THREE.MeshPhysicalMaterial()))).toBeNull();
    const src = body(surfaced());
    const first = bake(src);
    expect(bake(src)).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    applySurface(src.material as THREE.Material, { ...RED_NOISE, scale: 5 });
    expect(bake(src)).not.toBe(first);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
