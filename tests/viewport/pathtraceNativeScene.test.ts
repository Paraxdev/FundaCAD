import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BlasCache, mainThreadBuilder } from "../../src/viewport/pathtrace/blasCache";
import { meshFrame, NativeScene, nativeCamera, pageMaterial } from "../../src/viewport/pathtrace/nativeScene";

function body(id: string, etag: string, color?: boolean) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  if (color) g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 3).fill(0.5), 3));
  const mats = [new THREE.MeshPhysicalMaterial({ color: 0xff0000 }), new THREE.MeshPhysicalMaterial({ transmission: 1, ior: 1.4 })];
  const m = new THREE.Mesh(g, mats);
  m.userData.owner = { id, etag };
  return m;
}

function rust() {
  const have = new Set<string>();
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    if (cmd === "pt_scene") {
      const keys = (args as { bodies: { key: string }[] }).bodies.map((b) => b.key);
      return [...new Set(keys.filter((k) => !have.has(k)))];
    }
    if (cmd === "pt_mesh") {
      const b = args as Uint8Array;
      const len = new DataView(b.buffer, b.byteOffset).getUint32(0, true);
      have.add(JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + len))).key);
    }
    return null;
  };
  const errors: unknown[] = [];
  return { calls, scene: new NativeScene(call, (e) => errors.push(e)), errors, names: () => calls.map((c) => c.cmd) };
}

describe("native tracer scene feed", () => {
  it("takes the host's mirrors, which carry their body's id and key", async () => {
    const r = rust();
    const a = body("body1", "e1");
    const cache = new BlasCache(mainThreadBuilder);
    let sync = cache.sync([a], [a]);
    for (let i = 0; i < 5 && !sync.meshes; i++) {
      await Promise.resolve();
      sync = cache.sync([a], [a]);
    }
    expect(sync.meshes).not.toBeNull();
    await r.scene.setMeshes(sync.meshes!);
    expect(r.errors).toEqual([]);
    const sent = r.calls[0]!.args as { bodies: { id: string; key: string }[] };
    expect(sent.bodies.map((b) => b.id)).toEqual(["body1"]);
    expect(sent.bodies[0]!.key).toBe(sync.key);
  });

  it("sends each body's geometry once per key and only JSON for moves and materials", async () => {
    const r = rust();
    const a = body("body1", "e1");
    const b = body("body2", "e1");
    await r.scene.setMeshes([a, b]);
    expect(r.names()).toEqual(["pt_scene", "pt_mesh", "pt_mesh"]);

    r.calls.length = 0;
    await r.scene.setMeshes([a, b]);
    expect(r.names()).toEqual(["pt_scene"]);

    r.calls.length = 0;
    a.position.x = 3;
    await r.scene.refresh();
    expect(r.names()).toEqual(["pt_scene"]);
    const moved = (r.calls[0]!.args as { bodies: { matrix: number[] }[] }).bodies[0]!;
    expect(moved.matrix[12]).toBe(3);

    r.calls.length = 0;
    (a.material as THREE.MeshPhysicalMaterial[])[0]!.roughness = 0.1;
    await r.scene.refresh();
    expect(r.names()).toEqual(["pt_scene"]);
    expect(r.errors).toEqual([]);
  });

  it("an edit sends one mesh and new vertex colours go alone", async () => {
    const r = rust();
    const a = body("body1", "e1", true);
    const b = body("body2", "e1");
    await r.scene.setMeshes([a, b]);
    r.calls.length = 0;
    b.userData.owner.etag = "e2";
    await r.scene.setMeshes([a, b]);
    expect(r.names()).toEqual(["pt_scene", "pt_mesh"]);

    r.calls.length = 0;
    a.geometry.getAttribute("color").needsUpdate = true;
    await r.scene.setMeshes([a, b]);
    expect(r.names()).toEqual(["pt_scene", "pt_colors"]);
  });

  it("a mesh frame carries positions, normals, indices, slots and colours", () => {
    const m = body("body1", "e1", true);
    const f = meshFrame("k", m);
    const dv = new DataView(f.buffer);
    const len = dv.getUint32(0, true);
    const h = JSON.parse(new TextDecoder().decode(f.subarray(4, 4 + len)));
    expect(h).toMatchObject({ key: "k", vertices: 24, indices: 36, normals: true, colors: true });
    expect(h.groups.map((g: { slot: number }) => g.slot)).toEqual([0, 1, 2, 3, 4, 5]);
    const start = (4 + len + 3) & ~3;
    expect(f.byteLength).toBe(start + 24 * 12 * 3 + 36 * 4);
  });

  it("materials keep the P3 fields and an endless attenuation goes as 0", () => {
    const glass = pageMaterial(new THREE.MeshPhysicalMaterial({ transmission: 1, ior: 1.4, attenuationDistance: Infinity, dispersion: 2 }));
    expect(glass).toMatchObject({ transmission: 1, ior: 1.4, attenuationDistance: 0, dispersion: 2 });
    const lamp = pageMaterial(new THREE.MeshPhysicalMaterial({ emissive: 0xffffff, emissiveIntensity: 3 }));
    expect(lamp.emissive).toEqual([1, 1, 1]);
    expect(lamp.emissiveIntensity).toBe(3);
  });

  it("an orthographic camera becomes a far narrow one framing the same height", () => {
    const o = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 100);
    o.position.set(0, 0, 10);
    const c = nativeCamera(o, null);
    const dist = c.eye[2]! - 0;
    expect(Math.tan(THREE.MathUtils.degToRad(c.fov / 2)) * dist).toBeCloseTo(1 + Math.tan(THREE.MathUtils.degToRad(c.fov / 2)) * 10, 3);
  });
});
