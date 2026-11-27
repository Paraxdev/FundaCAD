struct Uniforms {
  view_proj: mat4x4<f32>,
  eye: vec4<f32>,
  encode_srgb: vec4<f32>,
  clip: vec4<f32>,
  shade: vec4<f32>,
  hatch: vec4<f32>,
}

struct Body {
  offset: vec4<f32>,
  hover: vec4<i32>,
  fade: vec4<f32>,
  cap: vec4<f32>,
  selected: vec4<f32>,
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

fn encode(c: vec3<f32>) -> vec3<f32> {
  if (u.encode_srgb.x > 0.5) {
    return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
  }
  return c;
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

// A face lying on the plane counts as cut, else it would flip the count on some samples and not others and fight
// the cap for depth.
fn cut(world: vec3<f32>) -> bool {
  let side = (dot(u.clip.xyz, world) - u.clip.w) / length(u.clip.xyz);
  return side > -1e-4 * max(1.0, abs(u.clip.w));
}

fn tone(raw: vec3<f32>, selected: f32) -> vec3<f32> {
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
  return mix(base, vec3<f32>(0.36, 0.56, 0.98), clamp(selected, 0.0, 1.0));
}

@fragment
fn fs(in: Varying) -> @location(0) vec4<f32> {
  if (dot(u.clip.xyz, u.clip.xyz) > 0.0 && cut(in.world)) {
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
  var base = tone(raw, in.selected);
  base = hovered(base, body.hover.xy, body.fade.x, in.face);
  base = hovered(base, body.hover.zw, body.fade.y, in.face);
  let hemi = mix(vec3<f32>(0.18, 0.17, 0.16), vec3<f32>(0.32, 0.36, 0.42), n.z * 0.5 + 0.5);
  let diffuse = max(dot(n, key), 0.0) * 0.75 + max(dot(n, fill), 0.0) * 0.25;
  let half_dir = normalize(key + view_dir);
  let spec = pow(max(dot(n, half_dir), 0.0), 48.0) * 0.35;
  let rim = pow(1.0 - max(dot(n, view_dir), 0.0), 3.0) * 0.15;
  return vec4<f32>(encode(base * (hemi + diffuse) + vec3<f32>(spec + rim)), 1.0);
}

@fragment
fn fs_count(in: Varying) {
  if (cut(in.world)) {
    discard;
  }
}

@vertex
fn vs_cap(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let n = normalize(u.clip.xyz);
  var a = vec3<f32>(1.0, 0.0, 0.0);
  if (abs(n.x) > 0.9) {
    a = vec3<f32>(0.0, 1.0, 0.0);
  }
  let s = normalize(cross(n, a)) * body.cap.w;
  let t = normalize(cross(n, s)) * body.cap.w;
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  let c = corners[i];
  return u.view_proj * vec4<f32>(body.cap.xyz + s * c.x + t * c.y, 1.0);
}

// FundaCAD 1's section cap, unlit 45 degree stripes at a fixed pixel pitch.
@fragment
fn fs_cap(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let colour = tone(normalize(u.clip.xyz), mix(body.selected.x, body.selected.y, body.fade.z));
  let pitch = u.hatch.x;
  let half_width = u.hatch.y * 0.5;
  let t = abs((frag.x + frag.y) % pitch - pitch * 0.5);
  let stripe = 1.0 - smoothstep(half_width - 0.8, half_width + 0.8, t);
  return vec4<f32>(encode(mix(colour * 0.42, mix(colour, vec3<f32>(1.0), 0.25), stripe)), 1.0);
}

struct Datum {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vs_datum(@location(0) position: vec3<f32>, @location(1) color: vec4<f32>) -> Datum {
  var out: Datum;
  let clip = u.view_proj * vec4<f32>(position, 1.0);
  // A hair toward the eye, so a datum lying on a face shows on it rather than fighting it.
  out.clip = vec4<f32>(clip.xy, clip.z - 2e-5 * clip.w, clip.w);
  out.color = color;
  return out;
}

@fragment
fn fs_datum(in: Datum) -> @location(0) vec4<f32> {
  return vec4<f32>(encode(in.color.rgb), in.color.a);
}
