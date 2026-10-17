// three's BloomNode on storage buffers: a high pass, five mips of separable
// Gaussian blur, each mip read from the previous one, and their weighted sum.
struct P {
  sw: u32, sh: u32, dw: u32, dh: u32,
  dir: vec2f, threshold: f32, strength: f32,
  radius: f32, kernel: u32, factor: f32, first: u32,
}
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;

fn texel(c: vec2i) -> vec3f {
  let q = clamp(c, vec2i(0), vec2i(i32(p.sw) - 1, i32(p.sh) - 1));
  return src[u32(q.y) * p.sw + u32(q.x)].rgb;
}

// A linear filtered, edge clamped fetch at `uv`.
fn tap(uv: vec2f) -> vec3f {
  let t = uv * vec2f(f32(p.sw), f32(p.sh)) - 0.5;
  let i = vec2i(floor(t));
  let f = t - floor(t);
  let top = mix(texel(i), texel(i + vec2i(1, 0)), f.x);
  let bottom = mix(texel(i + vec2i(0, 1)), texel(i + vec2i(1, 1)), f.x);
  return mix(top, bottom, f.y);
}

fn uv_of(id: vec3u) -> vec2f {
  return (vec2f(id.xy) + 0.5) / vec2f(f32(p.dw), f32(p.dh));
}

@compute @workgroup_size(8, 8)
fn high(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.dw || id.y >= p.dh) { return; }
  let q = min(vec2u(uv_of(id) * vec2f(f32(p.sw), f32(p.sh))), vec2u(p.sw - 1u, p.sh - 1u));
  let a = src[q.y * p.sw + q.x];
  let c = a.rgb / max(a.w, 1.0);
  let l = dot(c, vec3f(0.2126729, 0.7151522, 0.0721750));
  dst[id.y * p.dw + id.x] = vec4f(c * smoothstep(p.threshold, p.threshold + 0.01, l), 1.0);
}

@compute @workgroup_size(8, 8)
fn blur(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.dw || id.y >= p.dh) { return; }
  let uv = uv_of(id);
  let step = p.dir / vec2f(f32(p.dw), f32(p.dh));
  let sigma = f32(p.kernel) / 3.0;
  let coef = 0.39894 / sigma;
  var sum = tap(uv) * coef;
  for (var i = 1u; i < p.kernel; i += 2u) {
    let fa = f32(i);
    let wa = coef * exp(-0.5 * fa * fa / (sigma * sigma));
    let fb = fa + 1.0;
    let wb = select(0.0, coef * exp(-0.5 * fb * fb / (sigma * sigma)), i + 1u < p.kernel);
    let w = wa + wb;
    let off = step * ((fa * wa + fb * wb) / w);
    sum += (tap(uv + off) + tap(uv - off)) * w;
  }
  dst[id.y * p.dw + id.x] = vec4f(sum, 1.0);
}

@compute @workgroup_size(8, 8)
fn gather(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.dw || id.y >= p.dh) { return; }
  let i = id.y * p.dw + id.x;
  let c = tap(uv_of(id)) * mix(p.factor, 1.2 - p.factor, p.radius) * p.strength;
  dst[i] = select(dst[i] + vec4f(c, 0.0), vec4f(c, 1.0), p.first == 1u);
}
