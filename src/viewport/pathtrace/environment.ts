// The room the model reflects, as the equirect the tracer samples. Rendered by
// the viewport's WebGL renderer into a cube and unwrapped on the GPU, then read
// back so the tracer's own device can take it as plain data.

import * as THREE from "three";
import type { HdrImage } from "../hdrImage";

/** The viewport's hemisphere light, which the tracer has no light for: folded
 *  into the environment, sky above `up`, ground below. */
export interface TraceHemi {
  sky: THREE.Color;
  ground: THREE.Color;
  /** Without the brightness, which the tracer applies to the whole environment. */
  intensity: number;
  up: THREE.Vector3;
}

const WIDTH = 512;
const HEIGHT = 256;
const CUBE = 256;

// The direction for a texel is the tracer's own equirectUvToDirection, so the
// readback rows land where it samples them.
const FRAGMENT = /* glsl */ `
uniform samplerCube uCube;
uniform float uHasCube;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uUp;
varying vec2 vUv;
const float PI = 3.141592653589793;
void main() {
  float theta = (vUv.x - 0.5) * 2.0 * PI;
  float phi = (1.0 - vUv.y) * PI;
  vec3 dir = vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
  vec3 room = uHasCube > 0.5 ? textureCube(uCube, dir).rgb : vec3(0.0);
  float t = dot(dir, uUp) * 0.5 + 0.5;
  gl_FragColor = vec4(room + mix(uGround, uSky, t), 1.0);
}`;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

let held: { key: string; tex: THREE.DataTexture } | null = null;

export function hemiKey(h: TraceHemi | null): string {
  if (!h) return "";
  return [
    h.sky.getHex(),
    h.ground.getHex(),
    h.intensity.toFixed(4),
    h.up
      .toArray()
      .map((v) => v.toFixed(3))
      .join(","),
  ].join(":");
}

/** A hemisphere light of irradiance I * colour equals an environment of
 *  radiance I * colour / PI over its half of the sphere. */
function hemiRadiance(c: THREE.Color, h: TraceHemi | null): THREE.Vector3 {
  const k = h ? h.intensity / Math.PI : 0;
  return new THREE.Vector3(c.r * k, c.g * k, c.b * k);
}

/** Built for one `key` at a time; the previous one is let go. */
export function traceEnvironment(
  renderer: THREE.WebGLRenderer,
  key: string,
  room: (() => { scene: THREE.Scene; dispose(): void }) | null,
  hemi: TraceHemi | null,
): THREE.DataTexture {
  const full = `${key}|${hemiKey(hemi)}`;
  if (held?.key === full) return held.tex;
  const cubeTarget = new THREE.WebGLCubeRenderTarget(CUBE, { type: THREE.HalfFloatType });
  const flat = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { type: THREE.FloatType, depthBuffer: false });
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uCube: { value: cubeTarget.texture },
        uHasCube: { value: room ? 1 : 0 },
        uSky: { value: hemiRadiance(hemi?.sky ?? new THREE.Color(), hemi) },
        uGround: { value: hemiRadiance(hemi?.ground ?? new THREE.Color(), hemi) },
        uUp: { value: (hemi?.up ?? new THREE.Vector3(0, 0, 1)).clone().normalize() },
      },
      depthTest: false,
      depthWrite: false,
    }),
  );
  const was = {
    target: renderer.getRenderTarget(),
    toneMapping: renderer.toneMapping,
    autoClear: renderer.autoClear,
    clear: renderer.getClearColor(new THREE.Color()),
    alpha: renderer.getClearAlpha(),
  };
  const pixels = new Float32Array(WIDTH * HEIGHT * 4);
  try {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    if (room) {
      const r = room();
      new THREE.CubeCamera(0.1, 100, cubeTarget).update(renderer, r.scene);
      r.dispose();
    }
    const scene = new THREE.Scene();
    scene.add(quad);
    renderer.setRenderTarget(flat);
    renderer.render(scene, new THREE.Camera());
    renderer.readRenderTargetPixels(flat, 0, 0, WIDTH, HEIGHT, pixels);
  } finally {
    renderer.setRenderTarget(was.target);
    renderer.toneMapping = was.toneMapping;
    renderer.autoClear = was.autoClear;
    renderer.setClearColor(was.clear, was.alpha);
    cubeTarget.dispose();
    flat.dispose();
    quad.geometry.dispose();
    quad.material.dispose();
  }
  const half = new Uint16Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) half[i] = THREE.DataUtils.toHalfFloat(pixels[i]!);
  held?.tex.dispose();
  held = { key: full, tex: halfEquirect(half, WIDTH, HEIGHT) };
  held.tex.userData.envKey = full;
  return held.tex;
}

/** Half floats with a linear filter: Float32 data with a nearest filter makes
 *  the tracer gather zero samples without any error. */
export function halfEquirect(data: Uint16Array, w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const backgrounds = new Map<string, THREE.DataTexture>();

/** The background as a texture, not a colour: the tracer stores a colour
 *  background in 8 bit linear, which crushes a dark ground to black. */
export function backgroundTexture(c: THREE.Color): THREE.DataTexture {
  const key = [c.r, c.g, c.b].map((v) => v.toFixed(5)).join(",");
  const had = backgrounds.get(key);
  if (had) return had;
  if (backgrounds.size > 8) {
    for (const t of backgrounds.values()) t.dispose();
    backgrounds.clear();
  }
  const data = new Uint16Array(4 * 2 * 4);
  for (let i = 0; i < 8; i++) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(c.r);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(c.g);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(c.b);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const t = halfEquirect(data, 4, 2);
  backgrounds.set(key, t);
  return t;
}

/** How an equirect's rows lie in the world, tests/fixtures/env_directions.json:
 *  "y" the readback above, row 0 at -Y; "z" an HDR as hdrRoom places it, row 0
 *  at +Z, azimuth -2 pi u. v counts rows from row 0. */
export type EnvLayout = "y" | "z";

export function equirectDirection(layout: EnvLayout, u: number, v: number): [number, number, number] {
  if (layout === "y") {
    const phi = (1 - v) * Math.PI;
    const theta = (u - 0.5) * 2 * Math.PI;
    return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
  }
  const th = v * Math.PI;
  const az = -2 * Math.PI * u;
  return [Math.sin(th) * Math.cos(az), Math.sin(th) * Math.sin(az), Math.cos(th)];
}

/** FRAGMENT's hemisphere term along `dir`. */
export function hemiAt(dir: readonly number[], h: TraceHemi | null): [number, number, number] {
  if (!h) return [0, 0, 0];
  const up = h.up.clone().normalize();
  const t = (dir[0]! * up.x + dir[1]! * up.y + dir[2]! * up.z) * 0.5 + 0.5;
  const k = h.intensity / Math.PI;
  return [
    (h.ground.r + (h.sky.r - h.ground.r) * t) * k,
    (h.ground.g + (h.sky.g - h.ground.g) * t) * k,
    (h.ground.b + (h.sky.b - h.ground.b) * t) * k,
  ];
}

/** An imported panorama in the "z" layout, half float RGBA top row first:
 *  turned by `rotationDeg` as a column shift, times 2^exposure as hdrRoom
 *  bakes it, with the hemisphere added as FRAGMENT adds it to a room. */
export function hdrEnvironment(
  img: HdrImage,
  rotationDeg: number,
  exposure: number,
  hemi: TraceHemi | null,
): Uint16Array {
  const { width: w, height: h, data } = img;
  const gain = 2 ** exposure;
  const shift = ((((rotationDeg / 360) * w) % w) + w) % w;
  const c0 = Math.floor(shift);
  const f = shift - c0;
  const out = new Uint16Array(w * h * 4);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const a = (r * w + ((c + c0) % w)) * 4;
      const b = (r * w + ((c + c0 + 1) % w)) * 4;
      const hm = hemiAt(equirectDirection("z", (c + 0.5) / w, (r + 0.5) / h), hemi);
      const o = (r * w + c) * 4;
      for (let k = 0; k < 3; k++) {
        const v = (data[a + k]! * (1 - f) + data[b + k]! * f) * gain + hm[k]!;
        out[o + k] = THREE.DataUtils.toHalfFloat(Math.min(65504, v));
      }
      out[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  return out;
}
