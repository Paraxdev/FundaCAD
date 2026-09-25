// Potato mode's draw swaps materials and fat lines only for the length of one
// render. The contracts: what the renderer sees is cheap, and what is left
// behind afterwards is exactly what was there before.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { PotatoDraw } from "../../src/viewport/potato";
import { BodyEdges } from "../../src/viewport/edgeLines";
import type { RebuildResult } from "../../src/types";

interface Seen {
  target: THREE.WebGLRenderTarget | null;
  materials: THREE.Material[];
  fatVisible: boolean;
  lightVisible: boolean;
  proxies: THREE.LineSegments[];
}

function rig() {
  const scene = new THREE.Scene();
  const clip = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 3)];
  const pbr = new THREE.MeshPhysicalMaterial({
    color: 0x336699, vertexColors: true, transparent: true, opacity: 0.4,
    side: THREE.DoubleSide, clearcoat: 1, transmission: 0.5, emissive: 0xff0000,
    polygonOffset: true, polygonOffsetFactor: 1,
  });
  pbr.clippingPlanes = clip;
  const body = new THREE.Mesh(new THREE.BoxGeometry(), pbr);
  const basic = new THREE.MeshBasicMaterial();
  const multi = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), basic]);
  const edgeList: RebuildResult["edges"] = [
    { id: "e0", body: "b", points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] },
    { id: "e1", body: "b", points: [[0, 0, 1], [1, 0, 1]] },
  ];
  const edges = new BodyEdges(edgeList, new THREE.Vector2(800, 600));
  edges.object.position.set(5, 0, 0);
  const light = new THREE.RectAreaLight();
  scene.add(body, multi, edges.object, light);

  const seen: Seen[] = [];
  let current: THREE.WebGLRenderTarget | null = null;
  const draws: { scene: THREE.Scene; target: THREE.WebGLRenderTarget | null }[] = [];
  const renderer = {
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(320, 200),
    getRenderTarget: () => current,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => { current = t; },
    render: (s: THREE.Scene) => {
      draws.push({ scene: s, target: current });
      if (s !== scene) return;
      const proxies: THREE.LineSegments[] = [];
      s.traverse((o) => { if ((o as THREE.LineSegments).isLineSegments && o.parent?.name === "potato-lines") proxies.push(o as THREE.LineSegments); });
      seen.push({
        target: current,
        materials: [body.material as THREE.Material, ...(multi.material as THREE.Material[])],
        fatVisible: edges.object.visible,
        lightVisible: light.visible,
        proxies,
      });
    },
  } as unknown as THREE.WebGLRenderer;
  return { scene, body, multi, basic, pbr, clip, edges, light, renderer, seen, draws, camera: new THREE.PerspectiveCamera() };
}

describe("PotatoDraw", () => {
  it("draws Lambert twins that keep what the picture depends on", () => {
    const r = rig();
    new PotatoDraw().render(r.renderer, r.scene, r.camera);
    const cheap = r.seen[0]!.materials[0] as THREE.MeshLambertMaterial;
    expect(cheap.isMeshLambertMaterial).toBe(true);
    expect(cheap.color.getHex()).toBe(0x336699);
    expect(cheap.vertexColors).toBe(true);
    expect(cheap.transparent).toBe(true);
    expect(cheap.opacity).toBe(0.4);
    expect(cheap.side).toBe(THREE.DoubleSide);
    expect(cheap.clippingPlanes).toBe(r.clip);
    expect(cheap.polygonOffset).toBe(true);
    expect(cheap.emissive.getHex()).toBe(0xff0000);
    expect(cheap.emissiveIntensity).toBe(r.pbr.emissiveIntensity);
    // Only the PBR slot of a material array is swapped.
    expect((r.seen[0]!.materials[1] as THREE.MeshLambertMaterial).isMeshLambertMaterial).toBe(true);
    expect(r.seen[0]!.materials[2]).toBe(r.basic);
  });

  it("puts the real materials back untouched", () => {
    const r = rig();
    const before = JSON.stringify(r.pbr.toJSON());
    const version = r.pbr.version;
    const multiWas = r.multi.material;
    new PotatoDraw().render(r.renderer, r.scene, r.camera);
    expect(r.body.material).toBe(r.pbr);
    expect(r.multi.material).toBe(multiWas);
    expect(r.pbr.version).toBe(version);
    expect(JSON.stringify(r.pbr.toJSON())).toBe(before);
  });

  it("puts everything back when the traversal throws part way through", () => {
    const r = rig();
    const multiWas = r.multi.material;
    const bomb = new THREE.Object3D();
    Object.defineProperty(bomb, "isMesh", { get() { throw new Error("boom"); } });
    r.scene.add(bomb);
    const draw = new PotatoDraw();
    expect(() => draw.render(r.renderer, r.scene, r.camera)).toThrow("boom");
    expect(r.seen).toHaveLength(0);
    expect(r.body.material).toBe(r.pbr);
    expect(r.multi.material).toBe(multiWas);
    expect(r.edges.object.visible).toBe(true);
    expect(r.light.visible).toBe(true);
    expect(r.scene.getObjectByName("potato-lines")).toBeUndefined();
    r.scene.remove(bomb);
    draw.render(r.renderer, r.scene, r.camera);
    expect(r.seen).toHaveLength(1);
    expect(r.body.material).toBe(r.pbr);
    expect(r.light.visible).toBe(true);
  });

  it("draws fat lines as plain segments over the same points and colours", () => {
    const r = rig();
    r.edges.setColor(1, new THREE.Color(1, 0, 0));
    new PotatoDraw().render(r.renderer, r.scene, r.camera);
    const s = r.seen[0]!;
    expect(s.fatVisible).toBe(false);
    expect(s.proxies).toHaveLength(1);
    const proxy = s.proxies[0]!;
    expect((proxy.material as THREE.LineBasicMaterial).vertexColors).toBe(true);
    // Three segments, two vertices each.
    expect(proxy.geometry.drawRange.count).toBe(6);
    const pos = proxy.geometry.getAttribute("position");
    expect([pos.getX(4), pos.getY(4), pos.getZ(4)]).toEqual([0, 0, 1]);
    const col = proxy.geometry.getAttribute("color");
    expect([col.getX(4), col.getY(4), col.getZ(4)]).toEqual([1, 0, 0]);
    expect(proxy.matrixWorld.elements[12]).toBe(5);
    // Afterwards the fat line is back and the twins are out of the scene.
    expect(r.edges.object.visible).toBe(true);
    expect(r.scene.getObjectByName("potato-lines")).toBeUndefined();
  });

  it("follows an edge recolour on the next frame", () => {
    const r = rig();
    const draw = new PotatoDraw();
    draw.render(r.renderer, r.scene, r.camera);
    const col = r.seen[0]!.proxies[0]!.geometry.getAttribute("color") as THREE.BufferAttribute;
    const v = col.version;
    r.edges.setColor(0, new THREE.Color(0, 1, 0));
    draw.render(r.renderer, r.scene, r.camera);
    expect(r.seen[1]!.proxies[0]!.geometry.getAttribute("color")).toBe(col);
    expect(col.version).toBeGreaterThan(v);
    expect(col.getY(0)).toBe(1);
  });

  it("pushes faces back so the thin edges win, and lights them without the environment", () => {
    const r = rig();
    let ambient = 0;
    const render = r.renderer.render.bind(r.renderer);
    (r.renderer as unknown as { render: (s: THREE.Scene) => void }).render = (s: THREE.Scene) => {
      s.traverse((o) => { if ((o as THREE.AmbientLight).isAmbientLight) ambient = (o as THREE.AmbientLight).intensity; });
      render(s, r.camera);
    };
    new PotatoDraw().render(r.renderer, r.scene, r.camera, 0.5);
    const cheap = r.seen[0]!.materials[0] as THREE.MeshLambertMaterial;
    expect(cheap.polygonOffsetFactor).toBeGreaterThan(r.pbr.polygonOffsetFactor);
    expect(ambient).toBeGreaterThan(0);
    let after = 0;
    r.scene.traverse((o) => { if ((o as THREE.AmbientLight).isAmbientLight) after++; });
    expect(after).toBe(0);
  });

  it("skips what is hidden and hides the emitter lights only while drawing", () => {
    const r = rig();
    r.edges.object.visible = false;
    new PotatoDraw().render(r.renderer, r.scene, r.camera);
    expect(r.seen[0]!.proxies).toHaveLength(0);
    expect(r.seen[0]!.lightVisible).toBe(false);
    expect(r.light.visible).toBe(true);
    expect(r.edges.object.visible).toBe(false);
  });

  it("draws into a target the drawing buffer's size, then copies it to the canvas", () => {
    const r = rig();
    new PotatoDraw().render(r.renderer, r.scene, r.camera);
    const target = r.seen[0]!.target!;
    expect(target).toBeInstanceOf(THREE.WebGLRenderTarget);
    expect([target.width, target.height]).toEqual([320, 200]);
    expect(target.samples).toBe(0);
    expect(r.draws).toHaveLength(2);
    expect(r.draws[1]!.scene).not.toBe(r.scene);
    expect(r.draws[1]!.target).toBeNull();
  });

  it("reuses its twins and lets go of the ones nobody draws", () => {
    const r = rig();
    const draw = new PotatoDraw();
    draw.render(r.renderer, r.scene, r.camera);
    const first = r.seen[0]!.materials[0];
    draw.render(r.renderer, r.scene, r.camera);
    expect(r.seen[1]!.materials[0]).toBe(first);
    expect(draw.held).toEqual({ materials: 2, lines: 1 });
    r.body.visible = false;
    r.multi.visible = false;
    r.edges.object.visible = false;
    for (let i = 0; i < 32; i++) draw.render(r.renderer, r.scene, r.camera);
    expect(draw.held).toEqual({ materials: 0, lines: 0 });
    draw.dispose();
  });
});
