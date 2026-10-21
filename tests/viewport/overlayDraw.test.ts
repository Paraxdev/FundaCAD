// The overlay over a traced image draws bodies depth only. A material override
// left on the scene (BokehPass's packed depth after a pass threw) drew every mesh
// as RGBA packed depth instead, magenta and yellow stripes over the trace.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { OverlayDraw } from "../../src/viewport/pathtrace/overlayDraw";

describe("OverlayDraw", () => {
  it("renders without a material override the scene was left with, and gives it back", () => {
    const scene = new THREE.Scene();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    body.userData.owner = "body1";
    scene.add(body);
    const stale = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    scene.overrideMaterial = stale;
    const seen: { override: THREE.Material | null; body: THREE.Material | THREE.Material[] }[] = [];
    const renderer = {
      shadowMap: { autoUpdate: true },
      getClearColor: (c: THREE.Color) => c.set(0x000000),
      getClearAlpha: () => 1,
      setClearColor: () => {},
      render: (s: THREE.Scene) => seen.push({ override: s.overrideMaterial, body: body.material }),
    } as unknown as THREE.WebGLRenderer;
    const draw = new OverlayDraw();
    draw.render(renderer, scene, new THREE.PerspectiveCamera());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.override).toBeNull();
    expect(seen[0]!.body).toBe(draw.depthOnly);
    expect(scene.overrideMaterial).toBe(stale);
  });

  it("draws no scene background, an HDR shown behind would cover the trace, and gives it back", () => {
    const scene = new THREE.Scene();
    const hdr = new THREE.Texture();
    scene.background = hdr;
    const seen: (THREE.Color | THREE.Texture | null)[] = [];
    const renderer = {
      shadowMap: { autoUpdate: true },
      getClearColor: (c: THREE.Color) => c.set(0x000000),
      getClearAlpha: () => 1,
      setClearColor: () => {},
      render: (s: THREE.Scene) => seen.push(s.background as THREE.Texture | null),
    } as unknown as THREE.WebGLRenderer;
    new OverlayDraw().render(renderer, scene, new THREE.PerspectiveCamera());
    expect(seen).toEqual([null]);
    expect(scene.background).toBe(hdr);
  });
});
