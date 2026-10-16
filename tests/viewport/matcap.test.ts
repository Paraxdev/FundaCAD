// Matcap swaps body materials only for the length of one render, and what is
// left behind afterwards is exactly what was there before.
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { MATCAP_GAIN, MatcapDraw, studioMatcap } from "../../src/viewport/matcap";
import { PostChain } from "../../src/viewport/scene";
import { DEFAULT_RENDER, setRenderPref } from "../../src/ui/renderPrefs";

interface Seen {
  body: THREE.Material;
  multi: THREE.Material[];
  preview: THREE.Material;
  glow: THREE.Material;
  lights: boolean[];
  autoUpdate: boolean;
}

function rig() {
  const scene = new THREE.Scene();
  const clip = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 3)];
  const pbr = new THREE.MeshPhysicalMaterial({
    color: 0x336699, vertexColors: true, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
    clearcoat: 1, transmission: 0.5, emissive: 0xff0000, emissiveIntensity: 3,
    polygonOffset: true, polygonOffsetFactor: 1, colorWrite: false,
    stencilWrite: true, stencilRef: 2,
  });
  pbr.clippingPlanes = clip;
  const body = new THREE.Mesh(new THREE.BoxGeometry(), pbr);
  body.userData.owner = { id: "body1" };
  const glow = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  body.add(glow);
  const basic = new THREE.MeshBasicMaterial();
  const faces = [new THREE.MeshStandardMaterial({ vertexColors: true }), basic];
  const multi = new THREE.Mesh(new THREE.BoxGeometry(), faces);
  multi.userData.owner = { id: "body2" };
  const preview = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const area = new THREE.RectAreaLight();
  const point = new THREE.PointLight();
  const key = new THREE.DirectionalLight();
  scene.add(body, multi, preview, area, point, key);

  const seen: Seen[] = [];
  const shadowMap = { autoUpdate: true, enabled: true };
  let fail = false;
  const renderer = {
    shadowMap,
    render: () => {
      seen.push({
        body: body.material as THREE.Material,
        multi: [...(multi.material as THREE.Material[])],
        preview: preview.material as THREE.Material,
        glow: glow.material as THREE.Material,
        lights: [area.visible, point.visible, key.visible],
        autoUpdate: shadowMap.autoUpdate,
      });
      if (fail) throw new Error("lost context");
    },
  } as unknown as THREE.WebGLRenderer;
  return {
    scene, body, multi, faces, preview, glow, pbr, clip, area, point, renderer, seen, shadowMap,
    camera: new THREE.PerspectiveCamera(), failNext: () => { fail = true; },
  };
}

describe("MatcapDraw", () => {
  it("draws body PBR slots as matcap twins that keep the ghost and section state", () => {
    const r = rig();
    new MatcapDraw().render(r.renderer, r.scene, r.camera);
    const s = r.seen[0]!;
    const flat = s.body as THREE.MeshMatcapMaterial;
    expect(flat.isMeshMatcapMaterial).toBe(true);
    expect(flat.matcap).toBe(studioMatcap());
    expect(flat.vertexColors).toBe(true);
    expect(flat.transparent).toBe(true);
    expect(flat.opacity).toBe(0.4);
    expect(flat.side).toBe(THREE.DoubleSide);
    expect(flat.colorWrite).toBe(false);
    expect(flat.clippingPlanes).toBe(r.clip);
    expect(flat.stencilWrite).toBe(true);
    expect(flat.stencilRef).toBe(2);
    expect(flat.polygonOffsetFactor).toBe(1);
    expect(flat.color.g).toBeCloseTo(new THREE.Color(0x336699).g * MATCAP_GAIN, 6);
    expect((s.multi[0] as THREE.MeshMatcapMaterial).isMeshMatcapMaterial).toBe(true);
    expect(s.multi[1]).toBe(r.faces[1]);
    expect(s.lights).toEqual([false, false, true]);
    expect(s.autoUpdate).toBe(false);
  });

  it("leaves tool previews and body overlays alone", () => {
    const r = rig();
    const before = { preview: r.preview.material, glow: r.glow.material };
    new MatcapDraw().render(r.renderer, r.scene, r.camera);
    expect(r.seen[0]!.preview).toBe(before.preview);
    expect(r.seen[0]!.glow).toBe(before.glow);
  });

  it("puts back the same material objects, lights and shadow switch", () => {
    const r = rig();
    const faces = r.multi.material;
    new MatcapDraw().render(r.renderer, r.scene, r.camera);
    expect(r.body.material).toBe(r.pbr);
    expect(r.multi.material).toBe(faces);
    expect(r.faces[0]).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect([r.area.visible, r.point.visible]).toEqual([true, true]);
    expect(r.shadowMap.autoUpdate).toBe(true);
    expect(r.pbr.emissiveIntensity).toBe(3);
    expect(r.pbr.transmission).toBe(0.5);
    expect(r.pbr.clearcoat).toBe(1);
  });

  it("puts everything back when the draw throws", () => {
    const r = rig();
    r.failNext();
    expect(() => new MatcapDraw().render(r.renderer, r.scene, r.camera)).toThrow("lost context");
    expect(r.body.material).toBe(r.pbr);
    expect((r.multi.material as THREE.Material[])[0]).toBe(r.faces[0]);
    expect([r.area.visible, r.point.visible]).toEqual([true, true]);
    expect(r.shadowMap.autoUpdate).toBe(true);
  });

  it("reuses one twin per source material and scales it by the brightness", () => {
    const r = rig();
    const d = new MatcapDraw();
    d.render(r.renderer, r.scene, r.camera);
    d.render(r.renderer, r.scene, r.camera, 2);
    expect(r.seen[1]!.body).toBe(r.seen[0]!.body);
    expect(d.held).toBe(2);
    const c = (r.seen[1]!.body as THREE.MeshMatcapMaterial).color;
    expect(c.r).toBeCloseTo(new THREE.Color(0x336699).r * 2 * MATCAP_GAIN, 6);
  });

  it("disposes every twin, and drops one whose source is gone", () => {
    const r = rig();
    const d = new MatcapDraw();
    d.render(r.renderer, r.scene, r.camera);
    const twin = r.seen[0]!.body;
    const gone = vi.spyOn(twin, "dispose");
    r.body.material = new THREE.MeshPhysicalMaterial();
    for (let i = 0; i < 31; i++) d.render(r.renderer, r.scene, r.camera);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(d.held).toBe(2);
    const twins = [r.seen.at(-1)!.body, r.seen.at(-1)!.multi[0]!].map((m) => vi.spyOn(m, "dispose"));
    d.dispose();
    for (const s of twins) expect(s).toHaveBeenCalledTimes(1);
    expect(d.held).toBe(0);
  });

  it("makes the matcap once", () => {
    expect(studioMatcap()).toBe(studioMatcap());
    expect(studioMatcap().colorSpace).toBe(THREE.SRGBColorSpace);
  });
});

describe("PostChain in Matcap", () => {
  function chain(potatoOn = () => false) {
    const scene = new THREE.Scene();
    const draws: { scene: THREE.Scene; target: unknown }[] = [];
    let current: unknown = null;
    const renderer = {
      shadowMap: { autoUpdate: true },
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 32),
      getPixelRatio: () => 1,
      getRenderTarget: () => current,
      setRenderTarget: (t: unknown) => { current = t; },
      render: (s: THREE.Scene) => { draws.push({ scene: s, target: current }); },
    } as unknown as THREE.WebGLRenderer;
    const post = new PostChain(renderer, scene, potatoOn, () => false);
    const composed: string[] = [];
    (post as unknown as { composer: unknown }).composer = {
      passes: [], render: () => composed.push("render"), setPixelRatio: () => {}, setSize: () => {},
    };
    const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    body.userData.owner = { id: "body1" };
    scene.add(body);
    return { scene, draws, composed, post, held: () => (post as unknown as { matcap: MatcapDraw | null }).matcap };
  }

  it("draws once straight to the canvas with no passes, and lets go of the twins on leaving", () => {
    setRenderPref("bloom", 1);
    const c = chain();
    c.post.viewMode = "matcap";
    expect(c.post.drawsShadows).toBe(false);
    c.post.render(new THREE.PerspectiveCamera());
    expect(c.draws).toEqual([{ scene: c.scene, target: null }]);
    expect(c.composed).toEqual([]);
    const draw = c.held()!;
    const dispose = vi.spyOn(draw, "dispose");
    setRenderPref("bloom", 0);
    c.post.viewMode = "realtime";
    expect(c.post.drawsShadows).toBe(true);
    c.post.render(new THREE.PerspectiveCamera());
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(c.held()).toBeNull();
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
  });

  it("draws a forced Realtime frame without dropping the twins", () => {
    setRenderPref("bloom", 0);
    const c = chain();
    c.post.viewMode = "matcap";
    c.post.render(new THREE.PerspectiveCamera());
    const draw = c.held();
    c.post.render(new THREE.PerspectiveCamera(), false, true);
    expect(c.held()).toBe(draw);
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
  });

  it("prefers potato mode over Matcap", () => {
    const c = chain(() => true);
    c.post.viewMode = "matcap";
    c.post.render(new THREE.PerspectiveCamera());
    expect(c.held()).toBeNull();
    expect(c.draws[0]!.target).toBeInstanceOf(THREE.WebGLRenderTarget);
  });
});
