struct Uniforms {
  view_proj: mat4x4<f32>,
  eye: vec4<f32>,
  encode_srgb: vec4<f32>,
  clip: vec4<f32>,
  shade: vec4<f32>,
  hatch: vec4<f32>,
  view_up: vec4<f32>,
  look: vec4<f32>,
  edge: vec4<f32>,
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

// FundaCAD 1's matcap.ts spheres, worked out per pixel instead of baked into a texture. `n` is in the sphere's
// frame: x right, y up, z toward the eye.
fn matcap_shade(n: vec3<f32>, style: i32) -> vec3<f32> {
  let key = normalize(vec3<f32>(-0.45, 0.65, 0.62));
  let fill = normalize(vec3<f32>(0.7, -0.15, 0.7));
  let half_dir = normalize(vec3<f32>(0.0, 0.0, 1.0) + key);
  if (style == 1) {
    let v = 0.4 + 0.12 * (0.5 + 0.5 * n.y) + 0.5 * max(0.0, dot(n, key)) + 0.1 * max(0.0, dot(n, fill));
    return vec3<f32>(v, v * 0.96, v * 0.91);
  }
  if (style == 2) {
    let t = clamp((n.y + 0.12) / 0.24, 0.0, 1.0);
    let horizon = t * t * (3.0 - 2.0 * t);
    let v = 0.08 + 0.78 * horizon + 0.35 * pow(max(0.0, dot(n, half_dir)), 24.0) + 0.08 * pow(1.0 - n.z, 2.0);
    return vec3<f32>(v * 0.93, v * 0.97, v);
  }
  if (style == 3) {
    let wrap = max(0.0, (dot(n, key) + 0.6) / 1.6);
    let glow = pow(1.0 - n.z, 2.0);
    let v = 0.42 + 0.5 * wrap * wrap + 0.14 * glow + 0.12 * pow(max(0.0, dot(n, half_dir)), 18.0);
    return vec3<f32>(v, v * 0.97, v * 0.9);
  }
  let sky = 0.5 + 0.5 * n.y;
  let diffuse = max(0.0, dot(n, key));
  let soft = max(0.0, dot(n, fill));
  let spec = pow(max(0.0, dot(n, half_dir)), 40.0);
  let rim = pow(1.0 - n.z, 3.0);
  let v = 0.36 + 0.2 * sky + 0.45 * diffuse + 0.22 * soft + 0.2 * spec + 0.06 * rim;
  return vec3<f32>(v, v, v);
}

// three's MeshMatcapMaterial lookup: the normal in a frame turned toward this pixel's view ray, scaled by 0.99 as
// its uv is, then back onto the sphere the texture was baked from.
fn matcap_normal(n: vec3<f32>, view_dir: vec3<f32>) -> vec3<f32> {
  let x = normalize(cross(u.view_up.xyz, view_dir));
  let y = cross(view_dir, x);
  let p = vec2<f32>(dot(x, n), dot(y, n)) * 0.99;
  let r2 = dot(p, p);
  if (r2 >= 1.0) {
    return vec3<f32>(normalize(p), 0.0);
  }
  return vec3<f32>(p, sqrt(1.0 - r2));
}

// three's NeutralToneMapping, which FundaCAD 1's matcap draw goes through straight to the canvas.
fn neutral(c_in: vec3<f32>) -> vec3<f32> {
  let start = 0.8 - 0.04;
  let desaturation = 0.15;
  var c = c_in;
  let x = min(c.r, min(c.g, c.b));
  var offset = 0.04;
  if (x < 0.08) {
    offset = x - 6.25 * x * x;
  }
  c = c - vec3<f32>(offset);
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) {
    return c;
  }
  let d = 1.0 - start;
  let new_peak = 1.0 - d * d / (peak + d - start);
  c = c * (new_peak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - new_peak) + 1.0);
  return mix(c, vec3<f32>(new_peak), g);
}

fn hover_amount(face: u32) -> f32 {
  var a = 0.0;
  if (body.hover.x >= 0 && u32(body.hover.x) == face) {
    a = body.fade.x;
  }
  if (body.hover.z >= 0 && u32(body.hover.z) == face) {
    a = max(a, body.fade.y);
  }
  return a;
}

@fragment
fn fs(in: Varying) -> @location(0) vec4<f32> {
  if (dot(u.clip.xyz, u.clip.xyz) > 0.0 && cut(in.world)) {
    discard;
  }
  // See through faces still show their hover and selection, at up to this opacity.
  let highlight = max(hover_amount(in.face), clamp(in.selected, 0.0, 1.0)) * 0.6;
  let alpha = max(u.look.w, highlight);
  if (alpha < 0.004) {
    discard;
  }
  let raw = normalize(in.normal);
  var n = raw;
  let view_dir = normalize(u.eye.xyz - in.world);
  let inside = dot(n, view_dir) < 0.0;
  if (inside) {
    n = -n;
  }
  var base = tone(raw, in.selected);
  base = hovered(base, body.hover.xy, body.fade.x, in.face);
  base = hovered(base, body.hover.zw, body.fade.y, in.face);
  if (u.look.x > 0.5) {
    // The lit look's colours carried over relative to its grey, onto matcap.ts's tint: render.ts BASE_COLOR 0x9aa7b4
    // when tinting with body colours, white when not, times its MATCAP_GAIN.
    var neutral_base = vec3<f32>(1.0);
    if (u.look.z > 0.5) {
      neutral_base = vec3<f32>(0.3239, 0.3864, 0.4564);
    }
    let colour = base / vec3<f32>(0.62, 0.66, 0.72) * neutral_base * 1.7;
    let shade = matcap_shade(matcap_normal(n, view_dir), i32(u.look.y + 0.5));
    return vec4<f32>(encode(neutral(colour * shade)), alpha);
  }
  let key = normalize(vec3<f32>(0.4, -0.5, 0.8));
  let fill = normalize(vec3<f32>(-0.6, 0.4, 0.2));
  let hemi = mix(vec3<f32>(0.18, 0.17, 0.16), vec3<f32>(0.32, 0.36, 0.42), n.z * 0.5 + 0.5);
  let diffuse = max(dot(n, key), 0.0) * 0.75 + max(dot(n, fill), 0.0) * 0.25;
  let half_dir = normalize(key + view_dir);
  let spec = pow(max(dot(n, half_dir), 0.0), 48.0) * 0.35;
  let rim = pow(1.0 - max(dot(n, view_dir), 0.0), 3.0) * 0.15;
  return vec4<f32>(encode(base * (hemi + diffuse) + vec3<f32>(spec + rim)), alpha);
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

@vertex
fn vs_line(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  let clip = u.view_proj * vec4<f32>(position, 1.0);
  return vec4<f32>(clip.xy, clip.z - 2e-5 * clip.w, clip.w);
}

@fragment
fn fs_line() -> @location(0) vec4<f32> {
  return vec4<f32>(encode(u.edge.rgb), u.edge.a);
}
