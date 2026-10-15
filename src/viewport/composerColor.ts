import * as THREE from "three";

/** The clear colour for the composer's offscreen target, linear in and out.
 *
 *  The canvas path never tone maps its clear, the composer's OutputPass tone maps
 *  everything in its target, the clear included. Clearing with the inverse of the
 *  tone mapper is what keeps the background the same colour with bloom on. */
export function composerClearColor(
  bg: THREE.Color,
  toneMapping: THREE.ToneMapping,
  exposure: number,
  out = new THREE.Color(),
): THREE.Color {
  if (toneMapping !== THREE.NeutralToneMapping) return out.copy(bg);
  const x = inverseNeutral([bg.r, bg.g, bg.b]);
  const e = exposure > 0 ? exposure : 1;
  return out.setRGB(x[0]! / e, x[1]! / e, x[2]! / e, THREE.LinearSRGBColorSpace);
}

/** The bloom threshold, raised above the composer's clear so the ground never
 *  blooms. A light ground cleared with the inverse of the tone mapper sits near
 *  or above the top of the slider's threshold. The weights are the high pass
 *  shader's `luminance`. */
export function thresholdAboveGround(threshold: number, clear: THREE.Color): number {
  const luma = 0.2126729 * clear.r + 0.7151522 * clear.g + 0.072175 * clear.b;
  return Math.max(threshold, luma + 0.05);
}

const START = 0.8 - 0.04;
const DESATURATION = 0.15;

/** three's NeutralToneMapping (the Khronos PBR Neutral), exposure already applied. */
export function neutralToneMap(c: readonly number[]): number[] {
  const x = Math.min(c[0]!, c[1]!, c[2]!);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  let col = c.map((v) => v - offset);
  const peak = Math.max(col[0]!, col[1]!, col[2]!);
  if (peak < START) return col;
  const d = 1 - START;
  const newPeak = 1 - (d * d) / (peak + d - START);
  col = col.map((v) => (v * newPeak) / peak);
  const g = 1 - 1 / (DESATURATION * (peak - newPeak) + 1);
  return col.map((v) => v * (1 - g) + newPeak * g);
}

function inverseNeutral(y: readonly number[]): number[] {
  let pre = y.map((v) => Math.max(0, v));
  const newPeak = Math.min(Math.max(pre[0]!, pre[1]!, pre[2]!), 0.999);
  if (newPeak >= START) {
    const d = 1 - START;
    const peak = (d * d) / (1 - newPeak) - d + START;
    const g = 1 - 1 / (DESATURATION * (peak - newPeak) + 1);
    pre = pre.map((v) => Math.max(0, (((Math.min(v, newPeak) - newPeak * g) / (1 - g)) * peak) / newPeak));
  }
  const m = Math.min(pre[0]!, pre[1]!, pre[2]!);
  const xm = m < 0.04 ? Math.sqrt(m / 6.25) : m + 0.04;
  return pre.map((v) => v + (xm - m));
}

let composing = false;
const ground = new THREE.Color();

/** Set by the PostChain around the composer's frame, with the clear colour (linear). */
export function setComposing(on: boolean, clear?: THREE.Color): void {
  composing = on;
  if (clear) ground.copy(clear);
}

/** For a ShaderMaterial that writes display colours straight to gl_FragColor,
 *  with no colour management: in the canvas path they reach the screen as they
 *  are, in the composer they are linear values the OutputPass tone maps and
 *  encodes. `displayColor` undoes both while the composer draws, so a grid or a
 *  glow looks the same with bloom on. `displayOverGround` also blends as the
 *  canvas does, in display space, which only holds over the clear colour: the
 *  composer blends in linear, and thin dark lines on a light ground came out
 *  lighter. */
export const DISPLAY_COLOR_GLSL = /* glsl */ `
uniform float uComposing;
uniform vec3 uGround;
vec3 composerLinear(vec3 c) {
  vec3 y = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  float top = min(max(y.r, max(y.g, y.b)), 0.999);
  if (top >= ${START}) {
    float d = 1.0 - ${START};
    float peak = d * d / (1.0 - top) - d + ${START};
    float g = 1.0 - 1.0 / (${DESATURATION} * (peak - top) + 1.0);
    y = max(vec3(0.0), (min(y, vec3(top)) - top * g) / (1.0 - g) * peak / top);
  }
  float m = min(y.r, min(y.g, y.b));
  float xm = m < 0.04 ? sqrt(m / 6.25) : m + 0.04;
  return y + (xm - m);
}
vec3 displayColor(vec3 c) {
  return uComposing < 0.5 ? c : composerLinear(c);
}
vec4 displayOverGround(vec3 c, float a) {
  if (uComposing < 0.5) return vec4(c, a);
  vec3 under = composerLinear(uGround);
  vec3 want = composerLinear(mix(uGround, c, a));
  // A linear blend needs more coverage than a display one to reach the same
  // shade, so the alpha is solved for too, weighted towards the channels that differ most.
  vec3 den = composerLinear(c) - under;
  float w = abs(den.r) + abs(den.g) + abs(den.b);
  float k = w > 1e-4 ? clamp(dot((want - under) * sign(den), vec3(1.0)) / w, 1e-4, 1.0) : max(a, 1e-4);
  return vec4(max(vec3(0.0), (want - (1.0 - k) * under) / k), k);
}
`;

export function displayColorUniforms(): { uComposing: { value: number }; uGround: { value: THREE.Color } } {
  return { uComposing: { value: 0 }, uGround: { value: new THREE.Color() } };
}

export function followComposer(mat: THREE.ShaderMaterial): void {
  const before = mat.onBeforeRender.bind(mat);
  const seen = new THREE.Color(-1, -1, -1);
  mat.onBeforeRender = (...args) => {
    before(...args);
    const u = mat.uniforms;
    const v = composing ? 1 : 0;
    if (!u.uComposing || !u.uGround) return;
    if (u.uComposing.value !== v || (composing && !seen.equals(ground))) {
      u.uComposing.value = v;
      seen.copy(ground);
      // The canvas shows the clear colour's sRGB numbers, uGround holds them as they are.
      (u.uGround.value as THREE.Color).copy(ground).convertLinearToSRGB();
      mat.uniformsNeedUpdate = true;
    }
  };
}
