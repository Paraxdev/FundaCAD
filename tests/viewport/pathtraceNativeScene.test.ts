import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BlasCache, mainThreadBuilder } from "../../src/viewport/pathtrace/blasCache";
import ENV_DIRECTIONS from "../fixtures/env_directions.json";
import {
  envFrame,
  meshFrame,
  NativeScene,
  nativeCamera,
  nativeLook,
  pageMaterial,
} from "../../src/viewport/pathtrace/nativeScene";
import {
  equirectDirection,
  halfEquirect,
  hdrEnvironment,
  hemiAt,
  type EnvLayout,
} from "../../src/viewport/pathtrace/environment";
import { registerHdr } from "../../src/viewport/hdrRegistry";
import { DEFAULT_RENDER, type Ground } from "../../src/ui/renderPrefs";
import {
  buildLightRig,
  FILL_INTENSITY,
  GROUND_ALBEDO,
  KEY_INTENSITY,
  SUN_ANGULAR_RADIUS,
  type GroundFloor,
  type RigLight,
} from "../../src/viewport/lightRig";
import { lookSignature } from "../../src/viewport/pathtrace/host";
import type { TraceLook } from "../../src/viewport/pathtrace/backend";

function body(id: string, etag: string, color?: boolean) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  if (color)
    g.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 3).fill(0.5), 3),
    );
  const mats = [
    new THREE.MeshPhysicalMaterial({ color: 0xff0000 }),
    new THREE.MeshPhysicalMaterial({ transmission: 1, ior: 1.4 }),
  ];
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
    const glass = pageMaterial(
      new THREE.MeshPhysicalMaterial({ transmission: 1, ior: 1.4, attenuationDistance: Infinity, dispersion: 2 }),
    );
    expect(glass).toMatchObject({ transmission: 1, ior: 1.4, attenuationDistance: 0, dispersion: 2 });
    const lamp = pageMaterial(new THREE.MeshPhysicalMaterial({ emissive: 0xffffff, emissiveIntensity: 3 }));
    expect(lamp.emissive).toEqual([1, 1, 1]);
    expect(lamp.emissiveIntensity).toBe(3);
  });

  it("a glow only material goes with noLight, any other without it", () => {
    const glow = new THREE.MeshPhysicalMaterial({ emissive: 0xffffff });
    glow.userData.noLight = true;
    expect(pageMaterial(glow).noLight).toBe(true);
    const lamp = new THREE.MeshPhysicalMaterial({ emissive: 0xffffff });
    lamp.userData.noLight = "yes";
    expect(pageMaterial(lamp)).not.toHaveProperty("noLight");
    expect(pageMaterial(new THREE.MeshPhysicalMaterial())).not.toHaveProperty("noLight");
  });

  it("a perspective camera goes with its field of view and the lens it is given", () => {
    const p = new THREE.PerspectiveCamera(35, 1.5, 0.1, 100);
    p.position.set(0, -10, 0);
    p.lookAt(0, 0, 0);
    const plain = nativeCamera(p, null);
    expect(plain.fov).toBe(35);
    expect(plain.ortho).toBeNull();
    expect(plain.lens).toBeNull();
    expect(plain.eye[1]).toBeCloseTo(-10, 6);
    const lens = { focusDistance: 10, apertureRadius: 0.25 };
    expect(nativeCamera(p, lens).lens).toEqual(lens);
  });

  it("an orthographic camera keeps its eye and sends the half height it frames", () => {
    const o = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 100);
    o.position.set(0, 0, 10);
    o.zoom = 2;
    const c = nativeCamera(o, { focusDistance: 10, apertureRadius: 0.25 });
    expect(c.eye[0]).toBeCloseTo(0, 6);
    expect(c.eye[1]).toBeCloseTo(0, 6);
    expect(c.eye[2]).toBeCloseTo(10, 6);
    expect(c.target[2]).toBeCloseTo(9, 6);
    expect(c.ortho).toEqual({ halfHeight: 0.5 });
    expect(c.lens).toBeNull();
  });

  it("an off centre orthographic frustum moves the eye to its centre", () => {
    const o = new THREE.OrthographicCamera(0, 4, 3, 1, 0.1, 100);
    o.position.set(0, 0, 10);
    const c = nativeCamera(o, null);
    expect(c.eye[0]).toBeCloseTo(2, 6);
    expect(c.eye[1]).toBeCloseTo(2, 6);
    expect(c.ortho).toEqual({ halfHeight: 1 });
  });
});

describe("native look", () => {
  const look = (brightness: number, extra: RigLight[] = []): TraceLook => {
    const rig = buildLightRig({ ...DEFAULT_RENDER, brightness }, () => false);
    rig.lights.push(...extra);
    return {
      lights: [],
      background: new THREE.Color(0.2, 0.3, 0.4),
      environment: new THREE.Texture(),
      brightness,
      toneMapping: THREE.NeutralToneMapping,
      exposure: 1,
      rig,
    };
  };
  const extra = (o: Partial<RigLight>): RigLight => ({
    role: "sun",
    direction: [0, 0, 1],
    colour: 0xffffff,
    intensity: 1,
    angularRadius: 2,
    realtimeOnly: false,
    ...o,
  });

  it("sends the rig's key and fill with brightness applied once and the background", () => {
    const l = nativeLook(look(1.5));
    const rig = look(1.5).rig!;
    expect(l.lights).toHaveLength(2);
    expect(l.lights![0]!.direction).toEqual(rig.lights[0]!.direction);
    expect(l.lights![0]!.color[0]).toBeCloseTo(KEY_INTENSITY * 1.5, 6);
    expect(l.lights![1]!.color[1]).toBeCloseTo(FILL_INTENSITY * 1.5, 6);
    expect(l.lights![0]!.angularRadius).toBe(SUN_ANGULAR_RADIUS);
    expect(l.background).toEqual([0.2, 0.3, 0.4]);
    // A native side without lights still traces from these.
    expect(l.skyTop).toEqual([0.2, 0.3, 0.4]);
    expect(l.envIntensity).toBe(1.5);
  });

  it("takes an sRGB colour to linear and skips a Realtime only light", () => {
    const l = nativeLook(
      look(1, [extra({ colour: 0x808080, realtimeOnly: true }), extra({ colour: 0x808080, angularRadius: 3 })]),
    );
    expect(l.lights).toHaveLength(3);
    const grey = l.lights![2]!;
    expect(grey.color[0]).toBeCloseTo(0.2159, 4);
    expect(grey.angularRadius).toBe(3);
  });

  it("sends at most four lights", () => {
    const more = [1, 2, 3, 4].map((i) => extra({ intensity: i }));
    expect(nativeLook(look(1, more)).lights).toHaveLength(4);
  });

  it("a look without a rig sends no lights", () => {
    const { rig: _, ...bare } = look(1);
    expect(nativeLook(bare).lights).toBeUndefined();
    expect(nativeLook(bare).ground).toBeUndefined();
  });

  it("sends the catcher Realtime draws as the ground, none by default", () => {
    const floor = { workspace: "model" as const, z: 0.5, centre: [1, 2] as [number, number], extent: 3.2 };
    const shadow = { ...look(1), rig: buildLightRig({ ...DEFAULT_RENDER, groundModel: "shadow" }, () => false, floor) };
    expect(nativeLook(shadow).ground).toEqual({
      mode: "shadow",
      z: 0.5,
      centre: [1, 2],
      extent: 3.2,
      albedo: GROUND_ALBEDO,
    });
    expect(nativeLook(look(1)).ground!.mode).toBe("none");
  });

  it("a new ground mode, height, centre or size sends the look again", () => {
    const same = look(1);
    const at = (groundModel: Ground, floor: GroundFloor) =>
      lookSignature({ ...same, rig: buildLightRig({ ...DEFAULT_RENDER, groundModel }, () => false, floor) });
    const floor: GroundFloor = { workspace: "model", z: 0, centre: [0, 0], extent: 2 };
    const base = at("shadow", floor);
    expect(at("shadow", { ...floor })).toBe(base);
    for (const other of [
      at("none", floor),
      at("shadow", { ...floor, z: 1 }),
      at("shadow", { ...floor, centre: [0, 1] }),
      at("shadow", { ...floor, extent: 3 }),
    ]) {
      expect(other).not.toBe(base);
    }
  });
});

describe("native environment", () => {
  const header = (b: Uint8Array) => {
    const len = new DataView(b.buffer, b.byteOffset).getUint32(0, true);
    return { head: JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + len))), body: b.subarray((4 + len + 3) & ~3) };
  };
  const roomLook = (key: string): TraceLook => {
    const tex = halfEquirect(new Uint16Array(4 * 2 * 4), 4, 2);
    tex.userData.envKey = key;
    return {
      lights: [],
      background: new THREE.Color(),
      environment: tex,
      brightness: 1,
      toneMapping: THREE.NeutralToneMapping,
      exposure: 1,
    };
  };
  const native = () => {
    let held: string | null = null;
    const sent: string[] = [];
    const call = async (cmd: string, args?: unknown) => {
      if (cmd === "pt_look") return held;
      if (cmd === "pt_env") {
        held = header(args as Uint8Array).head.key;
        sent.push(held!);
      }
      return null;
    };
    return {
      scene: new NativeScene(call, (e) => {
        throw e;
      }),
      sent,
      lose: () => {
        held = null;
      },
    };
  };

  it("sends a room once per key and again to a tracer that lost it", async () => {
    const n = native();
    await n.scene.look(roomLook("studio|h1"));
    await n.scene.look(roomLook("studio|h1"));
    expect(n.sent).toEqual(["studio|h1"]);
    await n.scene.look(roomLook("neutral|h1"));
    expect(n.sent).toEqual(["studio|h1", "neutral|h1"]);
    n.lose();
    await n.scene.look(roomLook("neutral|h1"));
    expect(n.sent).toEqual(["studio|h1", "neutral|h1", "neutral|h1"]);
  });

  it("a room goes as traceEnvironment read it back, in the y layout", () => {
    const f = envFrame(roomLook("k"))!;
    const { head, body } = header(f.bytes());
    expect(head).toEqual({ key: "k", width: 4, height: 2, up: "y" });
    expect(body.byteLength).toBe(4 * 2 * 4 * 2);
  });

  it("maps texels to directions as the fixture the tracer reads", () => {
    const doc = ENV_DIRECTIONS as { pairs: { layout: EnvLayout; u: number; v: number; dir: number[] }[] };
    expect(doc.pairs.length).toBeGreaterThanOrEqual(8);
    for (const p of doc.pairs) {
      const d = equirectDirection(p.layout, p.u, p.v);
      for (let k = 0; k < 3; k++) expect(d[k]).toBeCloseTo(p.dir[k]!, 6);
    }
  });

  it("an HDR goes as its pixels, turned by columns, with the exposure and the hemisphere", () => {
    const w = 4,
      h = 2;
    const data = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([i, 0, 0, 1], i * 4);
    const hemi = {
      sky: new THREE.Color(1, 1, 1),
      ground: new THREE.Color(0, 0, 0),
      intensity: Math.PI,
      up: new THREE.Vector3(0, 0, 1),
    };
    const out = hdrEnvironment({ width: w, height: h, data }, 90, 1, hemi);
    const at = (c: number, r: number, k: number) => THREE.DataUtils.fromHalfFloat(out[(r * w + c) * 4 + k]!);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        // 90 degrees is one column of four: texel c shows what column c + 1 held.
        const hm = hemiAt(equirectDirection("z", (c + 0.5) / w, (r + 0.5) / h), hemi);
        expect(at(c, r, 0)).toBeCloseTo((r * w + ((c + 1) % w)) * 2 + hm[0], 1);
        expect(at(c, r, 1)).toBeCloseTo(hm[1], 3);
      }
    }
    // Row 0 is the upper half, so it gets more of the sky: mix(ground, sky, up / 2 + 1/2).
    expect(at(0, 0, 1)).toBeCloseTo(0.5 + 0.5 * Math.cos(Math.PI / 4), 3);
    expect(at(0, 1, 1)).toBeCloseTo(0.5 - 0.5 * Math.cos(Math.PI / 4), 3);
  });

  it("the hemisphere term is FRAGMENT's: sky above, ground below, the horizon halfway", () => {
    const hemi = {
      sky: new THREE.Color(0.654, 0.654, 0.654),
      ground: new THREE.Color(0.0172, 0.0172, 0.0172),
      intensity: 0.6,
      up: new THREE.Vector3(0, 0, 2),
    };
    expect(hemiAt([0, 0, 1], hemi)[0]).toBeCloseTo((0.654 * 0.6) / Math.PI, 6);
    expect(hemiAt([0, 0, -1], hemi)[0]).toBeCloseTo((0.0172 * 0.6) / Math.PI, 6);
    expect(hemiAt([1, 0, 0], hemi)[0]).toBeCloseTo((((0.654 + 0.0172) / 2) * 0.6) / Math.PI, 6);
  });

  it("looks queued behind a slow pt_env collapse into the newest one", async () => {
    let held: string | null = null;
    const sent: string[] = [];
    let looks = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const first = new Promise<void>((r) => {
      entered = r;
    });
    const call = async (cmd: string, args?: unknown) => {
      if (cmd === "pt_look") {
        looks++;
        return held;
      }
      if (cmd === "pt_env") {
        const key = header(args as Uint8Array).head.key;
        sent.push(key);
        if (sent.length === 1) {
          entered();
          await gate;
        }
        held = key;
      }
      return null;
    };
    const scene = new NativeScene(call, (e) => {
      throw e;
    });
    const done = [scene.look(roomLook("r1"))];
    await first;
    done.push(scene.look(roomLook("r2")), scene.look(roomLook("r3")));
    release();
    await Promise.all(done);
    await scene.idle();
    expect(sent).toEqual(["r1", "r3"]);
    expect(looks).toBe(2);
  });

  it("cameras queued behind a slow call collapse into the newest, and each caller gets the reply of the call that carried it", async () => {
    const sent: number[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const first = new Promise<void>((r) => {
      entered = r;
    });
    const call = async (cmd: string, args?: unknown) => {
      if (cmd === "pt_scene") {
        entered();
        await gate;
        return [];
      }
      if (cmd !== "pt_camera") return null;
      sent.push((args as { camera: { eye: number[] } }).camera.eye);
      return 40 + sent.length;
    };
    const at = (x: number) => {
      const c = new THREE.PerspectiveCamera(40, 1.3, 0.1, 100);
      c.position.set(x, -7.5, 3.25);
      c.lookAt(1.5, 2, -0.5);
      return c;
    };
    const scene = new NativeScene(call, (e) => {
      throw e;
    });
    const alone = scene.camera(at(-4), null);
    expect(await alone).toBe(41);
    void scene.setMeshes([]);
    await first;
    const merged = [scene.camera(at(1), null), scene.camera(at(2.5), null), scene.camera(at(6), null)];
    release();
    expect(await Promise.all(merged)).toEqual([42, 42, 42]);
    const after = scene.camera(at(9), null);
    expect(await after).toBe(43);
    await scene.idle();
    expect(sent.map((e) => e[0])).toEqual([-4, 6, 9]);
  });

  it("an HDR look sends the panorama's key with its pixels", async () => {
    registerHdr("abc", "sky.hdr", { width: 8, height: 4, data: new Float32Array(8 * 4 * 4).fill(1) });
    const look = {
      ...roomLook("room"),
      hdr: { hash: "abc", rotation: 0, exposure: 0, hemi: null, key: "hdr:abc|0.0|0.00|" },
    };
    const { head } = header(envFrame(look)!.bytes());
    expect(head.up).toBe("z");
    expect(head.key).toBe("hdr:abc|0.0|0.00|");
  });
});
