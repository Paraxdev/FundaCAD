// The Realtime composer runs only when something on screen glows, since bloom
// there reads the glow mask. A shiny finish alone must not pay for it.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { BodyFinishLayer, type FinishHost, type FinishOverlays } from "../../src/viewport/bodyFinish";
import type { BodyMesh, ModelView } from "../../src/viewport/render";
import { FINISH } from "../../src/document/materials";
import { PostChain } from "../../src/viewport/scene";
import { DEFAULT_RENDER, setRenderPref } from "../../src/ui/renderPrefs";

function quad(id: string, fid: number, x: number): BodyMesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([x, 1, 0, x + 2, 1, 0, x + 2, 3, 0, x, 3, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  return { id, name: id, faceStart: fid, faceCount: 1, mesh, faceIds: [fid, fid], baseColors: new Float32Array(12), faceTriangles: new Map() } as unknown as BodyMesh;
}

function layerOf(bodies: BodyMesh[]) {
  const model = { bodies, edges: [] } as unknown as ModelView;
  const host: FinishHost = {
    model: () => model,
    scene: () => ({ renderer: { shadowMap: { enabled: true } } }) as never,
    faceIdToBodyId: (fid) => bodies.find((b) => b.faceIds.includes(fid))?.id ?? null,
    addToScene: () => {},
    requestRender: () => {},
    savedMats: () => new Map(),
  };
  return new BodyFinishLayer(host);
}

const base: FinishOverlays = { xray: false, stale: false, wireframe: false };
const flags = (l: BodyFinishLayer) => [l.bloomable, l.glows];

describe("BodyFinishLayer.glows", () => {
  it("is false for a plain model and for a shiny one, true once a face emits", () => {
    const a = quad("a", 0, 1.5);
    const b = quad("b", 1, 6.5);
    const l = layerOf([a, b]);
    l.apply(base);
    expect(flags(l)).toEqual([false, false]);
    l.bodyFinish = { a: { ...FINISH, metalness: 0.8, roughness: 0.15 }, b: { ...FINISH, clearcoat: 0.7 } };
    l.apply(base);
    expect(flags(l)).toEqual([true, false]);
    l.bodyFinish = { a: { ...FINISH, metalness: 0.8 }, b: { ...FINISH, emissive: 0.35 } };
    l.apply(base);
    expect(flags(l)).toEqual([true, true]);
  });

  it("counts a glow that casts no light, and a glowing face of a plain body", () => {
    const a = quad("a", 0, 1.5);
    const l = layerOf([a]);
    l.bodyFinish = { a: { ...FINISH, emissive: 0.6, castsLight: false } };
    l.apply(base);
    expect(flags(l)).toEqual([true, true]);
    l.bodyFinish = {};
    l.faceFinish = { 0: { ...FINISH, emissive: 0.25 } };
    l.apply(base);
    expect(l.glows).toBe(true);
  });

  it("drops back to false when the glow is switched off, and for a ghosted glowing body", () => {
    const a = quad("a", 0, 1.5);
    const l = layerOf([a]);
    l.bodyFinish = { a: { ...FINISH, emissive: 0.4 } };
    l.apply(base);
    expect(l.glows).toBe(true);
    l.apply({ ...base, xray: true });
    expect(l.glows).toBe(false);
    l.apply(base);
    expect(l.glows).toBe(true);
    l.bodyFinish = { a: { ...FINISH, emissive: 0 } };
    l.apply(base);
    expect(flags(l)).toEqual([false, false]);
  });
});

function post() {
  const renderer = {
    toneMapping: THREE.NeutralToneMapping,
    toneMappingExposure: 1,
    getPixelRatio: () => 1,
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 32),
  } as unknown as THREE.WebGLRenderer;
  return new PostChain(renderer, new THREE.Scene(), () => false, () => false);
}
const wanted = (p: PostChain) => (p as unknown as { wanted(): { bloom: boolean } }).wanted().bloom;

describe("PostChain composer rule", () => {
  it("runs the composer only with bloom above 0 and a glowing face", () => {
    const p = post();
    p.bloomable = true;
    const rows: [number, boolean, boolean][] = [
      [0, true, false], [0.05, true, true], [0.4, true, true], [0.83, true, true], [0.9, true, true], [1, true, true],
      [0.05, false, false], [0.4, false, false], [0.83, false, false], [0.9, false, false], [1, false, false],
      [0, false, false],
    ];
    const got = rows.map(([bloom, glows]) => {
      setRenderPref("bloom", bloom);
      p.glows = glows;
      return wanted(p);
    });
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
    expect(got).toEqual(rows.map((r) => r[2]));
  });

  it("does not let a shiny finish alone pull the composer in", () => {
    const p = post();
    p.bloomable = true;
    p.glows = false;
    setRenderPref("bloom", 0.9);
    const shinyOnly = wanted(p);
    p.glows = true;
    const glowing = wanted(p);
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
    expect([shinyOnly, glowing]).toEqual([false, true]);
  });
});
