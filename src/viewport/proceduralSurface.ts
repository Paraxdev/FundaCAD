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
// TWO ways in. `applySurface` takes ONE generator with live uniforms (the
// material-editor picker, so a slider drag does not recompile). `applySurfaceGraph`
// takes a NODE GRAPH, compiles it to GLSL with the params baked in (the node
// editor), and recompiles when the graph changes. Both share the generator
// functions below, so a graph's generator node and the picker draw the same
// pattern.

import * as THREE from "three";
import type { SurfaceGraph, SurfaceNode, SurfaceSpec } from "../document/materials";

const SURF_KIND: Record<SurfaceSpec["kind"], number> = {
  noise: 0, scratches: 1, brushed: 2, voronoi: 3,
};

export function surfaceKey(s: SurfaceSpec | undefined): string {
  if (!s) return "";
  return "s:" + [s.kind, s.scale, s.amount, s.angle ?? 0, s.bump ?? 0, s.color ?? "", s.colorAmount ?? 0].join("|");
}

export function graphKey(g: SurfaceGraph | undefined): string {
  // Only the parts that reach the shader: node layout (x/y) is deliberately left
  // out, so dragging a node in the editor never recompiles the material.
  if (!g) return "";
  const nodes = g.nodes.map((n) => ({ id: n.id, type: n.type, params: n.params, in: n.in }));
  return "g:" + JSON.stringify({ output: g.output, nodes });
}

// --- shared GLSL: the generator functions, parameterised so the picker (via
// uniforms) and the graph (via baked literals) both call the same code. -------
const SURF_FUNCS = /* glsl */`
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
float sStreaks(vec2 uv, float freq, float sharp, float angle){
  float c = cos(angle), s = sin(angle);
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
// One height in [0,1] for a generator of the given kind at a world point, triplanar.
float sGen(vec3 wp, vec3 wn, int kind, float scale, float angle){
  vec3 p = wp / max(scale, 0.001);
  vec3 w = normalize(abs(wn) + 1e-4); w /= (w.x + w.y + w.z);
  if (kind == 0) return sFbm(p);
  if (kind == 3) return sVoronoi(p);
  float freq = 6.0, sharp = kind == 1 ? 40.0 : 3.0;
  float sx = sStreaks(p.yz, freq, sharp, angle), sy = sStreaks(p.zx, freq, sharp, angle), sz = sStreaks(p.xy, freq, sharp, angle);
  float v = sx * w.x + sy * w.y + sz * w.z;
  if (kind == 1){ v = smoothstep(0.965, 1.0, v); }
  return v;
}
`;

// Carry world position + world normal to the fragment. Shared by both paths.
function injectVarying(vertexShader: string): string {
  return vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vSurfWPos;\nvarying vec3 vSurfWNorm;")
    .replace(
      "#include <worldpos_vertex>",
      "#include <worldpos_vertex>\n  vSurfWPos = (modelMatrix * vec4(position, 1.0)).xyz;\n  vSurfWNorm = normalize(mat3(modelMatrix) * normal);",
    );
}

type Physical = THREE.MeshStandardMaterial & {
  userData: { surfKey?: string; surfUniforms?: Record<string, THREE.IUniform> };
};

// --- the picker path: one generator, live uniforms --------------------------
export function applySurface(mat: THREE.Material, spec: SurfaceSpec | undefined): void {
  const m = mat as Physical;
  const key = surfaceKey(spec);
  const had = !!m.userData.surfKey;
  if (m.userData.surfKey === key) {
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
    uSurfKind: { value: SURF_KIND[spec.kind] }, uSurfScale: { value: spec.scale },
    uSurfAmount: { value: spec.amount }, uSurfAngle: { value: spec.angle ?? 0 },
    uSurfBump: { value: spec.bump ?? 0 }, uSurfColor: { value: new THREE.Color(spec.color ?? "#000000") },
    uSurfColorAmt: { value: spec.colorAmount ?? 0 },
  };
  writeUniforms(uniforms, spec);
  m.userData.surfUniforms = uniforms;
  const UNIFORMS = /* glsl */`
uniform int uSurfKind; uniform float uSurfScale; uniform float uSurfAmount; uniform float uSurfAngle;
uniform float uSurfBump; uniform vec3 uSurfColor; uniform float uSurfColorAmt;
float sPickHeight(vec3 wp, vec3 wn){ return sGen(wp, wn, uSurfKind, uSurfScale, uSurfAngle); }
`;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectVarying(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + SURF_FUNCS + UNIFORMS)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n  float sH = sPickHeight(vSurfWPos, vSurfWNorm);\n  diffuseColor.rgb = mix(diffuseColor.rgb, uSurfColor, uSurfColorAmt * sH);",
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + uSurfAmount * (sPickHeight(vSurfWPos, vSurfWNorm) - 0.5), 0.04, 1.0);",
      )
      .replace(
        "#include <normal_fragment_begin>",
        "#include <normal_fragment_begin>\n" + bumpGLSL("sPickHeight(P, wn)", "uSurfBump"),
      );
  };
  m.needsUpdate = true;
}

// --- the graph path: compile the node graph, bake the params ----------------
export function applySurfaceGraph(mat: THREE.Material, graph: SurfaceGraph | undefined): void {
  const m = mat as Physical;
  const key = graphKey(graph);
  const had = !!m.userData.surfKey;
  if (m.userData.surfKey === key) return;
  m.userData.surfKey = key;
  delete m.userData.surfUniforms;
  if (!graph) {
    m.onBeforeCompile = () => {};
    if (had) m.needsUpdate = true;
    return;
  }
  const compiled = compileGraph(graph);
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = injectVarying(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + SURF_FUNCS + STRUCT_GLSL + compiled)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n  SurfOut sO = sGraph(vSurfWPos, vSurfWNorm);\n  diffuseColor.rgb = mix(diffuseColor.rgb, sO.tint, sO.tintAmt);",
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + sO.roughAmt * (sO.rough - 0.5), 0.04, 1.0);",
      )
      .replace(
        "#include <normal_fragment_begin>",
        "#include <normal_fragment_begin>\n" + bumpGLSL("sGraph(P, wn).bump", "sO.bumpAmt"),
      );
  };
  m.needsUpdate = true;
}

const STRUCT_GLSL = /* glsl */`
struct SurfOut { float rough; float roughAmt; float bump; float bumpAmt; vec3 tint; float tintAmt; };
`;

// Perturb the (view-space) normal from a height gradient. `heightExpr` samples
// the height at world point `P`; `amtExpr` is the strength. Shared shape, two
// callers (the picker's single generator, the graph's bump port).
function bumpGLSL(heightExpr: string, amtExpr: string): string {
  return /* glsl */`
  {
    float bAmt = ${amtExpr};
    if (bAmt > 0.0001) {
      vec3 wn = normalize(vSurfWNorm);
      vec3 tg = normalize(cross(wn, abs(wn.y) < 0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));
      vec3 bt = cross(wn, tg);
      float e = 0.05;
      vec3 P = vSurfWPos;
      float h0 = ${heightExpr};
      P = vSurfWPos + tg * e; float ht = ${heightExpr};
      P = vSurfWPos + bt * e; float hb = ${heightExpr};
      vec3 wPert = normalize(wn - bAmt * ((ht - h0) * tg + (hb - h0) * bt) / e);
      normal = normalize((viewMatrix * vec4(wPert, 0.0)).xyz);
    }
  }`;
}

function writeUniforms(u: Record<string, THREE.IUniform>, spec: SurfaceSpec): void {
  u["uSurfKind"]!.value = SURF_KIND[spec.kind];
  u["uSurfScale"]!.value = spec.scale;
  u["uSurfAmount"]!.value = spec.amount;
  u["uSurfAngle"]!.value = spec.angle ?? 0;
  u["uSurfBump"]!.value = spec.bump ?? 0;
  (u["uSurfColor"]!.value as THREE.Color).set(spec.color ?? "#000000");
  u["uSurfColorAmt"]!.value = spec.colorAmount ?? 0;
}

// --- the compiler -----------------------------------------------------------
const GEN_KIND: Record<string, number> = { noise: 0, scratches: 1, brushed: 2, voronoi: 3 };

/** Walk the graph from its output, emit one GLSL statement per node in
 *  dependency order, and return the `SurfOut sGraph(vec3 wp, vec3 wn)` function.
 *  Params are baked as literals (so a graph change recompiles); a missing wire
 *  or param falls back to a default rather than failing to compile. */
export function compileGraph(graph: SurfaceGraph): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const order: SurfaceNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string | undefined) => {
    if (!id) return;
    const n = byId.get(id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    for (const src of Object.values(n.in ?? {})) visit(src);
    order.push(n);
  };
  visit(graph.output);

  const varOf = (id: string) => "g_" + id.replace(/[^a-zA-Z0-9_]/g, "_");
  const flt = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d).toFixed(5);
  const vec = (v: unknown, d: string) => {
    const c = new THREE.Color(typeof v === "string" ? v : d);
    return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
  };
  const inFloat = (n: SurfaceNode, port: string, d: string) => (n.in?.[port] ? varOf(n.in[port]!) : d);

  const lines: string[] = [];
  let out: SurfaceNode | undefined;
  for (const n of order) {
    const p = n.params ?? {};
    if (n.type in GEN_KIND) {
      lines.push(`float ${varOf(n.id)} = sGen(wp, wn, ${GEN_KIND[n.type]}, ${flt(p["scale"], 6)}, ${flt(p["angle"], 0)});`);
    } else if (n.type === "ramp") {
      lines.push(`vec3 ${varOf(n.id)} = mix(${vec(p["colorA"], "#000000")}, ${vec(p["colorB"], "#ffffff")}, clamp(${inFloat(n, "t", "0.0")}, 0.0, 1.0));`);
    } else if (n.type === "mix") {
      const t = n.in?.["t"] ? varOf(n.in["t"]!) : flt(p["t"], 0.5);
      lines.push(`float ${varOf(n.id)} = mix(${inFloat(n, "a", "0.0")}, ${inFloat(n, "b", "0.0")}, ${t});`);
    } else if (n.type === "output") {
      out = n;
    }
  }
  const op = out?.params ?? {};
  return `SurfOut sGraph(vec3 wp, vec3 wn){
  ${lines.join("\n  ")}
  SurfOut o;
  o.rough = ${out?.in?.["roughness"] ? varOf(out.in["roughness"]!) : "0.5"};
  o.roughAmt = ${flt(op["roughAmount"], 0.5)};
  o.bump = ${out?.in?.["bump"] ? varOf(out.in["bump"]!) : "0.0"};
  o.bumpAmt = ${flt(op["bumpAmount"], 0.4)};
  o.tint = ${out?.in?.["color"] ? varOf(out.in["color"]!) : "vec3(0.0)"};
  o.tintAmt = ${flt(op["colorAmount"], 0.0)};
  return o;
}`;
}
