// One onBeforeCompile and one customProgramCacheKey per body material, shared by
// every patch that edits the physical shader (procedural surface, auto glass
// thickness, ...). Patches apply in a fixed rank order, so the order they are set
// in never changes the source or the program key.
//
// three keeps one program per key per material and runs onBeforeCompile only the
// first time the material meets a key; every later frame, whatever key it is on,
// uploads from the uniforms object of the last such compile. So a patch's uniform
// objects stay the same for the material's life (a new value is copied into them),
// and every compile binds every uniform object the material ever held.

import * as THREE from "three";

/** Fragment includes a patch edits, in the order they are edited. `common` is the
 *  fragment's own, the vertex side is reached only through `varyings`. */
export type Point = "common" | "color_fragment" | "roughnessmap_fragment" | "normal_fragment_begin"
  | "transmission_pars_fragment" | "transmission_fragment" | "aomap_fragment" | "lights_fragment_maps";
const POINTS: readonly Point[] = [
  "common", "color_fragment", "roughnessmap_fragment", "normal_fragment_begin",
  "transmission_pars_fragment", "transmission_fragment", "aomap_fragment", "lights_fragment_maps",
];

// Patches not listed here go after these, by name.
const RANK = ["surface", "glassAuto"];

const VARYINGS = {
  surfWorld: {
    decl: ["varying vec3 vSurfWPos;", "varying vec3 vSurfWNorm;"],
    assign: [
      "  vSurfWPos = (modelMatrix * vec4(position, 1.0)).xyz;",
      "  vSurfWNorm = normalize(mat3(modelMatrix) * normal);",
    ],
  },
};
export type Varying = keyof typeof VARYINGS;

export interface ShaderPatch {
  name: string;
  /** This patch's part of the program key. It changes exactly when the GLSL does. */
  key: string;
  varyings?: Varying[];
  after?: Partial<Record<Point, string>>;
  /** At most one patch per point. */
  replace?: Partial<Record<Point, string>>;
  /** This material's own uniforms. */
  uniforms?: Record<string, THREE.IUniform>;
  /** Uniform objects shared with other materials, bound as they are. */
  shared?: Record<string, THREE.IUniform>;
}

interface Stack {
  patches: ShaderPatch[];
  held: Record<string, THREE.IUniform>;
  key: string;
}

const stacks = new WeakMap<THREE.Material, Stack>();
const STOCK_KEY = THREE.Material.prototype.onBeforeCompile.toString();

function rank(name: string): number {
  const i = RANK.indexOf(name);
  return i < 0 ? RANK.length : i;
}

function byRank(a: ShaderPatch, b: ShaderPatch): number {
  return rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function copyValue(into: THREE.IUniform, from: unknown): void {
  const cur = into.value as { copy?: (v: unknown) => unknown; constructor?: unknown } | null;
  const isTex = cur instanceof THREE.Texture || from instanceof THREE.Texture;
  if (!isTex && cur && typeof cur.copy === "function" && from && (from as object).constructor === cur.constructor) cur.copy(from);
  else into.value = from;
}

function include(s: string, inc: string, text: string): string {
  // A function replacer, a string one expands `$&` and friends.
  return s.replace(`#include <${inc}>`, () => text);
}

function compile(st: Stack, shader: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, st.held);
  const ps = st.patches;
  if (!ps.length) return;
  const varyings = [...new Set(ps.flatMap((p) => p.varyings ?? []))].map((v) => VARYINGS[v]);
  if (varyings.length) {
    const decl = varyings.flatMap((v) => v.decl);
    shader.vertexShader = include(shader.vertexShader, "common", "#include <common>" + decl.map((d) => "\n" + d).join(""));
    shader.vertexShader = include(shader.vertexShader, "worldpos_vertex",
      "#include <worldpos_vertex>" + varyings.flatMap((v) => v.assign).map((a) => "\n" + a).join(""));
  }
  let fs = shader.fragmentShader;
  for (const pt of POINTS) {
    const head = ps.find((p) => p.replace?.[pt] !== undefined)?.replace![pt];
    let tail = ps.flatMap((p) => p.after?.[pt] ?? []);
    if (pt === "common" && varyings.length) {
      const decl = "\n" + varyings.flatMap((v) => v.decl).join("\n") + "\n";
      tail = tail.length ? [decl + tail[0], ...tail.slice(1)] : [decl];
    }
    if (head === undefined && !tail.length) continue;
    fs = include(fs, pt, (head ?? `#include <${pt}>`) + tail.map((t) => "\n" + t).join(""));
  }
  shader.fragmentShader = fs;
}

function stackOf(mat: THREE.Material): Stack {
  let st = stacks.get(mat);
  if (!st) {
    const s: Stack = { patches: [], held: {}, key: STOCK_KEY };
    st = s;
    stacks.set(mat, s);
    mat.onBeforeCompile = (shader) => compile(s, shader);
    mat.customProgramCacheKey = () => s.key;
  }
  return st;
}

function rekey(mat: THREE.Material, st: Stack): void {
  st.patches.sort(byRank);
  const key = st.patches.length ? st.patches.map((p) => p.key).join("|") : STOCK_KEY;
  if (key === st.key) return;
  st.key = key;
  mat.needsUpdate = true;
}

/** Add `patch`, or replace the one of its name. Returns it as stored, its
 *  uniforms being the material's lasting objects with the new values in them. */
export function setPatch(mat: THREE.Material, patch: ShaderPatch): ShaderPatch & { uniforms: Record<string, THREE.IUniform> } {
  const st = stackOf(mat);
  for (const pt of Object.keys(patch.replace ?? {}) as Point[]) {
    const other = st.patches.find((p) => p.name !== patch.name && p.replace?.[pt] !== undefined);
    if (other) throw new Error(`shader patch ${patch.name} replaces ${pt}, which ${other.name} already replaces`);
  }
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const [n, u] of Object.entries(patch.uniforms ?? {})) {
    const held = st.held[n];
    if (held && held !== u) copyValue(held, u.value);
    else st.held[n] = u;
    uniforms[n] = st.held[n]!;
  }
  Object.assign(st.held, patch.shared);
  const stored = { ...patch, uniforms };
  st.patches = [...st.patches.filter((p) => p.name !== patch.name), stored];
  rekey(mat, st);
  return stored;
}

export function getPatch(mat: THREE.Material, name: string): ShaderPatch | undefined {
  return stacks.get(mat)?.patches.find((p) => p.name === name);
}

/** The material keeps its hook after its last patch goes, with the stock key and
 *  source, so a compile on the stock key still binds the uniforms a key it
 *  returns to later needs. */
export function removePatch(mat: THREE.Material, name: string): void {
  const st = stacks.get(mat);
  if (!st || !st.patches.some((p) => p.name === name)) return;
  st.patches = st.patches.filter((p) => p.name !== name);
  rekey(mat, st);
}

export function clearPatches(mat: THREE.Material): void {
  const st = stacks.get(mat);
  if (!st) return;
  st.patches = [];
  rekey(mat, st);
}

/** Material.clone copies none of this. Gives `clone` the patches of `mat` that
 *  `keep` accepts, each with its own copy of the per material uniforms. */
export function copyPatches(mat: THREE.Material, clone: THREE.Material, keep: (p: ShaderPatch) => boolean): void {
  for (const p of stacks.get(mat)?.patches ?? []) {
    if (!keep(p)) continue;
    const uniforms: Record<string, THREE.IUniform> = {};
    for (const [n, u] of Object.entries(p.uniforms ?? {})) {
      const v = u.value as { clone?: () => unknown } | null;
      uniforms[n] = { value: v && !(v instanceof THREE.Texture) && typeof v.clone === "function" ? v.clone() : v };
    }
    setPatch(clone, { ...p, uniforms });
  }
}
