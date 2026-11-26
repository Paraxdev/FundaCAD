struct Uniforms {
  view_proj: mat4x4<f32>,
  eye: vec4<f32>,
  encode_srgb: vec4<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

struct Varying {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
}

@vertex
fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>) -> Varying {
  var out: Varying;
  out.clip = u.view_proj * vec4<f32>(position, 1.0);
  out.world = position;
  out.normal = normal;
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
  let base = vec3<f32>(0.62, 0.66, 0.72);
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
