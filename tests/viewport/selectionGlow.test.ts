import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { glowFade, makeSelectionGlow, screenCoverage } from "../../src/viewport/selectionGlow";
import { Highlighter } from "../../src/viewport/highlight";
import type { ModelView } from "../../src/viewport/render";

describe("selection glow", () => {
  it("a new highlighter takes off the glows an old one left on a reused body", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry);
    const keep = new THREE.Object3D();
    mesh.add(makeSelectionGlow(geometry, "select"), makeSelectionGlow(geometry, "hover"), keep);
    new Highlighter({ bodies: [{ id: "b1", mesh }] } as unknown as ModelView);
    expect(mesh.children).toEqual([keep]);
  });
});

describe("a body filling the view does not wash the screen", () => {
  const camera = () => {
    const c = new THREE.PerspectiveCamera(45, 1.5, 0.1, 10000);
    c.position.set(0, -60, 45);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld();
    return c;
  };
  const box = (x: number, y: number, z: number) =>
    new THREE.Box3(new THREE.Vector3(-x / 2, -y / 2, -z / 2), new THREE.Vector3(x / 2, y / 2, z / 2));
  const I = new THREE.Matrix4();

  it("measures a small part as a small share of the view", () => {
    expect(screenCoverage(box(10, 10, 10), I, camera())).toBeLessThan(0.1);
  });

  it("counts a plate the camera sits over as the whole view", () => {
    // The tester's 220 x 220 x 4 plate under a camera framed for a 20 mm box.
    expect(screenCoverage(box(220, 220, 4), I, camera())).toBeCloseTo(1, 1);
  });

  it("keeps full strength for an ordinary selection and fades a view-filling one", () => {
    expect(glowFade(0.2)).toBe(1);
    expect(glowFade(1)).toBeCloseTo(0.25);
    expect(glowFade(0.7)).toBeLessThan(1);
    expect(glowFade(0.7)).toBeGreaterThan(0.25);
  });

  it("sets the fade per draw, since the material is shared", () => {
    const geometry = new THREE.BoxGeometry(220, 220, 4);
    const glow = makeSelectionGlow(geometry, "select");
    glow.updateMatrixWorld();
    const mat = glow.material as THREE.ShaderMaterial;
    glow.onBeforeRender(null as never, null as never, camera(), geometry, mat, null as never);
    expect(mat.uniforms.uFade!.value).toBeCloseTo(0.25);
  });
});

describe("a glow drawn by a pass that overrides every material", () => {
  it("leaves the override alone instead of reading glow uniforms off it", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const glow = makeSelectionGlow(geometry, "hover");
    glow.updateMatrixWorld();
    const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 100);
    camera.position.set(0, -5, 3);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    const call = (mat: THREE.Material) =>
      glow.onBeforeRender(
        {} as THREE.WebGLRenderer,
        new THREE.Scene(),
        camera,
        geometry,
        mat,
        null as unknown as THREE.Group,
      );
    expect(() => call(depth)).not.toThrow();
    const own = glow.material as THREE.ShaderMaterial;
    own.uniforms.uFade!.value = -1;
    call(own);
    expect(own.uniforms.uFade!.value).toBeGreaterThan(0);
  });
});

describe("a section cut clips the glow and the face hover", () => {
  // The glow and face hover materials are shared module state, so each case starts from a fresh module.
  const fresh = async () => {
    vi.resetModules();
    return import("../../src/viewport/selectionGlow");
  };
  const cut = new THREE.Plane(new THREE.Vector3(3, -4, 12).divideScalar(13), -40);
  const geometry = new THREE.BoxGeometry(30, 20, 12);
  const clipOf = (m: THREE.Material) => ({
    clipping: (m as THREE.ShaderMaterial).clipping ?? null,
    planes: m.clippingPlanes,
  });
  const hoverColor = new THREE.Color(0.2, 0.7, 0.5);

  it("reaches materials made before the cut and after it", async () => {
    const g = await fresh();
    const select = g.makeSelectionGlow(geometry, "select").material as THREE.Material;
    const faceBefore = g.makeFaceHoverOverlay(new Float32Array(9), hoverColor).material as THREE.Material;
    g.clipSelectionOverlays([cut]);
    const hover = g.makeSelectionGlow(geometry, "hover").material as THREE.Material;
    expect([clipOf(select), clipOf(hover), { planes: faceBefore.clippingPlanes }]).toEqual([
      { clipping: true, planes: [cut] },
      { clipping: true, planes: [cut] },
      { planes: [cut] },
    ]);
  });

  it("clips a face hover made after the cut, and no cut clears all three", async () => {
    const g = await fresh();
    const select = g.makeSelectionGlow(geometry, "select").material as THREE.Material;
    g.clipSelectionOverlays([cut]);
    const hover = g.makeSelectionGlow(geometry, "hover").material as THREE.Material;
    const face = g.makeFaceHoverOverlay(new Float32Array(9), hoverColor).material as THREE.Material;
    expect(face.clippingPlanes).toEqual([cut]);
    g.clipSelectionOverlays(null);
    expect([select.clippingPlanes, hover.clippingPlanes, face.clippingPlanes]).toEqual([null, null, null]);
  });

  it("the glow shader carries three's clipping chunks", async () => {
    const g = await fresh();
    const m = g.makeSelectionGlow(geometry, "select").material as THREE.ShaderMaterial;
    expect([
      m.vertexShader.includes("#include <clipping_planes_pars_vertex>"),
      m.vertexShader.includes("#include <clipping_planes_vertex>"),
      m.fragmentShader.includes("#include <clipping_planes_pars_fragment>"),
      m.fragmentShader.includes("#include <clipping_planes_fragment>"),
    ]).toEqual([true, true, true, true]);
  });
});
