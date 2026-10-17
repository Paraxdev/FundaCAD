// Appended to resolve.wgsl: the bloom adds to the linear colour before exposure,
// as three's tone mapping applies the exposure after the bloom.
struct B { w: u32, h: u32, pad0: u32, pad1: u32 }
@group(0) @binding(3) var<storage, read> glow: array<vec4f>;
@group(0) @binding(4) var<uniform> b: B;

fn glow_at(c: vec2i) -> vec3f {
  let q = clamp(c, vec2i(0), vec2i(i32(b.w) - 1, i32(b.h) - 1));
  return glow[u32(q.y) * b.w + u32(q.x)].rgb;
}

@compute @workgroup_size(8, 8)
fn main_bloom(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= r.w || id.y >= r.h) { return; }
  let i = id.y * r.w + id.x;
  let a = accum[i];
  let t = (vec2f(id.xy) + 0.5) / vec2f(f32(r.w), f32(r.h)) * vec2f(f32(b.w), f32(b.h)) - 0.5;
  let k = vec2i(floor(t));
  let f = t - floor(t);
  let g = mix(mix(glow_at(k), glow_at(k + vec2i(1, 0)), f.x), mix(glow_at(k + vec2i(0, 1)), glow_at(k + vec2i(1, 1)), f.x), f.y);
  let c = srgb(clamp(neutral((a.rgb / max(a.w, 1.0) + g) * r.exposure), vec3f(0.0), vec3f(1.0)));
  outp[i] = pack4x8unorm(vec4f(c, 1.0));
}
