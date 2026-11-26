// x, y: one texel along the blur direction in uv, z: sigma in texels, w: how far the kernel reaches in texels.
struct Params {
  kernel: vec4<f32>,
  // x, y: the target size in pixels, z: the saturation.
  area: vec4<f32>,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> p: Params;

struct Quad {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> Quad {
  let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Quad;
  out.clip = vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(xy.x, 1.0 - xy.y);
  return out;
}

@fragment
fn fs_down(in: Quad) -> @location(0) vec4<f32> {
  return textureSampleLevel(src, samp, in.uv, 0.0);
}

// Pairs of neighbouring taps share one bilinear fetch placed at their weighted centre.
@fragment
fn fs_gauss(in: Quad) -> @location(0) vec4<f32> {
  let dir = p.kernel.xy;
  let inv = 1.0 / (2.0 * p.kernel.z * p.kernel.z);
  var sum = textureSampleLevel(src, samp, in.uv, 0.0).rgb;
  var total = 1.0;
  var k = 1.0;
  loop {
    if (k > p.kernel.w) {
      break;
    }
    let w1 = exp(-k * k * inv);
    let w2 = exp(-(k + 1.0) * (k + 1.0) * inv);
    let w = w1 + w2;
    let o = dir * ((k * w1 + (k + 1.0) * w2) / w);
    sum += (textureSampleLevel(src, samp, in.uv + o, 0.0).rgb + textureSampleLevel(src, samp, in.uv - o, 0.0).rgb) * w;
    total += 2.0 * w;
    k += 2.0;
  }
  return vec4<f32>(sum / total, 1.0);
}

struct Panel {
  @builtin(position) clip: vec4<f32>,
  @location(0) @interpolate(flat) rect: vec4<f32>,
  @location(1) @interpolate(flat) radius: f32,
}

// One quad per panel, a pixel wider than the rect so its antialiased edge has room.
@vertex
fn vs_panel(
  @builtin(vertex_index) i: u32,
  @location(0) rect: vec4<f32>,
  @location(1) radius: f32,
) -> Panel {
  let corner = vec2<f32>(f32(i & 1u), f32((i >> 1u) & 1u));
  let px = rect.xy - 1.0 + corner * (rect.zw + 2.0);
  var out: Panel;
  out.clip = vec4<f32>(px.x / p.area.x * 2.0 - 1.0, 1.0 - px.y / p.area.y * 2.0, 0.0, 1.0);
  out.rect = rect;
  out.radius = radius;
  return out;
}

@fragment
fn fs_panel(in: Panel) -> @location(0) vec4<f32> {
  let half_size = in.rect.zw * 0.5;
  let r = min(in.radius, min(half_size.x, half_size.y));
  let q = abs(in.clip.xy - (in.rect.xy + half_size)) - half_size + r;
  var d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
  // The same squircle corner as GPUI's quads (squircle_corner_sdf in the fork's shaders.wgsl), so the frost fits its card.
  let o = max(q, vec2<f32>(0.0));
  let o2 = o * o;
  let n4 = o2.x * o2.x + o2.y * o2.y;
  let squareness = saturate((min(half_size.x, half_size.y) - in.radius - 2.0) / 1.5);
  if (squareness > 0.0 && n4 >= 1e-12) {
    let n = sqrt(sqrt(n4));
    d = mix(d, (n - r) / (sqrt(o2.x * o2.x * o2.x + o2.y * o2.y * o2.y) / (n * n * n)), squareness);
  }
  let coverage = clamp(0.5 - d, 0.0, 1.0);
  let c = textureSampleLevel(src, samp, in.clip.xy / p.area.xy, 0.0).rgb;
  // The saturate() matrix of CSS filters.
  let l = dot(c, vec3<f32>(0.213, 0.715, 0.072));
  let s = clamp(vec3<f32>(l) + (c - vec3<f32>(l)) * p.area.z, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(s, coverage);
}
