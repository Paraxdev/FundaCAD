struct R { w: u32, h: u32, exposure: f32, pad: u32 }
@group(0) @binding(0) var<uniform> r: R;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;

// Khronos PBR Neutral.
fn neutral(c0: vec3f) -> vec3f {
  let start = 0.8 - 0.04;
  let x = min(c0.r, min(c0.g, c0.b));
  let off = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = c0 - off;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) { return c; }
  let d = 1.0 - start;
  let np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  let g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
  return mix(c, vec3f(np), g);
}
fn srgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= r.w || id.y >= r.h) { return; }
  let i = id.y * r.w + id.x;
  let a = accum[i];
  let c = srgb(clamp(neutral(a.rgb / max(a.w, 1.0) * r.exposure), vec3f(0.0), vec3f(1.0)));
  outp[i] = pack4x8unorm(vec4f(c, 1.0));
}
