// The room the model reflects, as the equirect the tracer samples. Rendered by
// the viewport's WebGL renderer into a cube and unwrapped on the GPU, then read
// back so the tracer's own device can take it as plain data.

import * as THREE from "three";

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
const FRAGMENT = /* glsl */`
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

const VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

let held: { key: string; tex: THREE.DataTexture } | null = null;

export function hemiKey(h: TraceHemi | null): string {
  if (!h) return "";
  return [h.sky.getHex(), h.ground.getHex(), h.intensity.toFixed(4), h.up.toArray().map((v) => v.toFixed(3)).join(",")].join(":");
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
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
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
  }));
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
