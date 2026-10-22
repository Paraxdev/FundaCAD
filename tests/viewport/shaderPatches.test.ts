import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applySurface, applySurfaceGraph, cloneWithoutSurface } from "../../src/viewport/proceduralSurface";
import { isGlassAuto, setGlassAuto } from "../../src/viewport/glassThickness";
import { clearPatches, getPatch, removePatch, setPatch } from "../../src/viewport/shaderPatches";

// Stands in for three's WebGLRenderer.getProgram: onBeforeCompile runs only the
// first time a material meets a program key, and the uniforms object of the last
// such compile is what every later frame uploads from, whatever key it returns to.
function compiled(mat: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  mat.onBeforeCompile(shader as never, {} as never);
  return shader;
}

const count = (s: string, sub: string) => s.split(sub).length - 1;
const stockKey = new THREE.MeshPhysicalMaterial().customProgramCacheKey();
const noise = { kind: "noise" as const, scale: 4, amount: 0.5, color: "#ff0000", colorAmount: 1 };
const mesh = (m: THREE.Material) => new THREE.Mesh(new THREE.BoxGeometry(), m);

describe("shader patch stack", () => {
  it("composes two patches with each insertion and the shared varyings once", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applySurface(m, noise);
    setGlassAuto(m, mesh(m));
    setPatch(m, {
      name: "probe",
      key: "probe",
      varyings: ["surfWorld"],
      after: { aomap_fragment: "  float probeAo = 1.0;" },
    });
    const s = compiled(m);
    expect(count(s.vertexShader, "varying vec3 vSurfWPos;")).toBe(1);
    expect(count(s.fragmentShader, "varying vec3 vSurfWPos;")).toBe(1);
    expect(count(s.vertexShader, "vSurfWPos = (modelMatrix")).toBe(1);
    expect(count(s.fragmentShader, "float sPickHeight(")).toBe(1);
    expect(count(s.fragmentShader, "float sH = sPickHeight(")).toBe(1);
    expect(count(s.fragmentShader, "vec4 transmitted = fcVolumeRefraction(")).toBe(1);
    expect(count(s.fragmentShader, "float probeAo = 1.0;")).toBe(1);
    expect(s.fragmentShader).not.toContain("#include <transmission_fragment>");
    expect(m.customProgramCacheKey()).toBe("surf-pick|glass-auto|probe");
  });

  it("gives the same source and key in either set order", () => {
    const a = new THREE.MeshPhysicalMaterial();
    applySurface(a, noise);
    setGlassAuto(a, mesh(a));
    const b = new THREE.MeshPhysicalMaterial();
    setGlassAuto(b, mesh(b));
    applySurface(b, noise);
    expect(b.customProgramCacheKey()).toBe("surf-pick|glass-auto");
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    const sa = compiled(a),
      sb = compiled(b);
    expect(sb.vertexShader).toBe(sa.vertexShader);
    expect(sb.fragmentShader).toBe(sa.fragmentShader);
  });

  it("changes the key when a patch is added and not when a uniform changes", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applySurface(m, noise);
    const k = m.customProgramCacheKey();
    const v = m.version;
    applySurface(m, { ...noise, colorAmount: 0.2, kind: "voronoi" });
    expect(m.customProgramCacheKey()).toBe(k);
    expect(m.version).toBe(v);
    setGlassAuto(m, mesh(m));
    expect(m.customProgramCacheKey()).not.toBe(k);
    expect(m.version).toBeGreaterThan(v);
  });

  it("keeps the other patch when one is removed", () => {
    const m = new THREE.MeshPhysicalMaterial();
    setGlassAuto(m, mesh(m));
    applySurface(m, noise);
    applySurface(m, undefined);
    expect(isGlassAuto(m)).toBe(true);
    expect(m.customProgramCacheKey()).toBe("glass-auto");
    let s = compiled(m);
    expect(s.fragmentShader).toContain("fcVolumeRefraction(");
    expect(s.fragmentShader).not.toContain("sPickHeight");
    applySurface(m, noise);
    setGlassAuto(m, null);
    expect(m.customProgramCacheKey()).toBe("surf-pick");
    s = compiled(m);
    expect(s.fragmentShader).toContain("sPickHeight");
    expect(s.fragmentShader).not.toContain("fcVolumeRefraction");
  });

  it("gives back the stock program when cleared", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applySurface(m, noise);
    setGlassAuto(m, mesh(m));
    clearPatches(m);
    expect(getPatch(m, "surface")).toBeUndefined();
    expect(m.customProgramCacheKey()).toBe(stockKey);
    const s = compiled(m);
    expect(s.vertexShader).toBe(THREE.ShaderLib.physical.vertexShader);
    expect(s.fragmentShader).toBe(THREE.ShaderLib.physical.fragmentShader);
    const never = new THREE.MeshPhysicalMaterial();
    removePatch(never, "surface");
    expect(Object.prototype.hasOwnProperty.call(never, "onBeforeCompile")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(never, "customProgramCacheKey")).toBe(false);
  });

  it("refuses a second patch that replaces the same include", () => {
    const m = new THREE.MeshPhysicalMaterial();
    setGlassAuto(m, mesh(m));
    expect(() => setPatch(m, { name: "probe", key: "probe", replace: { transmission_fragment: "" } })).toThrow();
  });

  it("does not expand dollar sequences in the inserted text", () => {
    const m = new THREE.MeshPhysicalMaterial();
    setPatch(m, { name: "probe", key: "probe", after: { aomap_fragment: "  // $& $1 $$" } });
    expect(compiled(m).fragmentShader).toContain("#include <aomap_fragment>\n  // $& $1 $$");
  });
});

describe("uniforms three already bound", () => {
  it("a picker edit reaches the uniforms the first compile bound", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applySurface(m, noise);
    const bound = compiled(m).uniforms;
    applySurface(m, { ...noise, colorAmount: 0, color: "#00ff00", scale: 9 });
    expect(bound.uSurfColorAmt!.value).toBe(0);
    expect(bound.uSurfScale!.value).toBe(9);
    expect((bound.uSurfColor!.value as THREE.Color).getHexString()).toBe("00ff00");
    applySurface(m, undefined);
    applySurface(m, { ...noise, colorAmount: 0.7 });
    expect(bound.uSurfColorAmt!.value).toBe(0.7);
    expect(m.userData.surfUniforms!.uSurfColorAmt).toBe(bound.uSurfColorAmt);
  });

  it("a key three returns to finds every uniform it needs", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applySurface(m, noise);
    compiled(m);
    applySurface(m, undefined);
    setGlassAuto(m, mesh(m));
    const last = compiled(m).uniforms;
    setGlassAuto(m, null);
    const stock = compiled(m).uniforms;
    applySurface(m, { ...noise, colorAmount: 0.3 });
    expect(last.uSurfColorAmt!.value).toBe(0.3);
    expect(stock.uSurfColorAmt!.value).toBe(0.3);
    expect(stock.fcBodyId).toBe(last.fcBodyId);
  });

  it("glass off and on keeps the body id object", () => {
    const m = new THREE.MeshPhysicalMaterial();
    const body = mesh(m);
    setGlassAuto(m, body);
    const bound = compiled(m).uniforms;
    setGlassAuto(m, null);
    setGlassAuto(m, body);
    expect(getPatch(m, "glassAuto")!.uniforms!.fcBodyId).toBe(bound.fcBodyId);
  });
});

describe("cloneWithoutSurface", () => {
  it("sheds the surface and keeps glass with its own body id", () => {
    const m = new THREE.MeshPhysicalMaterial();
    const body = mesh(m);
    applySurface(m, noise);
    setGlassAuto(m, body);
    const c = cloneWithoutSurface(m);
    expect(getPatch(c, "surface")).toBeUndefined();
    expect(isGlassAuto(c)).toBe(true);
    expect(c.customProgramCacheKey()).toBe("glass-auto");
    const s = compiled(c),
      base = compiled(m);
    expect(s.fragmentShader).not.toContain("sPickHeight");
    expect(s.uniforms.fcBodyId).not.toBe(base.uniforms.fcBodyId);
    expect(s.uniforms.fcBodyId!.value).toBe(base.uniforms.fcBodyId!.value);
    expect(s.uniforms.fcBackDepth).toBe(base.uniforms.fcBackDepth);
  });

  it("gives a graph surface back the stock key", () => {
    const m = new THREE.MeshPhysicalMaterial();
    applySurfaceGraph(m, {
      output: "out",
      nodes: [
        { id: "n", type: "noise" },
        { id: "out", type: "output", in: { bump: "n" } },
      ],
    });
    expect(cloneWithoutSurface(m).customProgramCacheKey()).toBe(stockKey);
  });
});

describe("three internals the patches rely on", () => {
  it("has every include a patch edits exactly once", () => {
    expect(THREE.REVISION).toBe("186");
    const { vertexShader: vs, fragmentShader: fs } = THREE.ShaderLib.physical;
    for (const inc of ["common", "worldpos_vertex"]) expect(count(vs, `#include <${inc}>`)).toBe(1);
    for (const inc of [
      "common",
      "color_fragment",
      "roughnessmap_fragment",
      "normal_fragment_begin",
      "transmission_pars_fragment",
      "transmission_fragment",
      "aomap_fragment",
      "lights_fragment_maps",
    ])
      expect(count(fs, `#include <${inc}>`)).toBe(1);
  });
});
