// Emission on a model with hundreds of glowing bodies: a slider step must not
// re-fit every body's area lights, and the scene's light structure must not
// change under it, or three.js relinks every lit program in the middle of a drag.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { BodyFinishLayer, type FinishHost, type FinishOverlays } from "../../src/viewport/bodyFinish";
import type { BodyMesh, ModelView } from "../../src/viewport/render";
import { FINISH } from "../../src/document/materials";
import * as emitters from "../../src/viewport/emitters";

vi.mock("../../src/viewport/emitters", async (orig) => {
  const m = await orig<typeof import("../../src/viewport/emitters")>();
  return { ...m, areaEmitters: vi.fn(m.areaEmitters) };
});
const fits = vi.mocked(emitters.areaEmitters);

/** A flat square of side `s` at x = `x`, one face. */
function quad(id: string, fid: number, s = 1, x = 0): BodyMesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([x, 0, 0, x + s, 0, 0, x + s, s, 0, x, s, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  return { id, name: id, faceStart: fid, faceCount: 1, mesh, faceIds: [fid, fid], baseColors: new Float32Array(12), faceTriangles: new Map() } as unknown as BodyMesh;
}

interface Rig { layer: BodyFinishLayer; root: THREE.Group; later: (() => void)[] }

function rig(bodies: BodyMesh[], extra: Partial<FinishHost> = {}, shadows = true): Rig {
  const model = { bodies, edges: [] } as unknown as ModelView;
  const root = new THREE.Group();
  const later: (() => void)[] = [];
  const layer = new BodyFinishLayer({
    model: () => model,
    scene: () => ({ renderer: { shadowMap: { enabled: shadows } } }) as never,
    faceIdToBodyId: (fid) => bodies.find((b) => b.faceIds.includes(fid))?.id ?? null,
    addToScene: (o) => root.add(o),
    requestRender: () => {},
    savedMats: () => new Map(),
    ...extra,
  });
  return { layer, root, later };
}

function lights(root: THREE.Object3D) {
  const area: THREE.RectAreaLight[] = [];
  const shadow: THREE.PointLight[] = [];
  root.traverseVisible((o) => {
    if (o instanceof THREE.RectAreaLight) area.push(o);
    if (o instanceof THREE.PointLight && o.castShadow) shadow.push(o);
  });
  return { area, shadow, lit: area.filter((a) => a.intensity > 0) };
}

const base: FinishOverlays = { xray: false, stale: false, wireframe: false };
const glow = (v: number) => ({ ...FINISH, emissive: v });

beforeEach(() => { fits.mockClear(); });

describe("emitter lights on a glow change", () => {
  it("re-uses the fitted patches when only the amount changes", () => {
    const a = quad("a", 0);
    const { layer, root } = rig([a]);
    layer.bodyFinish = { a: glow(0.3) };
    layer.apply(base);
    const first = lights(root).lit[0]!.intensity;
    layer.bodyFinish = { a: glow(0.6) };
    layer.apply(base);
    expect(fits).toHaveBeenCalledTimes(1);
    expect(lights(root).lit[0]!.intensity).toBeCloseTo(first * 2);
  });

  it("fits again when the geometry or the set of glowing faces changes", () => {
    const a = quad("a", 0);
    const b = quad("b", 1, 1, 3);
    const { layer } = rig([a, b]);
    layer.bodyFinish = { a: glow(0.3) };
    layer.apply(base);
    expect(fits).toHaveBeenCalledTimes(1);
    a.mesh.geometry = quad("a", 0, 2).mesh.geometry;
    layer.apply(base);
    expect(fits).toHaveBeenCalledTimes(2);
    layer.faceFinish = { 1: glow(0.5) };
    layer.apply(base);
    expect(fits).toHaveBeenCalledTimes(3);
  });

  it("does no emitter work at all when nothing glows", () => {
    const { layer, root } = rig([quad("a", 0), quad("b", 1, 1, 3)]);
    layer.bodyFinish = { a: { ...FINISH, roughness: 0.2 } };
    layer.apply(base);
    expect(fits).not.toHaveBeenCalled();
    expect(lights(root).area.length + lights(root).shadow.length).toBe(0);
  });

  it("fits only the bodies that can still reach the brightest few, and keeps the same lights", () => {
    const bodies = Array.from({ length: 200 }, (_, i) => quad(`b${i}`, i, 0.5 + ((i * 37) % 200) / 20, i * 20));
    const finish = Object.fromEntries(bodies.map((b) => [b.id, glow(0.4)]));
    const { layer, root } = rig(bodies);
    layer.bodyFinish = finish;
    layer.apply(base);
    expect(fits.mock.calls.length).toBeLessThan(bodies.length / 2);
    const kept = lights(root).lit.map((l) => `${l.width.toFixed(2)}@${l.position.x.toFixed(3)}`).sort();

    const sizes = bodies.map((b) => ({ x: (b.mesh.geometry.getAttribute("position").array as Float32Array)[0]!, s: 0.5 + ((Number(b.id.slice(1)) * 37) % 200) / 20 }));
    const brute = sizes.sort((p, q) => q.s - p.s).slice(0, 12).map((p) => `${p.s.toFixed(2)}@${(p.x + p.s / 2).toFixed(3)}`).sort();
    expect(kept).toEqual(brute);
  });
});

describe("emitter light structure", () => {
  it("keeps the number of lights and shadow casters through a drag and as patches come and go", () => {
    const bodies = [quad("a", 0), quad("b", 1, 2, 3), quad("c", 2, 3, 8)];
    const { layer, root } = rig(bodies);
    const shape = () => { const l = lights(root); return [l.area.length, l.shadow.length]; };
    layer.bodyFinish = { a: glow(0.3) };
    layer.apply(base);
    const first = shape();
    expect(first[1]).toBe(2);
    for (const v of [0.6, 0.1, 0.9]) {
      layer.bodyFinish = { a: glow(v), b: glow(v) };
      layer.apply(base);
      expect(shape()).toEqual(first);
    }
    layer.bodyFinish = { a: glow(0.2), b: glow(0.2), c: glow(0.2) };
    layer.apply(base);
    expect(shape()).toEqual(first);
    layer.bodyFinish = {};
    layer.apply(base);
    expect(shape()).toEqual([0, 0]);
  });

  it("pairs the real shadow casters with the brightest area lights and pads after them", () => {
    const { layer, root } = rig([quad("a", 0, 2)]);
    layer.bodyFinish = { a: glow(0.5) };
    layer.apply(base);
    const { area, shadow } = lights(root);
    expect(area[0]!.intensity).toBeGreaterThan(0);
    expect(area.slice(1).every((l) => l.intensity === 0)).toBe(true);
    expect(shadow[0]!.shadow.autoUpdate).toBe(true);
    expect(shadow[1]!.shadow.autoUpdate).toBe(false);
  });

  it("keeps the old lights until the new structure's programs are ready, and drops a stale one", async () => {
    let release: (() => void)[] = [];
    const prepareLights = vi.fn(() => new Promise<void>((r) => release.push(r)));
    const a = quad("a", 0);
    const { layer, root } = rig([a], { prepareLights });
    layer.bodyFinish = { a: glow(0.3) };
    layer.apply(base);
    expect(prepareLights).toHaveBeenCalledTimes(1);
    expect(lights(root).area.length).toBe(0);
    layer.bodyFinish = {};
    layer.apply(base);
    release.forEach((r) => r());
    release = [];
    await Promise.resolve();
    await Promise.resolve();
    expect(lights(root).area.length).toBe(0);

    layer.bodyFinish = { a: glow(0.3) };
    layer.apply(base);
    release.forEach((r) => r());
    await Promise.resolve();
    await Promise.resolve();
    expect(lights(root).lit.length).toBe(1);
  });
});

describe("progressive emitter fill", () => {
  it("spreads cold fits over frames, reports progress, and ends with the full set", () => {
    const bodies = Array.from({ length: 30 }, (_, i) => quad(`b${i}`, i, 1 + i / 10, i * 20));
    const finish = Object.fromEntries(bodies.map((b) => [b.id, glow(0.4)]));
    const progress: (number | null)[] = [];
    const queue: (() => void)[] = [];
    const { layer, root } = rig(bodies, { later: (fn) => queue.push(fn), onEmitterProgress: (p) => progress.push(p) });
    layer.fitBudgetMs = 0;
    layer.bodyFinish = finish;
    layer.apply(base);
    expect(fits).toHaveBeenCalledTimes(1);
    expect(lights(root).lit.length).toBe(1);
    while (queue.length) queue.shift()!();
    expect(progress.at(-1)).toBeNull();
    expect(progress.slice(0, -1).every((p) => p !== null && p > 0 && p < 1)).toBe(true);
    expect(lights(root).lit.length).toBe(12);

    const sync = rig(bodies);
    sync.layer.bodyFinish = finish;
    sync.layer.apply(base);
    const key = (r: THREE.Object3D) => lights(r).lit.map((l) => l.position.x.toFixed(3)).sort();
    expect(key(root)).toEqual(key(sync.root));
  });
});
