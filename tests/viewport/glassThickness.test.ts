import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { finishOf, normalizeMaterial } from "../../src/document/materials";
import { applyGlassLook } from "../../src/viewport/render";
import { applySurface } from "../../src/viewport/proceduralSurface";
import { isGlassAuto, meanThickness, patchGlassShader, setGlassAuto } from "../../src/viewport/glassThickness";
import { finishKey } from "../../src/viewport/bodyFinish";

const glass = (extra: Record<string, unknown> = {}) =>
  finishOf(normalizeMaterial({ id: "g", name: "Glass", color: "#ffffff", opacity: 0.2, metalness: 0, ...extra })!);

function body(geo: THREE.BufferGeometry) {
  const mat = new THREE.MeshPhysicalMaterial();
  return { mat, mesh: new THREE.Mesh(geo, mat) };
}

function compiled(mat: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  mat.onBeforeCompile(shader as never, {} as never);
  return shader;
}

describe("meanThickness", () => {
  it("is 2 * volume / area of the display mesh", () => {
    expect(meanThickness(new THREE.BoxGeometry(100, 100, 2))).toBeCloseTo(1.923, 2);
    expect(meanThickness(new THREE.BoxGeometry(20, 20, 20))).toBeCloseTo(6.667, 2);
    expect(meanThickness(new THREE.BoxGeometry(20, 20, 20).toNonIndexed())).toBeCloseTo(6.667, 2);
    expect(meanThickness(new THREE.SphereGeometry(10, 64, 48))).toBeCloseTo(6.67, 1);
  });

  it("falls back to 3 mm for a mesh with no volume", () => {
    expect(meanThickness(new THREE.PlaneGeometry(10, 10))).toBe(3);
    expect(meanThickness(new THREE.BufferGeometry())).toBe(3);
    expect(meanThickness(undefined)).toBe(3);
  });
});

describe("applyGlassLook thickness", () => {
  it("takes the body's own thickness on auto and patches the shader", () => {
    const plate = body(new THREE.BoxGeometry(100, 100, 2));
    const block = body(new THREE.BoxGeometry(20, 20, 20));
    expect(applyGlassLook(plate.mat, glass(), false, plate.mesh)).toBe(true);
    expect(applyGlassLook(block.mat, glass(), false, block.mesh)).toBe(true);
    expect(plate.mat.thickness).toBeCloseTo(1.923, 2);
    expect(block.mat.thickness).toBeCloseTo(6.667, 2);
    expect(isGlassAuto(plate.mat)).toBe(true);
    const s = compiled(plate.mat);
    expect(s.fragmentShader).toContain("fcVolumeRefraction");
    expect(s.fragmentShader).not.toContain("#include <transmission_fragment>");
    expect(s.uniforms["fcBodyId"]!.value).toBeGreaterThan(0);
    expect(s.uniforms["fcBodyId"]!.value).not.toBe(compiled(block.mat).uniforms["fcBodyId"]!.value);
  });

  it("keeps a stored number as it was, with the stock shader", () => {
    const block = body(new THREE.BoxGeometry(20, 20, 20));
    applyGlassLook(block.mat, glass(), false, block.mesh);
    applyGlassLook(block.mat, glass({ thickness: 3 }), false, block.mesh);
    expect(block.mat.thickness).toBe(3);
    expect(isGlassAuto(block.mat)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(block.mat, "onBeforeCompile")).toBe(false);
    expect(finishKey(glass())).not.toBe(finishKey(glass({ thickness: 3 })));
  });

  it("composes with a procedural surface in either order of change", () => {
    const { mat, mesh } = body(new THREE.BoxGeometry(20, 20, 20));
    applySurface(mat, { kind: "noise", scale: 4, amount: 0.5 });
    applyGlassLook(mat, glass(), false, mesh);
    let s = compiled(mat);
    expect(s.fragmentShader).toContain("sPickHeight");
    expect(s.fragmentShader).toContain("fcVolumeRefraction");
    expect(mat.customProgramCacheKey()).toBe("surf-pick|glass-auto");
    // A new surface replaces the wrapper, the glass call after it wraps again.
    applySurface(mat, { kind: "scratches", scale: 8, amount: 0.6 });
    applyGlassLook(mat, glass(), false, mesh);
    s = compiled(mat);
    expect(s.fragmentShader).toContain("sPickHeight");
    expect(s.fragmentShader).toContain("fcVolumeRefraction");
    applyGlassLook(mat, glass({ opacity: 1 }), false, mesh);
    s = compiled(mat);
    expect(s.fragmentShader).toContain("sPickHeight");
    expect(s.fragmentShader).not.toContain("fcVolumeRefraction");
    expect(mat.customProgramCacheKey()).toBe("surf-pick");
  });

  it("leaves a clone without the patch", () => {
    const { mat, mesh } = body(new THREE.BoxGeometry(20, 20, 20));
    applyGlassLook(mat, glass(), false, mesh);
    expect(isGlassAuto(mat.clone())).toBe(false);
    setGlassAuto(mat, null);
    expect(isGlassAuto(mat)).toBe(false);
  });
});

describe("three internals the auto glass relies on", () => {
  // The glass chunk is a copy of three 0.180's transmission_fragment and the tail
  // of getIBLVolumeRefraction. Bumping three means diffing those two chunks.
  it("still has the includes the patch replaces", () => {
    expect(THREE.REVISION).toBe("180");
    const shader = { fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} };
    expect(shader.fragmentShader).toContain("#include <transmission_pars_fragment>");
    expect(shader.fragmentShader).toContain("#include <transmission_fragment>");
    patchGlassShader(shader, { value: 1 });
    expect(shader.fragmentShader).toContain("fcVolumeRefraction(");
    expect(THREE.ShaderChunk.transmission_pars_fragment).toContain("vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix )");
    expect(THREE.ShaderChunk.transmission_pars_fragment).toContain("vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior )");
    expect(THREE.ShaderChunk.transmission_pars_fragment).toContain("vec3 volumeAttenuation( const in float transmissionDistance");
  });
});
