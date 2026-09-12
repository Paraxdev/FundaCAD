// Procedural surface detail on a body's material: noise, scratches, brushed
// streaks, cellular wear, computed in the fragment shader and driving roughness,
// a bump (perturbed normal) and a colour tint. No texture, no UVs, everything is
// sampled TRIPLANAR in world space, because a CAD tessellation carries positions
// and normals but no texture coordinates to hang a map on.
//
// Injected with onBeforeCompile rather than a whole custom material, so the body
// keeps the physical PBR shader (metalness, clearcoat, the lights, the
// environment) and this only edits roughness, normal and colour on the way
// through. Off (spec null) leaves the shader byte-identical to the stock one.
//
// This is the engine the eventual node editor compiles TO: each generator here
// is one node's worth of GLSL, and a graph will assemble these into the same
// three outputs. For now a material carries ONE generator with a few knobs.

import * as THREE from "three";
import type { SurfaceSpec } from "../document/materials";

const SURF_KIND: Record<SurfaceSpec["kind"], number> = {
  noise: 0, scratches: 1, brushed: 2, voronoi: 3,
};

/** Serialise a spec for change detection (finishes are compared by value). */
export function surfaceKey(s: SurfaceSpec | undefined): string {
  if (!s) return "";
  return [s.kind, s.scale, s.amount, s.angle ?? 0, s.bump ?? 0, s.color ?? "", s.colorAmount ?? 0].join("|");
}

// --- GLSL --------------------------------------------------------------------
// Value noise + fbm, a triplanar height per generator, then the three outputs.
// Kept small: this runs per fragment on every body wearing a procedural finish.
const GLSL_COMMON = /* glsl */`
uniform int   uSurfKind;
uniform float uSurfScale;
uniform float uSurfAmount;
uniform float uSurfAngle;
uniform float uSurfBump;
uniform vec3  uSurfColor;
uniform float uSurfColorAmt;
varying vec3 vSurfWPos;
varying vec3 vSurfWNorm;

float sHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sNoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  float n000 = sHash(i + vec3(0.,0.,0.)), n100 = sHash(i + vec3(1.,0.,0.));
  float n010 = sHash(i + vec3(0.,1.,0.)), n110 = sHash(i + vec3(1.,1.,0.));
  float n001 = sHash(i + vec3(0.,0.,1.)), n101 = sHash(i + vec3(1.,0.,1.));
  float n011 = sHash(i + vec3(0.,1.,1.)), n111 = sHash(i + vec3(1.,1.,1.));
  return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
             mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
}
float sFbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * sNoise(p); p *= 2.03; a *= 0.5; } return s; }

// scratches/brushed: parallel streaks in a 2D coord, rotated by the angle. Dense
// and faint for brushed, sparse and sharp for scratches.
float sStreaks(vec2 uv, float freq, float sharp){
  float c = cos(uSurfAngle), s = sin(uSurfAngle);
  vec2 r = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
  float jitter = sNoise(vec3(r.x * freq * 0.2, 0.0, 0.0)) * 2.0;
  float line = abs(fract(r.y * freq + jitter) - 0.5) * 2.0;
  return pow(1.0 - line, sharp);
}
float sVoronoi(vec3 p){
  vec3 g = floor(p), f = fract(p); float d = 1.0;
  for (int z=-1; z<=1; z++) for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++){
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + vec3(sHash(g+o), sHash(g+o+7.0), sHash(g+o+13.0)) - f;
    d = min(d, dot(r, r));
  }
  return clamp(sqrt(d), 0.0, 1.0);
}

// One height in [0,1] for the current generator at a world point, sampled
// triplanar so it reads the same on every face.
float sHeight(vec3 wp, vec3 wn){
  vec3 p = wp / max(uSurfScale, 0.001);
  vec3 w = normalize(abs(wn) + 1e-4); w /= (w.x + w.y + w.z);
  if (uSurfKind == 0) return sFbm(p);
  if (uSurfKind == 3) return sVoronoi(p);
  // streaks, blended across the three axis planes
  float freq = 6.0, sharp = uSurfKind == 1 ? 40.0 : 3.0;
  float sx = sStreaks(p.yz, freq, sharp), sy = sStreaks(p.zx, freq, sharp), sz = sStreaks(p.xy, freq, sharp);
  float v = sx * w.x + sy * w.y + sz * w.z;
  if (uSurfKind == 1){ v = smoothstep(0.965, 1.0, v); } // sparse, sharp scratches
  return v;
}
`;

/** Apply (or clear) a procedural surface on a material. Physical or Standard,
 *  either works, the injection only touches roughness/normal/colour. Clearing
 *  restores the stock shader. Recompiles only when the presence flips. */
export function applySurface(mat: THREE.Material, spec: SurfaceSpec | undefined): void {
  const m = mat as THREE.MeshStandardMaterial & {
    userData: { surfKey?: string; surfUniforms?: Record<string, THREE.IUniform> };
  };
  const key = surfaceKey(spec);
  const had = !!m.userData.surfKey;
  if (m.userData.surfKey === key) {
    // Same shape of shader: just refresh the numbers, no recompile.
    if (spec && m.userData.surfUniforms) writeUniforms(m.userData.surfUniforms, spec);
    return;
  }
  m.userData.surfKey = key;

  if (!spec) {
    m.onBeforeCompile = () => {};
    delete m.userData.surfUniforms;
    if (had) m.needsUpdate = true;
    return;
  }

  const uniforms: Record<string, THREE.IUniform> = {
    uSurfKind: { value: SURF_KIND[spec.kind] },
    uSurfScale: { value: spec.scale },
    uSurfAmount: { value: spec.amount },
    uSurfAngle: { value: spec.angle ?? 0 },
    uSurfBump: { value: spec.bump ?? 0 },
    uSurfColor: { value: new THREE.Color(spec.color ?? "#000000") },
    uSurfColorAmt: { value: spec.colorAmount ?? 0 },
  };
  writeUniforms(uniforms, spec);
  m.userData.surfUniforms = uniforms;

  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // vertex: carry world position + world normal to the fragment
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSurfWPos;\nvarying vec3 vSurfWNorm;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\n  vSurfWPos = (modelMatrix * vec4(position, 1.0)).xyz;\n  vSurfWNorm = normalize(mat3(modelMatrix) * normal);",
      );
    // fragment: the generators, then edit colour, roughness and the normal
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + GLSL_COMMON)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n  float sH = sHeight(vSurfWPos, vSurfWNorm);\n  diffuseColor.rgb = mix(diffuseColor.rgb, uSurfColor, uSurfColorAmt * sH);",
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + uSurfAmount * (sHeight(vSurfWPos, vSurfWNorm) - 0.5), 0.04, 1.0);",
      )
      .replace(
        "#include <normal_fragment_begin>",
        "#include <normal_fragment_begin>\n" + BUMP_GLSL,
      );
  };
  m.needsUpdate = true;
}

// Perturb the (view-space) normal from the height gradient, sampled along two
// world tangents of the surface normal and transformed back into view space.
const BUMP_GLSL = /* glsl */`
  if (uSurfBump > 0.0001) {
    vec3 wn = normalize(vSurfWNorm);
    vec3 t = normalize(cross(wn, abs(wn.y) < 0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));
    vec3 b = cross(wn, t);
    float e = uSurfScale * 0.04 + 0.001;
    float h0 = sHeight(vSurfWPos, wn);
    float ht = sHeight(vSurfWPos + t * e, wn);
    float hb = sHeight(vSurfWPos + b * e, wn);
    vec3 wPert = normalize(wn - uSurfBump * ((ht - h0) * t + (hb - h0) * b) / e);
    normal = normalize((viewMatrix * vec4(wPert, 0.0)).xyz);
  }
`;

function writeUniforms(u: Record<string, THREE.IUniform>, spec: SurfaceSpec): void {
  u["uSurfKind"]!.value = SURF_KIND[spec.kind];
  u["uSurfScale"]!.value = spec.scale;
  u["uSurfAmount"]!.value = spec.amount;
  u["uSurfAngle"]!.value = spec.angle ?? 0;
  u["uSurfBump"]!.value = spec.bump ?? 0;
  (u["uSurfColor"]!.value as THREE.Color).set(spec.color ?? "#000000");
  u["uSurfColorAmt"]!.value = spec.colorAmount ?? 0;
}
