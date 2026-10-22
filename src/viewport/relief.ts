// The same spec runs here, in the GLSL below and in the tracer, checked against tests/fixtures/relief_profile.json.
// Past about half a ridge per pixel the tilt, seam and colour fade to their means and the slope moves into roughness.

import * as THREE from "three";
import type { Relief, ReliefMap } from "../plugins/contrib";
import type { ShaderPatch } from "./shaderPatches";

export type { Relief };

export const RELIEF = {
  /** Bead parameter clamp, keeps the edge slope finite. */
  uClamp: 0.97,
  /** Bead slope per unit of depth. */
  depthScale: 2,
  /** Footprint in ridges per pixel where the fade starts and ends. */
  fadeLo: 0.35,
  fadeHi: 0.8,
  /** Half width of the seam shading, in ridges. */
  seamWidth: 0.15,
  /** Mean of the seam bump over a ridge, what it fades to. */
  seamMean: (2 * 0.15) / 3,
  varSamples: 256,
  /** The tilt is about one axis, so half the variance lands on each slope axis. */
  varAxis: 0.5,
} as const;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Fraction of a ridge taken by the flat step. */
export function reliefTread(c: number): number {
  const a = Math.abs(c);
  return a / (a + Math.sqrt(Math.max(0, 1 - c * c)));
}

export function reliefFade(w: number): number {
  return 1 - smoothstep(RELIEF.fadeLo, RELIEF.fadeHi, w);
}

export function reliefSeam(f: number): number {
  const d = Math.min(f, 1 - f);
  return Math.max(0, 1 - d / RELIEF.seamWidth) ** 2;
}

function bead(fb: number, depth: number): number {
  const u = Math.min(Math.max(2 * fb - 1, -RELIEF.uClamp), RELIEF.uClamp);
  return Math.atan((RELIEF.depthScale * depth * u) / Math.sqrt(1 - u * u));
}

/** Signed tilt of the normal toward t, in radians. */
export function reliefTilt(f: number, c: number, depth: number, w: number): number {
  const tr = reliefTread(c);
  const top = c >= 0 ? f >= 1 - tr : f < tr;
  const t0 = top
    ? (c >= 0 ? 1 : -1) * Math.acos(Math.min(Math.abs(c), 1))
    : bead((c >= 0 ? f : f - tr) / Math.max(1 - tr, 1e-4), depth);
  return reliefFade(w) * t0;
}

/** Mean squared sine of the bead tilt over a ridge, per slope axis. */
export function reliefVariance(depth: number): number {
  const n = RELIEF.varSamples;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.sin(bead((i + 0.5) / n, depth)) ** 2;
  return (RELIEF.varAxis * s) / n;
}

export function reliefSigma2(c: number, depth: number): number {
  return reliefVariance(depth) * (1 - reliefTread(c));
}

export function reliefRoughness(r: number, c: number, depth: number, w: number): number {
  return Math.sqrt(r * r + (1 - reliefFade(w)) * reliefSigma2(c, depth));
}

/** Integer hash of the ridge index, in [0, 1). */
export function reliefHash(k: number): number {
  let x = (k | 0) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return Math.fround(x) / 4294967296;
}

export function reliefAlbedo(f: number, k: number, c: number, w: number, tint: number, cavity: number): number {
  const fd = reliefFade(w);
  const wall = Math.sqrt(Math.max(0, 1 - c * c));
  return (
    (1 + tint * (reliefHash(k) - 0.5) * fd) * (1 - cavity * wall * (fd * reliefSeam(f) + (1 - fd) * RELIEF.seamMean))
  );
}

export function glslFloat(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

const F = (k: keyof typeof RELIEF) => glslFloat(RELIEF[k]);

export const RELIEF_GLSL = {
  common: /* glsl */ `
uniform float uReliefOn;
uniform vec3 uReliefAxis;
uniform float uReliefOrigin;
uniform float uReliefPitch;
uniform float uReliefDepth;
uniform float uReliefTint;
uniform float uReliefCavity;
uniform float uReliefVar;
struct ReliefOut { float tilt; float sigma2; float albedo; vec3 t; };
float reliefHash(float k) {
  uint x = uint(int(k));
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return float(x) / 4294967296.0;
}
ReliefOut reliefEval(vec3 p, vec3 n) {
  ReliefOut r;
  float s = (dot(p, uReliefAxis) - uReliefOrigin) / uReliefPitch;
  float fd = 1.0 - smoothstep(${F("fadeLo")}, ${F("fadeHi")}, fwidth(s));
  float k = floor(s);
  float f = s - k;
  float c = clamp(dot(n, uReliefAxis), -1.0, 1.0);
  vec3 tp = uReliefAxis - n * c;
  float tl = length(tp);
  r.t = tl > 1e-5 ? tp / tl : vec3(0.0);
  float ac = abs(c);
  float wall = sqrt(max(0.0, 1.0 - c * c));
  float tr = ac / max(ac + wall, 1e-6);
  bool top = c >= 0.0 ? f >= 1.0 - tr : f < tr;
  float t0;
  if (top) {
    t0 = (c >= 0.0 ? 1.0 : -1.0) * acos(min(ac, 1.0));
  } else {
    float fb = (c >= 0.0 ? f : f - tr) / max(1.0 - tr, 1e-4);
    float u = clamp(2.0 * fb - 1.0, -${F("uClamp")}, ${F("uClamp")});
    t0 = atan(${F("depthScale")} * uReliefDepth * u / sqrt(1.0 - u * u));
  }
  r.tilt = uReliefOn * fd * t0;
  r.sigma2 = uReliefOn * (1.0 - fd) * uReliefVar * (1.0 - tr);
  float d = min(f, 1.0 - f);
  float g = pow(max(0.0, 1.0 - d / ${F("seamWidth")}), 2.0);
  float a = (1.0 + uReliefTint * (reliefHash(k) - 0.5) * fd)
    * (1.0 - uReliefCavity * wall * (fd * g + (1.0 - fd) * ${F("seamMean")}));
  r.albedo = mix(1.0, a, uReliefOn);
  return r;
}`,
  color_fragment: /* glsl */ `
vec3 reliefN = (gl_FrontFacing ? 1.0 : -1.0) * normalize(vSurfWNorm);
ReliefOut relief = reliefEval(vSurfWPos, reliefN);
diffuseColor.rgb *= relief.albedo;`,
  roughnessmap_fragment: /* glsl */ `
roughnessFactor = sqrt(roughnessFactor * roughnessFactor + relief.sigma2);`,
  // Moves the incoming normal by the tilt, so a bump an earlier patch put on it
  // stays; nonPerturbedNormal stays smooth for a clear coat.
  normal_fragment_begin: /* glsl */ `
{
  vec3 rwN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 rmN = cos(relief.tilt) * reliefN + sin(relief.tilt) * relief.t;
  normal = normalize((viewMatrix * vec4(normalize(rwN + rmN - reliefN), 0.0)).xyz);
}`,
};

export type ReliefUniforms = {
  uReliefOn: THREE.IUniform<number>;
  uReliefAxis: THREE.IUniform<THREE.Vector3>;
  uReliefOrigin: THREE.IUniform<number>;
  uReliefPitch: THREE.IUniform<number>;
  uReliefDepth: THREE.IUniform<number>;
  uReliefTint: THREE.IUniform<number>;
  uReliefCavity: THREE.IUniform<number>;
  uReliefVar: THREE.IUniform<number>;
};

export function reliefUniforms(): ReliefUniforms {
  return {
    uReliefOn: { value: 0 },
    uReliefAxis: { value: new THREE.Vector3(0, 0, 1) },
    uReliefOrigin: { value: 0 },
    uReliefPitch: { value: 1 },
    uReliefDepth: { value: 0 },
    uReliefTint: { value: 0 },
    uReliefCavity: { value: 0 },
    uReliefVar: { value: 0 },
  };
}

/** The axis as a unit vector, or null when it has no direction. */
export function reliefAxis(r: Relief): THREE.Vector3 | null {
  const v = new THREE.Vector3(r.axis[0], r.axis[1], r.axis[2]);
  const l = v.length();
  return Number.isFinite(l) && l > 1e-9 ? v.divideScalar(l) : null;
}

/** Writes `r` into `u` in place: the program holds these objects, never new ones. */
export function writeRelief(u: ReliefUniforms, r: Relief, axis: THREE.Vector3, origin: number): void {
  const depth = Math.min(Math.max(r.depth, 0), 1);
  u.uReliefOn.value = 1;
  u.uReliefAxis.value.copy(axis);
  u.uReliefOrigin.value = origin;
  u.uReliefPitch.value = Math.max(r.pitch, 1e-4);
  u.uReliefDepth.value = depth;
  u.uReliefTint.value = Math.min(Math.max(r.tintJitter ?? 0, 0), 1);
  u.uReliefCavity.value = Math.min(Math.max(r.cavity ?? 0, 0), 1);
  u.uReliefVar.value = reliefVariance(depth);
}

/** Lowest point of the mesh along `axis`, in world space. */
export function reliefOrigin(mesh: THREE.Mesh, axis: THREE.Vector3): number {
  const pos = mesh.geometry.getAttribute("position");
  if (!pos || pos.count === 0) return 0;
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements;
  // dot(M p, a) = p . (M^T a) + dot(translation, a)
  const ax = e[0]! * axis.x + e[1]! * axis.y + e[2]! * axis.z;
  const ay = e[4]! * axis.x + e[5]! * axis.y + e[6]! * axis.z;
  const az = e[8]! * axis.x + e[9]! * axis.y + e[10]! * axis.z;
  const d = e[12]! * axis.x + e[13]! * axis.y + e[14]! * axis.z;
  let lo = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const v = pos.getX(i) * ax + pos.getY(i) * ay + pos.getZ(i) * az;
    if (v < lo) lo = v;
  }
  return lo + d;
}

export function sameRelief(a: ReliefMap, b: ReliefMap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const RELIEF_PATCH = "relief";

export function reliefPatch(shared: ReliefUniforms): ShaderPatch {
  return {
    name: RELIEF_PATCH,
    key: "relief1",
    varyings: ["surfWorld"],
    after: {
      common: RELIEF_GLSL.common,
      color_fragment: RELIEF_GLSL.color_fragment,
      roughnessmap_fragment: RELIEF_GLSL.roughnessmap_fragment,
      normal_fragment_begin: RELIEF_GLSL.normal_fragment_begin,
    },
    shared: shared as unknown as Record<string, THREE.IUniform>,
  };
}
