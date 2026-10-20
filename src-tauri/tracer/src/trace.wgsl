// Prepended by rq.wgsl or sw.wgsl, which define trace(o, d, tmax, shadow).

struct U {
  w: u32, h: u32, sample: u32, row0: u32,
  rows: u32, n_inst: u32, bounces: u32, flags: u32,
  eye: vec4f, fwd: vec4f, right: vec4f, up: vec4f,
  sky_top: vec4f, sky_bottom: vec4f, sun_dir: vec4f, sun_color: vec4f, tone: vec4f,
}
struct Inst {
  o2w0: vec4f, o2w1: vec4f, o2w2: vec4f,
  w2o0: vec4f, w2o1: vec4f, w2o2: vec4f,
  // vertex base, index base, material base, triangle base
  base: vec4u,
  // node base, material count, flags (bit 0 relief, bit 1 emitters), emitter table offset
  extra: vec4u,
  // axis xyz, pitch
  relief0: vec4f,
  // origin, depth, tint jitter, cavity
  relief1: vec4f,
}
struct Mat {
  base: vec4f, emission: vec4f, pbr: vec4f, attenuation: vec4f, coat: vec4f, specular: vec4f, sheen: vec4f,
  // iridescence, iridescence ior, thickness min, thickness max
  film: vec4f,
  // anisotropy, scatter distance, flakes, flake size
  finish: vec4f,
}
struct Hit { ok: bool, t: f32, inst: u32, prim: u32, bary: vec2f }

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> aov: array<vec4f>;
@group(0) @binding(3) var<storage, read> pos: array<vec4f>;
@group(0) @binding(4) var<storage, read> nrm: array<vec4f>;
@group(0) @binding(5) var<storage, read> idx: array<u32>;
@group(0) @binding(6) var<storage, read> slots: array<u32>;
@group(0) @binding(7) var<storage, read> cols: array<u32>;
@group(0) @binding(8) var<storage, read> insts: array<Inst>;
@group(0) @binding(9) var<storage, read> mats: array<Mat>;

const PI = 3.14159265;
const SOLID = 1u;
const VERTEX_COLORS = 2u;
const NO_LIGHT = 4u;

var<private> seed: u32;
fn rnd() -> f32 {
  seed = seed * 747796405u + 2891336453u;
  var w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967296.0;
}
fn onb(n: vec3f, d: vec3f) -> vec3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  let t = vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
  let bt = vec3f(b, s + n.y * n.y * a, -n.y);
  return d.x * t + d.y * bt + d.z * n;
}
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn schlick(f0: vec3f, c: f32) -> vec3f { return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }
fn ggx_h(n: vec3f, a: f32) -> vec3f {
  let r1 = rnd(); let r2 = 2.0 * PI * rnd();
  let ct = sqrt((1.0 - r1) / (1.0 + (a * a - 1.0) * r1));
  let st = sqrt(max(0.0, 1.0 - ct * ct));
  return onb(n, vec3f(st * cos(r2), st * sin(r2), ct));
}
fn g1(c: f32, a: f32) -> f32 {
  let a2 = a * a;
  return 2.0 * c / (c + sqrt(a2 + (1.0 - a2) * c * c));
}
fn fresnel(ci: f32, eta: f32) -> f32 {
  let s2 = eta * eta * (1.0 - ci * ci);
  if (s2 >= 1.0) { return 1.0; }
  let ct = sqrt(1.0 - s2);
  let rs = (eta * ci - ct) / (eta * ci + ct);
  let rp = (ci - eta * ct) / (ci + eta * ct);
  return 0.5 * (rs * rs + rp * rp);
}
fn env(d: vec3f) -> vec3f {
  return mix(u.sky_bottom.rgb, u.sky_top.rgb, d.z * 0.5 + 0.5) * u.sky_top.w;
}
fn vcol(i: u32) -> vec3f { return unpack4x8unorm(cols[i]).rgb; }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let y = id.y + u.row0;
  if (id.x >= u.w || y >= u.h || id.y >= u.rows) { return; }
  let pix = y * u.w + id.x;
  seed = pix * 9781u + u.sample * 6271u + 1u;
  _ = rnd();
  let px = (f32(id.x) + rnd()) / f32(u.w) * 2.0 - 1.0;
  let py = 1.0 - (f32(y) + rnd()) / f32(u.h) * 2.0;
  var o = u.eye.xyz;
  var d = normalize(u.fwd.xyz + px * u.right.xyz + py * u.up.xyz);
  var thr = vec3f(1.0);
  var col = vec3f(0.0);
  var channel = 3u;
  for (var b = 0u; b < u.bounces; b++) {
    let h = trace(o, d, 1e30, false);
    if (!h.ok) {
      col += thr * env(d);
      if (b == 0u && (u.flags & 1u) != 0u) {
        aov[pix * 2u] = vec4f(env(d), 1e30);
        aov[pix * 2u + 1u] = vec4f(0.0);
      }
      break;
    }
    let it = insts[h.inst];
    let tri = h.prim;
    let ib = it.base.y + tri * 3u;
    let i0 = it.base.x + idx[ib]; let i1 = it.base.x + idx[ib + 1u]; let i2 = it.base.x + idx[ib + 2u];
    let w0 = 1.0 - h.bary.x - h.bary.y;
    let a = pos[i0].xyz;
    let gl = cross(pos[i1].xyz - a, pos[i2].xyz - a);
    let sl = w0 * nrm[i0].xyz + h.bary.x * nrm[i1].xyz + h.bary.y * nrm[i2].xyz;
    var ng = normalize(gl.x * it.w2o0.xyz + gl.y * it.w2o1.xyz + gl.z * it.w2o2.xyz);
    var ns = sl.x * it.w2o0.xyz + sl.y * it.w2o1.xyz + sl.z * it.w2o2.xyz;
    ns = select(ng, normalize(ns), dot(ns, ns) > 1e-12);
    let front = dot(ng, d) < 0.0;
    if (!front) { ng = -ng; ns = -ns; }
    if (dot(ns, ng) < 0.0) { ns = ng; }
    let p = o + d * h.t;
    let eps = 1e-4 * max(1.0, max(abs(p.x), max(abs(p.y), abs(p.z))));
    var slot = slots[it.base.w + tri];
    if (slot >= it.extra.y) { slot = 0u; }
    let m = mats[it.base.z + slot];
    let flags = bitcast<u32>(m.emission.w);
    var albedo = m.base.rgb;
    if ((flags & VERTEX_COLORS) != 0u) {
      albedo *= w0 * vcol(i0) + h.bary.x * vcol(i1) + h.bary.y * vcol(i2);
    }
    if (b == 0u && (u.flags & 1u) != 0u) {
      aov[pix * 2u] = vec4f(albedo, dot(p - u.eye.xyz, normalize(u.fwd.xyz)));
      aov[pix * 2u + 1u] = vec4f(ns, 1.0);
    }
    // Light absorbed on the way through a solid, Beer's law from its colour at its distance.
    if (!front && (flags & SOLID) != 0u) {
      thr *= pow(max(m.attenuation.rgb, vec3f(1e-4)), vec3f(h.t / m.attenuation.w));
    }
    col += thr * m.emission.rgb;
    if (rnd() > m.base.a) {
      o = p + d * eps;
      continue;
    }
    let v = -d;
    let nv = max(dot(ns, v), 1e-4);
    let metal = m.pbr.x;
    let alpha = max(m.pbr.y * m.pbr.y, 1e-4);
    let trans = m.pbr.z * (1.0 - metal);
    if (m.coat.x > 0.0 && rnd() < m.coat.x * schlick(vec3f(0.04), nv).x) {
      let hc = ggx_h(ns, max(m.coat.y * m.coat.y, 1e-4));
      d = reflect(d, hc);
      if (dot(d, ng) <= 0.0) { break; }
      o = p + ng * eps;
      continue;
    }
    if (rnd() < trans) {
      var ior = m.pbr.w;
      if (m.coat.z > 0.0) {
        if (channel == 3u) {
          channel = min(u32(rnd() * 3.0), 2u);
          var one = vec3f(0.0);
          one[channel] = 3.0;
          thr *= one;
        }
        let half = (ior - 1.0) * 0.025 * m.coat.z;
        ior += (f32(channel) - 1.0) * half;
      }
      let eta = select(ior, 1.0 / ior, front);
      let hm = select(ggx_h(ns, alpha), ns, alpha < 1e-3);
      let ci = dot(v, hm);
      if (rnd() < fresnel(ci, eta)) {
        d = reflect(d, hm);
        o = p + ng * eps;
      } else {
        d = refract(d, hm, eta);
        if (dot(d, d) < 1e-8) { d = reflect(-v, hm); o = p + ng * eps; }
        else {
          o = p - ng * eps;
          if (front) { thr *= albedo; }
        }
      }
    } else {
      let f0 = mix(vec3f(0.04 * m.coat.w) * m.specular.rgb, albedo, metal);
      let fv = schlick(f0, nv);
      let diffuse = albedo * (1.0 - metal) * (1.0 - fv);
      if (u.sun_dir.w > 0.0) {
        let l = u.sun_dir.xyz;
        let nl = dot(ns, l);
        if (nl > 0.0 && dot(ng, l) > 0.0 && !trace(p + ng * eps, l, 1e30, true).ok) {
          col += thr * diffuse / PI * u.sun_color.rgb * nl;
        }
      }
      let ps = mix(clamp(lum(fv), 0.05, 0.95), 1.0, metal);
      if (rnd() < ps) {
        let hm = ggx_h(ns, alpha);
        let l = reflect(d, hm);
        let nl = dot(ns, l);
        if (nl <= 0.0 || dot(l, ng) <= 0.0) { break; }
        let vh = max(dot(v, hm), 1e-4);
        let nh = max(dot(ns, hm), 1e-4);
        thr *= schlick(f0, vh) * g1(nv, alpha) * g1(nl, alpha) * vh / (nh * nv) / ps;
        d = l;
      } else {
        let r1 = rnd(); let r2 = 2.0 * PI * rnd();
        let sr = sqrt(r1);
        d = onb(ns, vec3f(sr * cos(r2), sr * sin(r2), sqrt(1.0 - r1)));
        if (dot(d, ng) <= 0.0) { break; }
        thr *= diffuse / (1.0 - ps);
      }
      o = p + ng * eps;
    }
    if (b >= 3u) {
      let q = clamp(max(thr.x, max(thr.y, thr.z)), 0.05, 0.95);
      if (rnd() > q) { break; }
      thr /= q;
    }
  }
  if (any(col != col)) { col = vec3f(0.0); }
  accum[pix] += vec4f(min(col, vec3f(64.0)), 1.0);
}
