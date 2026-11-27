struct Uniforms {
  view_proj: mat4x4<f32>,
  eye: vec4<f32>,
  encode_srgb: vec4<f32>,
  clip: vec4<f32>,
  shade: vec4<f32>,
}

struct Body {
  offset: vec4<f32>,
  hover: vec4<i32>,
  fade: vec4<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var<uniform> body: Body;

struct Varying {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) @interpolate(flat) face: u32,
  @location(3) selected: f32,
}

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) face: u32,
  @location(3) mask: f32,
  @location(4) selected: vec2<f32>,
) -> Varying {
  var out: Varying;
  let world = position + body.offset.xyz * mask;
  out.clip = u.view_proj * vec4<f32>(world, 1.0);
  out.world = world;
  out.normal = normal;
  out.face = face;
  out.selected = mix(selected.x, selected.y, body.fade.z);
  return out;
}

fn hovered(base: vec3<f32>, hover: vec2<i32>, amount: f32, face: u32) -> vec3<f32> {
  if (hover.x < 0 || u32(hover.x) != face) {
    return base;
  }
  var tint = vec3<f32>(0.7, 0.72, 0.78);
  if (hover.y == 1) {
    tint = vec3<f32>(0.6, 0.62, 0.94);
  }
  return mix(base, tint, amount);
}

@fragment
fn fs(in: Varying) -> @location(0) vec4<f32> {
  let clipping = dot(u.clip.xyz, u.clip.xyz) > 0.0;
  if (clipping && dot(u.clip.xyz, in.world) > u.clip.w) {
    discard;
  }
  let raw = normalize(in.normal);
  var n = raw;
  let view_dir = normalize(u.eye.xyz - in.world);
  let inside = dot(n, view_dir) < 0.0;
  if (inside) {
    n = -n;
  }
  let key = normalize(vec3<f32>(0.4, -0.5, 0.8));
  let fill = normalize(vec3<f32>(-0.6, 0.4, 0.2));
  var base = vec3<f32>(0.62, 0.66, 0.72);
  if (dot(u.shade.xyz, u.shade.xyz) > 0.0) {
    // overhang::classify, the same rule the card's areas use.
    let c = dot(raw, u.shade.xyz);
    if (c > 0.02) {
      base = vec3<f32>(0.22, 0.62, 0.3);
    } else if (c < -0.02 && degrees(acos(min(-c, 1.0))) < u.shade.w) {
      base = vec3<f32>(0.8, 0.16, 0.1);
    } else {
      base = vec3<f32>(0.18, 0.44, 0.8);
    }
  }
  base = mix(base, vec3<f32>(0.36, 0.56, 0.98), clamp(in.selected, 0.0, 1.0));
  base = hovered(base, body.hover.xy, body.fade.x, in.face);
  base = hovered(base, body.hover.zw, body.fade.y, in.face);
  if (clipping && inside) {
    // FundaCAD 1's section cap, unlit 45 degree stripes at a fixed pixel pitch. The back faces seen through the cut
    // stand in for the cap the stencil drew there.
    let t = abs((in.clip.x + in.clip.y) % 9.0 - 4.5);
    var cap = mix(base * 0.42, mix(base, vec3<f32>(1.0), 0.25), 1.0 - smoothstep(0.2, 1.8, t));
    if (u.encode_srgb.x > 0.5) {
      cap = pow(clamp(cap, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
    }
    return vec4<f32>(cap, 1.0);
  }
  let hemi = mix(vec3<f32>(0.18, 0.17, 0.16), vec3<f32>(0.32, 0.36, 0.42), n.z * 0.5 + 0.5);
  let diffuse = max(dot(n, key), 0.0) * 0.75 + max(dot(n, fill), 0.0) * 0.25;
  let half_dir = normalize(key + view_dir);
  let spec = pow(max(dot(n, half_dir), 0.0), 48.0) * 0.35;
  let rim = pow(1.0 - max(dot(n, view_dir), 0.0), 3.0) * 0.15;
  var color = base * (hemi + diffuse) + vec3<f32>(spec + rim);
  if (u.encode_srgb.x > 0.5) {
    color = pow(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
  }
  return vec4<f32>(color, 1.0);
}
