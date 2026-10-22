// Procedural surfaces live in the Realtime fragment shader, which the tracer
// does not run, so each one is evaluated once at a few points per triangle and
// averaged into the mirror's vertex colours. The bump is dropped, roughness
// keeps its mean offset per slot. A CAD flat face has only four vertices, so a
// point sample at each vertex would alias; area weighted triangle samples give
// the face its average tint instead.

import * as THREE from "three";
import { surfaceBakeShader, type SurfaceBakeShader } from "../proceduralSurface";
import type { SurfaceBake, SurfaceBaker } from "./mirror";

/** World positions and normals in, 3 floats per sample; out `tint` as rgb plus
 *  amount (4 per sample) and `rough` as the roughness offset (1 per sample). */
export type SurfaceShade = (
  pos: Float32Array,
  nrm: Float32Array,
  count: number,
  shader: SurfaceBakeShader,
) => { tint: Float32Array; rough: Float32Array } | null;

/** Samples across all baked triangles of one body; past it a body keeps its
 *  plain colour. Four per triangle below a quarter of it, one above. */
export const SAMPLE_BUDGET = 4_000_000;

const BARY: [number, number, number][] = [
  [1 / 3, 1 / 3, 1 / 3],
  [2 / 3, 1 / 6, 1 / 6],
  [1 / 6, 2 / 3, 1 / 6],
  [1 / 6, 1 / 6, 2 / 3],
];

interface Slot {
  index: number;
  shader: SurfaceBakeShader;
  tris: number[];
}

export function createSurfaceBaker(shade: SurfaceShade): SurfaceBaker {
  const held = new WeakMap<THREE.BufferGeometry, { key: string; bake: SurfaceBake | null }>();
  return (src) => {
    const g = src.geometry;
    const slots = slotsOf(g, src.material);
    if (!slots.length) return null;
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const key = [pos.version, g.index?.version ?? -1, ...slots.map((s) => `${s.index}=${s.shader.key}`)].join("|");
    const had = held.get(g);
    if (had?.key === key) return had.bake;
    const bake = bakeBody(src, slots, shade);
    held.set(g, { key, bake });
    return bake;
  };
}

/** Groups pick a slot only under a material array, as three draws them. */
function slotsOf(g: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): Slot[] {
  const tris = (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  const mats = Array.isArray(material) ? material : [material];
  const ranges =
    Array.isArray(material) && g.groups.length ? g.groups : [{ start: 0, count: tris * 3, materialIndex: 0 }];
  const out = new Map<number, Slot>();
  for (const r of ranges) {
    const k = r.materialIndex ?? 0;
    const mat = mats[k];
    if (!mat) continue;
    let s = out.get(k);
    if (!s) {
      const shader = surfaceBakeShader(mat);
      if (!shader) continue;
      s = { index: k, shader, tris: [] };
      out.set(k, s);
    }
    const end = Math.min(r.start + r.count, tris * 3);
    for (let i = r.start; i + 2 < end; i += 3) s.tris.push(i / 3);
  }
  return [...out.values()];
}

function bakeBody(src: THREE.Mesh, slots: Slot[], shade: SurfaceShade): SurfaceBake | null {
  const g = src.geometry;
  const total = slots.reduce((n, s) => n + s.tris.length, 0);
  if (total > SAMPLE_BUDGET) {
    console.warn(`Path traced: ${total} surface triangles are past the bake budget, the plain colour is traced`);
    return null;
  }
  const k = total * BARY.length <= SAMPLE_BUDGET ? BARY.length : 1;
  const pos = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  const idx = g.index;
  const count = pos.count;
  src.updateWorldMatrix(true, false);
  const world = src.matrixWorld;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(world);
  const vtx = (t: number, c: number) => (idx ? idx.getX(t * 3 + c) : t * 3 + c);

  const slot = new Int16Array(count).fill(-1);
  const weight = new Float64Array(count);
  const amountSum = new Float64Array(count);
  const tintSum = new Float64Array(count * 3);
  const rough = new Map<number, number>();
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const n = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  for (const s of slots) {
    const m = s.tris.length * k;
    const ps = new Float32Array(m * 3);
    const ns = new Float32Array(m * 3);
    const area = new Float64Array(s.tris.length);
    s.tris.forEach((t, ti) => {
      for (let c = 0; c < 3; c++) {
        const v = vtx(t, c);
        p[c]!.fromBufferAttribute(pos, v).applyMatrix4(world);
        if (nrm) n[c]!.fromBufferAttribute(nrm, v).applyMatrix3(normalMatrix);
      }
      e1.subVectors(p[1]!, p[0]!);
      e2.subVectors(p[2]!, p[0]!);
      tmp.crossVectors(e1, e2);
      area[ti] = Math.max(tmp.length() / 2, 1e-12);
      if (!nrm) {
        n[0]!.copy(tmp).normalize();
        n[1]!.copy(n[0]!);
        n[2]!.copy(n[0]!);
      }
      for (let j = 0; j < k; j++) {
        const [a, b, c] = BARY[j]!;
        const o = (ti * k + j) * 3;
        tmp.set(0, 0, 0).addScaledVector(p[0]!, a).addScaledVector(p[1]!, b).addScaledVector(p[2]!, c);
        ps[o] = tmp.x;
        ps[o + 1] = tmp.y;
        ps[o + 2] = tmp.z;
        tmp.set(0, 0, 0).addScaledVector(n[0]!, a).addScaledVector(n[1]!, b).addScaledVector(n[2]!, c).normalize();
        ns[o] = tmp.x;
        ns[o + 1] = tmp.y;
        ns[o + 2] = tmp.z;
      }
    });
    const out = shade(ps, ns, m, s.shader);
    if (!out) return null;
    let roughSum = 0;
    let areaSum = 0;
    s.tris.forEach((t, ti) => {
      let am = 0,
        r = 0,
        tr = 0,
        tg = 0,
        tb = 0;
      for (let j = 0; j < k; j++) {
        const q = ti * k + j;
        const a = out.tint[q * 4 + 3]!;
        am += a;
        tr += a * out.tint[q * 4]!;
        tg += a * out.tint[q * 4 + 1]!;
        tb += a * out.tint[q * 4 + 2]!;
        r += out.rough[q]!;
      }
      const w = area[ti]!;
      roughSum += (r / k) * w;
      areaSum += w;
      for (let c = 0; c < 3; c++) {
        const v = vtx(t, c);
        slot[v] = s.index;
        weight[v] = weight[v]! + w;
        amountSum[v] = amountSum[v]! + (w * am) / k;
        tintSum[v * 3] = tintSum[v * 3]! + (w * tr) / k;
        tintSum[v * 3 + 1] = tintSum[v * 3 + 1]! + (w * tg) / k;
        tintSum[v * 3 + 2] = tintSum[v * 3 + 2]! + (w * tb) / k;
      }
    });
    rough.set(s.index, areaSum > 0 ? roughSum / areaSum : 0);
  }

  const tint = new Float32Array(count * 3);
  const amount = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    if (slot[v]! < 0 || weight[v]! <= 0) continue;
    const a = amountSum[v]!;
    amount[v] = Math.min(1, Math.max(0, a / weight[v]!));
    if (a > 0) for (let c = 0; c < 3; c++) tint[v * 3 + c] = tintSum[v * 3 + c]! / a;
  }
  return { slot, tint, amount, rough };
}

const VERTEX = /* glsl */ `
void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function fragment(glsl: string): string {
  return /* glsl */ `
#include <common>
uniform sampler2D uSurfBakePos;
uniform sampler2D uSurfBakeNrm;
uniform int uSurfBakeW;
// A fresnel node is view dependent; the bake sees every point head on.
#define cameraPosition (wp + wn)
${glsl}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool second = p.x >= uSurfBakeW;
  ivec2 q = ivec2(second ? p.x - uSurfBakeW : p.x, p.y);
  vec3 wp = texelFetch(uSurfBakePos, q, 0).xyz;
  vec3 wn = normalize(texelFetch(uSurfBakeNrm, q, 0).xyz);
  SurfOut o = surfBake(wp, wn);
  gl_FragColor = second ? vec4(o.roughAmt * (o.rough - 0.5), 0.0, 0.0, 1.0) : vec4(o.tint, o.tintAmt);
}
`;
}

function sampleTexture(data: Float32Array, count: number, w: number, h: number): THREE.DataTexture {
  const rgba = new Float32Array(w * h * 4);
  for (let i = 0; i < count; i++) {
    rgba[i * 4] = data[i * 3]!;
    rgba[i * 4 + 1] = data[i * 3 + 1]!;
    rgba[i * 4 + 2] = data[i * 3 + 2]!;
  }
  const t = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

/** One pass per slot on the viewport's WebGL renderer: the left half of the
 *  target holds tint and amount, the right half the roughness offset. */
export function webglSurfaceShade(renderer: THREE.WebGLRenderer): SurfaceShade {
  return (pos, nrm, count, shader) => {
    const maxTex = renderer.capabilities.maxTextureSize || 4096;
    const w = Math.max(1, Math.min(count, 2048, Math.floor(maxTex / 2)));
    const h = Math.ceil(count / w);
    if (h > maxTex) return null;
    const posTex = sampleTexture(pos, count, w, h);
    const nrmTex = sampleTexture(nrm, count, w, h);
    const target = new THREE.WebGLRenderTarget(w * 2, h, { type: THREE.FloatType, depthBuffer: false });
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: fragment(shader.glsl),
      uniforms: {
        ...shader.uniforms,
        uSurfBakePos: { value: posTex },
        uSurfBakeNrm: { value: nrmTex },
        uSurfBakeW: { value: w },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    const was = {
      target: renderer.getRenderTarget(),
      toneMapping: renderer.toneMapping,
      autoClear: renderer.autoClear,
    };
    const pixels = new Float32Array(w * 2 * h * 4);
    try {
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.autoClear = true;
      renderer.setRenderTarget(target);
      renderer.render(scene, new THREE.Camera());
      renderer.readRenderTargetPixels(target, 0, 0, w * 2, h, pixels);
    } finally {
      renderer.setRenderTarget(was.target);
      renderer.toneMapping = was.toneMapping;
      renderer.autoClear = was.autoClear;
      target.dispose();
      posTex.dispose();
      nrmTex.dispose();
      quad.geometry.dispose();
      material.dispose();
    }
    const tint = new Float32Array(count * 4);
    const rough = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / w);
      const col = i - row * w;
      const left = (row * w * 2 + col) * 4;
      tint.set(pixels.subarray(left, left + 4), i * 4);
      rough[i] = pixels[(row * w * 2 + w + col) * 4]!;
    }
    return { tint, rough };
  };
}
