// The edge aware a-trous filter that cleans the image while samples are still
// coming in. Five passes of a 5x5 B3 spline kernel at steps 1 to 16, on the
// colour divided by albedo, weighted by normal, depth and luminance. The pure
// half below is the spec the WGSL follows, and what the tests run.

import type * as THREE from "three";

export const ATROUS_STEPS = [1, 2, 4, 8, 16] as const;
const KERNEL = [3 / 8, 1 / 4, 1 / 16] as const;
const NORMAL_POWER = 64;
/** Depth difference allowed per pixel of offset, relative to the depth. */
const DEPTH_SIGMA = 0.02;
/** The depth allowance stops growing past this many pixels of offset, or the
 *  wide passes would blur across a step between two parts. */
const DEPTH_REACH = 8;
const LUMA_SIGMA = 4;
/** Neighbours further apart in depth than this, relative to it, make a pixel
 *  a silhouette. */
const EDGE_DEPTH = 0.05;
/** Below this albedo (black paint, glass, the background) the colour is
 *  filtered as it is instead of divided by a near zero albedo. */
const MIN_ALBEDO = 0.02;
/** At this sample count the filter is drawn in full, by the cap not at all. */
const FULL_UNTIL = 16;

/** The luminance stop shrinks as the noise does, 1/sqrt(spp). */
export function atrousSigma(spp: number): number {
  return LUMA_SIGMA / Math.sqrt(Math.max(1, spp));
}

/** How much of the filtered image is drawn over the raw one. */
export function filterMix(spp: number, cap: number): number {
  if (spp <= FULL_UNTIL) return 1;
  if (spp >= cap) return 0;
  return 1 - Math.log2(spp / FULL_UNTIL) / Math.log2(cap / FULL_UNTIL);
}

/** One channel set per pixel, row major. Normals in -1..1, depth 0 where no
 *  surface was drawn. */
export interface AtrousImage {
  width: number;
  height: number;
  color: Float32Array;
  albedo: Float32Array;
  normal: Float32Array;
  depth: Float32Array;
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function albedoAt(a: Float32Array, i: number): [number, number, number] {
  const r = a[i * 3]!,
    g = a[i * 3 + 1]!,
    b = a[i * 3 + 2]!;
  if ((r + g + b) / 3 <= MIN_ALBEDO) return [1, 1, 1];
  return [Math.max(r, MIN_ALBEDO), Math.max(g, MIN_ALBEDO), Math.max(b, MIN_ALBEDO)];
}

/** A pixel is filtered only when it and its eight neighbours are surface at
 *  about the same depth. A silhouette pixel holds the traced mix of the body
 *  and what is behind it while the raster guide says all body, so it and
 *  anything the guide marks as not a surface (background, glass) stay as
 *  traced and lend nothing to their neighbours. */
export function atrousTrust(img: AtrousImage): Uint8Array {
  const { width: w, height: h, depth } = img;
  const trust = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const zp = depth[p]!;
      let ok = zp > 0;
      for (let j = -1; j <= 1 && ok; j++)
        for (let i = -1; i <= 1 && ok; i++) {
          const zq = depth[Math.min(h - 1, Math.max(0, y + j)) * w + Math.min(w - 1, Math.max(0, x + i))]!;
          ok = zq > 0 && Math.abs(zp - zq) <= EDGE_DEPTH * Math.min(zp, zq);
        }
      trust[p] = ok ? 1 : 0;
    }
  return trust;
}

/** The CPU reference of all five passes, demodulated in the first and
 *  remodulated after the last, exactly as the WGSL does it. */
export function atrousCpu(img: AtrousImage, spp: number): Float32Array {
  const { width: w, height: h, normal, depth, albedo } = img;
  const sigma = atrousSigma(spp);
  const trust = atrousTrust(img);
  let cur = new Float32Array(img.color);
  for (let i = 0; i < w * h; i++) {
    if (!trust[i]) continue;
    const a = albedoAt(albedo, i);
    for (let k = 0; k < 3; k++) cur[i * 3 + k] = img.color[i * 3 + k]! / a[k]!;
  }
  for (const step of ATROUS_STEPS) {
    const next = new Float32Array(cur);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!trust[p]) continue;
        const zp = depth[p]!;
        const lp = luma(cur[p * 3]!, cur[p * 3 + 1]!, cur[p * 3 + 2]!);
        let sr = 0,
          sg = 0,
          sb = 0,
          ws = 0;
        for (let j = -2; j <= 2; j++)
          for (let i = -2; i <= 2; i++) {
            const qx = Math.min(w - 1, Math.max(0, x + i * step));
            const qy = Math.min(h - 1, Math.max(0, y + j * step));
            const q = qy * w + qx;
            if (!trust[q]) continue;
            const zq = depth[q]!;
            const dot =
              normal[p * 3]! * normal[q * 3]! +
              normal[p * 3 + 1]! * normal[q * 3 + 1]! +
              normal[p * 3 + 2]! * normal[q * 3 + 2]!;
            const wn = Math.max(dot, 0) ** NORMAL_POWER;
            const wz = Math.exp(
              -Math.abs(zp - zq) /
                (DEPTH_SIGMA * Math.min(zp, zq) * Math.min(step * Math.hypot(i, j), DEPTH_REACH) + 1e-4),
            );
            const lq = luma(cur[q * 3]!, cur[q * 3 + 1]!, cur[q * 3 + 2]!);
            const wl = Math.exp(-Math.abs(lp - lq) / ((Math.max(lp, lq) + 1e-3) * sigma));
            const wt = KERNEL[Math.abs(i)]! * KERNEL[Math.abs(j)]! * wn * wz * wl;
            sr += cur[q * 3]! * wt;
            sg += cur[q * 3 + 1]! * wt;
            sb += cur[q * 3 + 2]! * wt;
            ws += wt;
          }
        next[p * 3] = sr / ws;
        next[p * 3 + 1] = sg / ws;
        next[p * 3 + 2] = sb / ws;
      }
    cur = next;
  }
  for (let i = 0; i < w * h; i++) {
    if (!trust[i]) continue;
    const a = albedoAt(albedo, i);
    for (let k = 0; k < 3; k++) cur[i * 3 + k] = cur[i * 3 + k]! * a[k]!;
  }
  return cur;
}

// Pass 0 (step 0) demodulates and keeps the trust in alpha, the five filter
// passes carry it along, the last one remodulates.
const WGSL = /* wgsl */ `
struct Pass { step: i32, sigma: f32, first: u32, last: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var albedoTex: texture_2d<f32>;
@group(0) @binding(2) var guideTex: texture_2d<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> P: Pass;

const K = array<f32, 3>(${KERNEL.join(", ")});

fn albedoAt(c: vec2i) -> vec3f {
  let a = textureLoad(albedoTex, c, 0).rgb;
  if ((a.r + a.g + a.b) / 3.0 <= ${MIN_ALBEDO}) { return vec3f(1.0); }
  return max(a, vec3f(${MIN_ALBEDO}));
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn trusted(c: vec2i, dims: vec2i) -> bool {
  let zp = textureLoad(guideTex, c, 0).w;
  if (zp <= 0.0) { return false; }
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let zq = textureLoad(guideTex, clamp(c + vec2i(i, j), vec2i(0), dims - 1), 0).w;
      if (zq <= 0.0 || abs(zp - zq) > ${EDGE_DEPTH} * min(zp, zq)) { return false; }
    }
  }
  return true;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2i(textureDimensions(dst));
  let c = vec2i(gid.xy);
  if (c.x >= dims.x || c.y >= dims.y) { return; }
  if (P.step == 0) {
    let v = textureLoad(src, c, 0).rgb;
    if (trusted(c, dims)) { textureStore(dst, gid.xy, vec4f(v / albedoAt(c), 1.0)); }
    else { textureStore(dst, gid.xy, vec4f(v, 0.0)); }
    return;
  }
  let here = textureLoad(src, c, 0);
  var out = here.rgb;
  if (here.a > 0.5) {
    let g = textureLoad(guideTex, c, 0);
    let np = g.xyz * 2.0 - 1.0;
    let lp = luma(out);
    var sum = vec3f(0.0);
    var ws = 0.0;
    for (var j = -2; j <= 2; j++) {
      for (var i = -2; i <= 2; i++) {
        let q = clamp(c + vec2i(i, j) * P.step, vec2i(0), dims - 1);
        let cq = textureLoad(src, q, 0);
        if (cq.a < 0.5) { continue; }
        let gq = textureLoad(guideTex, q, 0);
        let wn = pow(max(dot(np, gq.xyz * 2.0 - 1.0), 0.0), ${NORMAL_POWER}.0);
        let wz = exp(-abs(g.w - gq.w) / (${DEPTH_SIGMA} * min(g.w, gq.w) * min(f32(P.step) * length(vec2f(f32(i), f32(j))), ${DEPTH_REACH}.0) + 1e-4));
        let lq = luma(cq.rgb);
        let wl = exp(-abs(lp - lq) / ((max(lp, lq) + 1e-3) * P.sigma));
        let wt = K[abs(i)] * K[abs(j)] * wn * wz * wl;
        sum += cq.rgb * wt;
        ws += wt;
      }
    }
    out = sum / max(ws, 1e-6);
    if (P.last == 1u) { out = out * albedoAt(c); }
  }
  // The blit reads alpha as coverage, so the last pass hands it a plain image.
  textureStore(dst, gid.xy, vec4f(out, select(here.a, 1.0, P.last == 1u)));
}
`;

// The few WebGPU shapes used here; the project carries no @webgpu/types.
interface GpuTexture {
  width: number;
  height: number;
  createView(): unknown;
  destroy(): void;
}
interface GpuBuffer {
  destroy(): void;
}
interface GpuPass {
  setPipeline(p: unknown): void;
  setBindGroup(i: number, g: unknown): void;
  dispatchWorkgroups(x: number, y: number): void;
  end(): void;
}
interface GpuDevice {
  createBindGroupLayout(d: unknown): unknown;
  createPipelineLayout(d: unknown): unknown;
  createComputePipeline(d: unknown): unknown;
  createShaderModule(d: { code: string }): unknown;
  createBuffer(d: { size: number; usage: number }): GpuBuffer;
  createTexture(d: unknown): GpuTexture;
  createBindGroup(d: unknown): unknown;
  createCommandEncoder(): { beginComputePass(): GpuPass; finish(): unknown };
  queue: { writeBuffer(b: GpuBuffer, offset: number, data: ArrayBuffer): void; submit(c: unknown[]): void };
}
const PASSES = [0, ...ATROUS_STEPS];
const SHADER_COMPUTE = 0x4;
const BUFFER_UNIFORM = 0x40;
const BUFFER_COPY_DST = 0x8;
const TEXTURE_BINDING = 0x4;
const TEXTURE_STORAGE = 0x8;

type Renderer = {
  backend: { device: GpuDevice; get(t: THREE.Texture): { texture?: GpuTexture } };
};

/** The GPU side, on the tracer's device. `run` returns the filtered image as a
 *  texture three can draw. */
export class AtrousFilter {
  private pipeline: unknown = null;
  private layout: unknown = null;
  private uniforms: GpuBuffer[] = [];
  private ping: GpuTexture[] = [];
  private outputs: THREE.Texture[] = [];

  constructor(
    private renderer: Renderer,
    private wrap: (t: GpuTexture, w: number, h: number) => THREE.Texture,
  ) {}

  private setup(device: GpuDevice) {
    const tex = (binding: number) => ({
      binding,
      visibility: SHADER_COMPUTE,
      texture: { sampleType: "unfilterable-float" },
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        tex(0),
        tex(1),
        tex(2),
        { binding: 3, visibility: SHADER_COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
        { binding: 4, visibility: SHADER_COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: "main" },
    });
    this.uniforms = PASSES.map(() => device.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DST }));
  }

  private targets(device: GpuDevice, w: number, h: number) {
    if (this.ping[0]?.width === w && this.ping[0]?.height === h) return;
    this.disposeTargets();
    for (let i = 0; i < 2; i++) {
      const t = device.createTexture({
        size: [w, h],
        format: "rgba16float",
        usage: TEXTURE_STORAGE | TEXTURE_BINDING,
      });
      this.ping.push(t);
      this.outputs.push(this.wrap(t, w, h));
    }
  }

  /** `guides` holds the albedo and the normal with view depth in alpha, both
   *  at the colour's size. */
  run(color: THREE.Texture, albedo: THREE.Texture, guide: THREE.Texture, spp: number): THREE.Texture | null {
    const b = this.renderer.backend;
    const src = b.get(color).texture;
    const alb = b.get(albedo).texture;
    const gd = b.get(guide).texture;
    if (!src || !alb || !gd) return null;
    const device = b.device;
    if (!this.pipeline) this.setup(device);
    this.targets(device, src.width, src.height);
    const sigma = atrousSigma(spp);
    const enc = device.createCommandEncoder();
    let input = src;
    PASSES.forEach((step, k) => {
      const out = this.ping[k % 2]!;
      const u = new ArrayBuffer(16);
      new Int32Array(u, 0, 1)[0] = step;
      new Float32Array(u, 4, 1)[0] = sigma;
      new Uint32Array(u, 8, 2).set([k === 0 ? 1 : 0, k === PASSES.length - 1 ? 1 : 0]);
      device.queue.writeBuffer(this.uniforms[k]!, 0, u);
      const group = device.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: input.createView() },
          { binding: 1, resource: alb.createView() },
          { binding: 2, resource: gd.createView() },
          { binding: 3, resource: out.createView() },
          { binding: 4, resource: { buffer: this.uniforms[k]! } },
        ],
      });
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(src.width / 8), Math.ceil(src.height / 8));
      pass.end();
      input = out;
    });
    device.queue.submit([enc.finish()]);
    return this.outputs[(PASSES.length - 1) % 2]!;
  }

  private disposeTargets() {
    for (const t of this.outputs) t.dispose();
    for (const t of this.ping) t.destroy();
    this.outputs = [];
    this.ping = [];
  }

  dispose() {
    this.disposeTargets();
    for (const u of this.uniforms) u.destroy();
    this.uniforms = [];
    this.pipeline = null;
  }
}
