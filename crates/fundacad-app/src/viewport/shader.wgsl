struct Uniforms {
  view_proj: mat4x4<f32>,
  eye: vec4<f32>,
  encode_srgb: vec4<f32>,
}

struct Body {
  offset: vec4<f32>,
  hover: vec4<i32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var<uniform> body: Body;

struct Varying {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) @interpolate(flat) face: u32,
}

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) face: u32,
  @location(3) mask: f32,
) -> Varying {
  var out: Varying;
  let world = position + body.offset.xyz * mask;
  out.clip = u.view_proj * vec4<f32>(world, 1.0);
  out.world = world;
  out.normal = normal;
  out.face = face;
  return out;
}

@fragment
fn fs(in: Varying) -> @location(0) vec4<f32> {
  var n = normalize(in.normal);
  let view_dir = normalize(u.eye.xyz - in.world);
  if (dot(n, view_dir) < 0.0) {
    n = -n;
  }
  let key = normalize(vec3<f32>(0.4, -0.5, 0.8));
  let fill = normalize(vec3<f32>(-0.6, 0.4, 0.2));
  var base = vec3<f32>(0.62, 0.66, 0.72);
  if (body.hover.x >= 0 && u32(body.hover.x) == in.face) {
    if (body.hover.y == 1) {
      base = vec3<f32>(0.6, 0.62, 0.94);
    } else {
      base = vec3<f32>(0.7, 0.72, 0.78);
    }
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
