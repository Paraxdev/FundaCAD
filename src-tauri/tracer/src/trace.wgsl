// Prepended by rq.wgsl or sw.wgsl, which define trace(o, d, tmax, shadow).

struct Light {
  // towards the light, 1 - cos of its angular radius (0 for a delta light)
  dir: vec4f,
  // irradiance, the chance a light sample picks it
  color: vec4f,
}
struct U {
  w: u32, h: u32, sample: u32, row0: u32,
  // flags: bit 0 writes the AOVs, bits 1 and 2 pick the estimator
  rows: u32, n_inst: u32, bounces: u32, flags: u32,
  eye: vec4f, fwd: vec4f, right: vec4f, up: vec4f,
  sky_top: vec4f, sky_bottom: vec4f, tone: vec4f,
  lights: array<Light, 4>,
  n_lights: vec4u,
  // rgb, w 1 when camera misses show it instead of the sky
  background: vec4f,
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
const EST_NEE = 1u;
const EST_BSDF = 2u;
// The luminance an indirect contribution is scaled down to.
const FIREFLY = 10.0;

var<private> seed: u32;
fn rnd() -> f32 {
  seed = seed * 747796405u + 2891336453u;
  var w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967296.0;
}
fn basis(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  return mat3x3f(vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x), vec3f(b, s + n.y * n.y * a, -n.y), n);
}
fn onb(n: vec3f, d: vec3f) -> vec3f { return basis(n) * d; }
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn schlick(f0: vec3f, f90: f32, c: f32) -> vec3f { return f0 + (vec3f(f90) - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }
fn g1(c: f32, a: f32) -> f32 {
  let a2 = a * a;
  return 2.0 * c / (c + sqrt(a2 + (1.0 - a2) * c * c));
}
// 1 - (n.h)^2 from the cross product, which keeps a near mirror lobe's peak in f32.
fn d_ggx(n: vec3f, h: vec3f, a: f32) -> f32 {
  let a2 = a * a;
  let c = cross(n, h);
  let nh = dot(n, h);
  let t = dot(c, c) + nh * nh * a2;
  return a2 / (PI * t * t);
}
// A normal visible from v, sampled in the spherical cap (Dupuy and Benyoub 2023).
fn vndf(n: vec3f, v: vec3f, a: f32) -> vec3f {
  let bm = basis(n);
  let vl = transpose(bm) * v;
  let vs = normalize(vec3f(a * vl.x, a * vl.y, max(vl.z, 1e-4)));
  let phi = 2.0 * PI * rnd();
  let z = (1.0 - rnd()) * (1.0 + vs.z) - vs.z;
  let st = sqrt(clamp(1.0 - z * z, 0.0, 1.0));
  let hs = vec3f(st * cos(phi), st * sin(phi), z) + vs;
  return normalize(bm * vec3f(a * hs.x, a * hs.y, max(hs.z, 1e-6)));
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
fn mis(a: f32, b: f32) -> f32 { return a * a / (a * a + b * b); }
fn add(c: vec3f, clamped: bool) -> vec3f {
  let l = lum(c);
  if (clamped && l > FIREFLY) { return c * (FIREFLY / l); }
  return c;
}

// The opaque layers: a clear coat over GGX specular over diffuse.
struct Bsdf {
  f0: vec3f, f90: f32,
  diffuse: vec3f, a: f32,
  // the chance a bounce under the coat samples the specular lobe
  ps: f32,
  coat: f32, ca: f32,
  // the chance a bounce samples the coat, and what the coat lets through
  pc: f32, base: f32,
}
// rgb f times n.l towards l, w the pdf a bounce picks l with.
fn bsdf_eval(s: Bsdf, n: vec3f, v: vec3f, l: vec3f, nv: f32) -> vec4f {
  let nl = dot(n, l);
  if (nl <= 0.0) { return vec4f(0.0); }
  let h = normalize(v + l);
  let vh = max(dot(v, h), 1e-4);
  let d = d_ggx(n, h, s.a);
  let spec = schlick(s.f0, s.f90, vh) * d * g1(nv, s.a) * g1(nl, s.a) / (4.0 * nv * nl);
  var f = s.base * (spec + s.diffuse / PI);
  var pdf = s.ps * g1(nv, s.a) * d / (4.0 * nv) + (1.0 - s.ps) * nl / PI;
  if (s.coat > 0.0) {
    let dc = d_ggx(n, h, s.ca);
    f += vec3f(s.coat * schlick(vec3f(0.04), 1.0, vh).x * dc * g1(nv, s.ca) * g1(nl, s.ca) / (4.0 * nv * nl));
    pdf = s.pc * g1(nv, s.ca) * dc / (4.0 * nv) + (1.0 - s.pc) * pdf;
  }
  return vec4f(f * nl, pdf);
}

// rgb the radiance of the light discs along d, w the pdf a light sample picks d with.
fn discs(d: vec3f) -> vec4f {
  var r = vec4f(0.0);
  for (var k = 0u; k < u.n_lights.x; k++) {
    let li = u.lights[k];
    if (li.dir.w > 0.0 && dot(d, li.dir.xyz) >= 1.0 - li.dir.w) {
      let sa = 2.0 * PI * li.dir.w;
      r += vec4f(li.color.rgb / sa, li.color.w / sa);
    }
  }
  return r;
}
struct LightSample { l: vec3f, pdf: f32, e: vec3f }
// One light picked by power and a direction inside its disc. e is radiance
// over pdf; pdf is 0 for a delta light, which no bounce can find.
fn sample_light() -> LightSample {
  var r = rnd();
  var k = 0u;
  loop {
    if (k + 1u >= u.n_lights.x || r < u.lights[k].color.w) { break; }
    r -= u.lights[k].color.w;
    k++;
  }
  let li = u.lights[k];
  if (li.dir.w <= 0.0) { return LightSample(li.dir.xyz, 0.0, li.color.rgb / li.color.w); }
  let q = rnd() * li.dir.w;
  let st = sqrt(max(q * (2.0 - q), 0.0));
  let phi = 2.0 * PI * rnd();
  let l = onb(li.dir.xyz, vec3f(st * cos(phi), st * sin(phi), 1.0 - q));
  let c = discs(l);
  if (c.w <= 0.0) { return LightSample(l, 0.0, vec3f(0.0)); }
  return LightSample(l, c.w, c.rgb / c.w);
}

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
  let est = (u.flags >> 1u) & 3u;
  let clamp_on = est == 0u;
  // 0 from the camera, below 0 from a scatter with no light sample, else the
  // pdf of the bounce that sent the ray.
  var last_pdf = 0.0;
  for (var b = 0u; b < u.bounces; b++) {
    let h = trace(o, d, 1e30, false);
    if (!h.ok) {
      if (last_pdf == 0.0) {
        let bg = select(env(d), u.background.rgb, u.background.w > 0.0);
        col += thr * bg;
        if (b == 0u && (u.flags & 1u) != 0u) {
          aov[pix * 2u] = vec4f(bg, 1e30);
          aov[pix * 2u + 1u] = vec4f(0.0);
        }
        break;
      }
      var c = env(d);
      if (last_pdf != 0.0) {
        let lc = discs(d);
        if (lc.w > 0.0) {
          var w = 1.0;
          if (last_pdf > 0.0) {
            if (est == EST_NEE) { w = 0.0; } else if (est != EST_BSDF) { w = mis(last_pdf, lc.w); }
          }
          c += lc.rgb * w;
        }
      }
      col += add(thr * c, b >= 2u && clamp_on);
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
    col += add(thr * m.emission.rgb, b >= 2u && clamp_on);
    if (rnd() > m.base.a) {
      o = p + d * eps;
      continue;
    }
    let v = -d;
    let nv = max(dot(ns, v), 1e-4);
    let metal = m.pbr.x;
    let alpha = max(m.pbr.y * m.pbr.y, 1e-4);
    let trans = m.pbr.z * (1.0 - metal);
    if (rnd() < trans) {
      last_pdf = -1.0;
      if (m.coat.x > 0.0 && rnd() < m.coat.x * schlick(vec3f(0.04), 1.0, nv).x) {
        d = reflect(d, vndf(ns, v, max(m.coat.y * m.coat.y, 1e-4)));
        if (dot(d, ng) <= 0.0) { break; }
        o = p + ng * eps;
        continue;
      }
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
      let hm = select(vndf(ns, v, alpha), ns, alpha < 1e-3);
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
      var s: Bsdf;
      s.f0 = mix(vec3f(0.04 * m.coat.w) * m.specular.rgb, albedo, metal);
      s.f90 = mix(m.coat.w, 1.0, metal);
      let fv = schlick(s.f0, s.f90, nv);
      s.diffuse = albedo * (1.0 - metal) * (1.0 - fv);
      s.a = alpha;
      s.ps = mix(clamp(lum(fv), 0.05, 0.95), 1.0, metal);
      s.coat = m.coat.x;
      s.ca = max(m.coat.y * m.coat.y, 1e-4);
      s.pc = m.coat.x * schlick(vec3f(0.04), 1.0, nv).x;
      s.base = 1.0 - s.pc;
      if (u.n_lights.x > 0u && est != EST_BSDF) {
        let ls = sample_light();
        if (dot(ls.l, ng) > 0.0) {
          let f = bsdf_eval(s, ns, v, ls.l, nv);
          if (any(f.rgb > vec3f(0.0)) && !trace(p + ng * eps, ls.l, 1e30, true).ok) {
            var w = 1.0;
            if (ls.pdf > 0.0 && est != EST_NEE) { w = mis(ls.pdf, f.w); }
            col += add(thr * f.rgb * ls.e * w, b >= 1u && clamp_on);
          }
        }
      }
      var l: vec3f;
      if (rnd() < s.pc) {
        l = reflect(d, vndf(ns, v, s.ca));
      } else if (rnd() < s.ps) {
        l = reflect(d, vndf(ns, v, s.a));
      } else {
        let r1 = rnd(); let r2 = 2.0 * PI * rnd();
        let sr = sqrt(r1);
        l = onb(ns, vec3f(sr * cos(r2), sr * sin(r2), sqrt(1.0 - r1)));
      }
      if (dot(l, ng) <= 0.0) { break; }
      let f = bsdf_eval(s, ns, v, l, nv);
      if (f.w <= 0.0) { break; }
      thr *= f.rgb / f.w;
      last_pdf = f.w;
      d = l;
      o = p + ng * eps;
    }
    if (b >= 3u) {
      let q = clamp(max(thr.x, max(thr.y, thr.z)), 0.05, 0.95);
      if (rnd() > q) { break; }
      thr /= q;
    }
  }
  if (any(col != col)) { col = vec3f(0.0); }
  accum[pix] += vec4f(col, 1.0);
}
