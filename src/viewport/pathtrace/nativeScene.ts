// Feeds the native tracer (src-tauri/src/frames/tracer.rs) the scene the
// WebGPU tracer would get: the mirror meshes with their baked colours, face
// slots and traceMaterialFrom materials. A mesh crosses once per blasKey, so a
// move, a material or a look change sends JSON only.

import type { Denoise } from "../../ui/renderPrefs";
import * as THREE from "three";
import { blasKey, type TracedBody } from "./blasCache";
import type { TraceLens } from "./camera";
import type { TraceLook } from "./backend";
import { scaled, type LightRig } from "../lightRig";
import { heldHdr } from "../hdrRegistry";
import { hdrEnvironment } from "./environment";
import type { TraceBloomSettings } from "./tracePost";

export type Call = (cmd: string, args?: unknown) => Promise<unknown>;

type Physical = THREE.MeshPhysicalMaterial;

const rgb = (c: THREE.Color): [number, number, number] => [c.r, c.g, c.b];

/** PageMaterial in tracer/src/material.rs; colours stay linear. */
export function pageMaterial(m: THREE.Material) {
  const p = m as Physical;
  return {
    color: p.color ? rgb(p.color) : undefined,
    emissive: p.emissive ? rgb(p.emissive) : undefined,
    emissiveIntensity: p.emissiveIntensity,
    metalness: p.metalness,
    roughness: p.roughness,
    transmission: p.transmission,
    ior: p.ior,
    attenuationColor: p.attenuationColor ? rgb(p.attenuationColor) : undefined,
    attenuationDistance: Number.isFinite(p.attenuationDistance) ? p.attenuationDistance : 0,
    dispersion: p.dispersion,
    specularColor: p.specularColor ? rgb(p.specularColor) : undefined,
    specularIntensity: p.specularIntensity,
    sheen: p.sheen,
    sheenColor: p.sheenColor ? rgb(p.sheenColor) : undefined,
    sheenRoughness: p.sheenRoughness,
    clearcoat: p.clearcoat,
    clearcoatRoughness: p.clearcoatRoughness,
    opacity: m.opacity,
    vertexColors: m.vertexColors,
    // Set by pathtrace/materials.ts on a glow that should light nothing.
    ...(m.userData.noLight === true ? { noLight: true } : {}),
  };
}

interface Owner {
  id?: string;
}

function bodyOf(m: THREE.Mesh) {
  m.updateWorldMatrix(true, false);
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const traced = m.userData.traced as TracedBody | undefined;
  return {
    id: traced?.id ?? (m.userData.owner as Owner | undefined)?.id ?? m.uuid,
    key: traced?.key ?? blasKey(m),
    matrix: Array.from(m.matrixWorld.elements),
    visible: m.visible,
    materials: mats.map(pageMaterial),
  };
}

function floats3(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  if (a instanceof THREE.BufferAttribute && a.array instanceof Float32Array && a.itemSize === 3) return a.array;
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) {
    out[i * 3] = a.getX(i);
    out[i * 3 + 1] = a.getY(i);
    out[i * 3 + 2] = a.getZ(i);
  }
  return out;
}

/** [u32 header length][JSON][pad to 4][buffers], tracer/src/wire.rs. */
export function frame(header: object, parts: ArrayBufferView[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const start = (4 + json.length + 3) & ~3;
  const size = parts.reduce((n, p) => n + p.byteLength, start);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  let at = start;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
    at += p.byteLength;
  }
  return out;
}

function colorsOf(g: THREE.BufferGeometry): Float32Array | null {
  const c = g.getAttribute("color");
  return c ? floats3(c) : null;
}

function colorVersion(g: THREE.BufferGeometry): number {
  const c = g.getAttribute("color");
  return c instanceof THREE.BufferAttribute ? c.version : c ? 0 : -1;
}

export function meshFrame(key: string, m: THREE.Mesh): Uint8Array {
  const g = m.geometry;
  const pos = floats3(g.getAttribute("position"));
  const nrm = g.getAttribute("normal");
  const normals = nrm ? floats3(nrm) : null;
  const index = g.index ? Uint32Array.from(g.index.array as ArrayLike<number>) : null;
  const colors = colorsOf(g);
  const groups = g.groups.map((x) => ({ start: x.start, count: x.count, slot: x.materialIndex ?? 0 }));
  const header = {
    key,
    vertices: pos.length / 3,
    indices: index?.length ?? 0,
    normals: !!normals,
    colors: !!colors,
    groups,
  };
  return frame(
    header,
    [pos, normals, index, colors].filter((p): p is Float32Array => !!p),
  );
}

/** The most lights the native tracer takes, MAX_LIGHTS in tracer/src/gpu/mod.rs. */
export const NATIVE_LIGHTS = 4;

export interface NativeLight {
  direction: [number, number, number];
  /** Linear, times the light's intensity at the rig's brightness. */
  color: [number, number, number];
  angularRadius: number;
}

export function nativeLights(rig: LightRig): NativeLight[] {
  return rig.lights
    .filter((l) => !l.realtimeOnly)
    .slice(0, NATIVE_LIGHTS)
    .map((l) => ({
      direction: [l.direction[0], l.direction[1], l.direction[2]],
      color: rgb(new THREE.Color(l.colour).multiplyScalar(scaled(rig, l.intensity))),
      angularRadius: l.angularRadius,
    }));
}

/** Look in tracer/src/gpu/mod.rs. The environment goes separately (envFrame);
 *  the sky gradient only lights a native side that has none. Lights come from
 *  the rig; the strongest scene light as the sun stays for a native side
 *  without `lights`. */
export function nativeLook(look: TraceLook) {
  const bg = rgb(look.background);
  const sun = [...look.lights].sort((a, b) => b.intensity - a.intensity)[0];
  const dir = sun ? sun.position.clone().sub(sun.target).normalize() : new THREE.Vector3();
  return {
    skyTop: bg,
    skyBottom: bg,
    envIntensity: look.brightness,
    sunDir: dir.toArray(),
    sunColor: sun ? rgb(sun.color.clone().multiplyScalar(sun.intensity)) : [0, 0, 0],
    exposure: look.exposure,
    background: bg,
    environmentBehind: !!look.environmentBehind,
    ...(look.rig ? { lights: nativeLights(look.rig), ground: nativeGround(look.rig) } : {}),
  };
}

/** The catcher Realtime draws, which the tracer shows as a shadow on the background. */
export function nativeGround(rig: LightRig) {
  const g = rig.ground;
  return { mode: g.mode, z: g.z, centre: [g.centre[0], g.centre[1]], extent: g.extent, albedo: g.albedo };
}

/** The pt_env body for `look`'s environment: an imported panorama's own pixels
 *  ("z" layout) when it is held, else the room equirect traceEnvironment read
 *  back ("y" layout, rows as read, bottom first). Built only when sent. */
export function envFrame(look: TraceLook): { key: string; bytes(): Uint8Array } | null {
  const hdr = look.hdr;
  const held = hdr ? heldHdr(hdr.hash) : null;
  if (hdr && held) {
    const { width, height } = held.light;
    return {
      key: hdr.key,
      bytes: () =>
        frame({ key: hdr.key, width, height, up: "z" }, [
          hdrEnvironment(held.light, hdr.rotation, hdr.exposure, hdr.hemi),
        ]),
    };
  }
  const tex = look.environment as THREE.DataTexture;
  const data = tex.image?.data;
  if (!(data instanceof Uint16Array)) return null;
  const { width, height } = tex.image;
  const key = String(tex.userData?.envKey ?? tex.uuid);
  return { key, bytes: () => frame({ key, width, height, up: "y" }, [data]) };
}

/** The camera as the native tracer takes it: an orthographic one keeps its
 *  eye and sends the half height it frames, a perspective one its field of view
 *  and the lens, which an orthographic one never gets, as in the Realtime bokeh. */
export function nativeCamera(camera: THREE.Camera, lens: TraceLens | null) {
  camera.updateMatrixWorld();
  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const q = camera.getWorldQuaternion(new THREE.Quaternion());
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  let fov = 50;
  let ortho: { halfHeight: number } | null = null;
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) fov = (camera as THREE.PerspectiveCamera).fov;
  else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const o = camera as THREE.OrthographicCamera;
    ortho = { halfHeight: (o.top - o.bottom) / o.zoom / 2 };
    // The tracer frames around the eye, an off centre frustum moves it.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    eye.addScaledVector(right, (o.left + o.right) / 2 / o.zoom).addScaledVector(up, (o.top + o.bottom) / 2 / o.zoom);
  }
  return {
    eye: eye.toArray(),
    target: eye.clone().add(dir).toArray(),
    up: up.toArray(),
    fov,
    ortho,
    lens: ortho ? null : lens,
  };
}

export class NativeScene {
  private meshes: THREE.Mesh[] = [];
  private colorVersions = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private pendingLook: { look: ReturnType<typeof nativeLook>; env: ReturnType<typeof envFrame> } | null = null;
  private lookJob: Promise<unknown> = Promise.resolve();
  private pendingCamera: ReturnType<typeof nativeCamera> | null = null;
  private cameraJob: Promise<unknown> = Promise.resolve();

  constructor(
    private call: Call,
    private onError: (e: unknown) => void,
  ) {}

  /** Calls run one after another in the order they were made. */
  private queue(f: () => Promise<unknown>): Promise<unknown> {
    this.chain = this.chain.then(f).catch(this.onError);
    return this.chain;
  }

  idle(): Promise<unknown> {
    return this.chain;
  }

  setMeshes(meshes: THREE.Mesh[]) {
    this.meshes = meshes;
    const bodies = meshes.map(bodyOf);
    const byKey = new Map(bodies.map((b, i) => [b.key, meshes[i]!]));
    const colored = bodies.map((b, i) => [b.key, meshes[i]!] as const);
    return this.queue(async () => {
      const missing = (await this.call("pt_scene", { bodies })) as string[];
      const sent = new Set(missing);
      for (const key of missing) {
        const m = byKey.get(key);
        if (!m) continue;
        await this.call("pt_mesh", meshFrame(key, m));
        this.colorVersions.set(key, colorVersion(m.geometry));
      }
      for (const [key, m] of colored) {
        const v = colorVersion(m.geometry);
        if (sent.has(key) || this.colorVersions.get(key) === v) continue;
        const colors = colorsOf(m.geometry);
        const header = { key, vertices: colors ? colors.length / 3 : 0, colors: !!colors };
        await this.call("pt_colors", frame(header, colors ? [colors] : []));
        this.colorVersions.set(key, v);
      }
    });
  }

  /** Matrices, visibility or materials changed on the same meshes. */
  refresh() {
    const bodies = this.meshes.map(bodyOf);
    return this.queue(() => this.call("pt_scene", { bodies }));
  }

  /** pt_look answers the environment the native side holds, which a fresh
   *  tracer has lost, so pt_env goes only when that is not this one. A look
   *  made while an earlier one still waits in the queue replaces it, so a run
   *  of HDR rotations sends one 4 MB pt_env per round trip, not one per step. */
  look(look: TraceLook) {
    const waiting = this.pendingLook !== null;
    this.pendingLook = { look: nativeLook(look), env: envFrame(look) };
    if (waiting) return this.lookJob;
    this.lookJob = this.queue(async () => {
      const { look: l, env } = this.pendingLook!;
      this.pendingLook = null;
      const held = await this.call("pt_look", { look: l });
      if (env && held !== env.key) await this.call("pt_env", env.bytes());
    });
    return this.lookJob;
  }

  /** Like look, only the newest camera waits: the page moves the camera every
   *  display frame, faster than a native side that answers between frames. */
  camera(camera: THREE.Camera, lens: TraceLens | null) {
    const waiting = this.pendingCamera !== null;
    this.pendingCamera = nativeCamera(camera, lens);
    if (waiting) return this.cameraJob;
    this.cameraJob = this.queue(() => {
      const c = this.pendingCamera!;
      this.pendingCamera = null;
      return this.call("pt_camera", { camera: c });
    });
    return this.cameraJob;
  }

  cap(samples: number) {
    return this.queue(() => this.call("pt_cap", { cap: Math.max(1, Math.floor(samples)) }));
  }

  denoise(level: Denoise) {
    return this.queue(() => this.call("pt_denoise", { level }));
  }

  /** `side` is the long side of the bloom's input, as TraceBloom sizes it. */
  bloom(b: (TraceBloomSettings & { side: number }) | null) {
    return this.queue(() => this.call("pt_bloom", { bloom: b }));
  }

  budget(paths: number) {
    return this.queue(() => this.call("pt_budget", { paths: Math.max(1, Math.floor(paths)) }));
  }
}
