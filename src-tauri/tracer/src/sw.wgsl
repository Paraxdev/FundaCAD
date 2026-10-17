// Each instance's tree is walked in its own space; the instance loop is the
// top level, linear, which holds for the hundreds of bodies a part has.
@group(0) @binding(10) var<storage, read> nodes: array<vec4f>;
@group(0) @binding(11) var<storage, read> order: array<u32>;
fn trace(o: vec3f, d: vec3f, tmax: f32, shadow: bool) -> Hit {
  var h: Hit;
  h.ok = false;
  h.t = tmax;
  var stack: array<u32, 48>;
  for (var ii = 0u; ii < u.n_inst; ii++) {
    let it = insts[ii];
    let lo = vec3f(dot(it.w2o0, vec4f(o, 1.0)), dot(it.w2o1, vec4f(o, 1.0)), dot(it.w2o2, vec4f(o, 1.0)));
    let ld = vec3f(dot(it.w2o0.xyz, d), dot(it.w2o1.xyz, d), dot(it.w2o2.xyz, d));
    let inv = 1.0 / ld;
    var sp = 1u;
    stack[0] = it.extra.x;
    loop {
      if (sp == 0u) { break; }
      sp -= 1u;
      let ni = stack[sp];
      let n0 = nodes[ni * 2u];
      let n1 = nodes[ni * 2u + 1u];
      let t0 = (n0.xyz - lo) * inv;
      let t1 = (n1.xyz - lo) * inv;
      let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
      let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
      if (tf < max(tn, 0.0) || tn > h.t) { continue; }
      let first = bitcast<u32>(n0.w);
      let cnt = bitcast<u32>(n1.w);
      if (cnt == 0u) {
        if (sp + 2u > 48u) { continue; }
        stack[sp] = first; stack[sp + 1u] = first + 1u; sp += 2u;
        continue;
      }
      for (var k = first; k < first + cnt; k++) {
        let tri = order[k];
        let ib = it.base.y + tri * 3u;
        let a = pos[it.base.x + idx[ib]].xyz;
        let e1 = pos[it.base.x + idx[ib + 1u]].xyz - a;
        let e2 = pos[it.base.x + idx[ib + 2u]].xyz - a;
        let p = cross(ld, e2);
        let det = dot(e1, p);
        if (abs(det) < 1e-20) { continue; }
        let id = 1.0 / det;
        let s = lo - a;
        let uu = dot(s, p) * id;
        if (uu < 0.0 || uu > 1.0) { continue; }
        let q = cross(s, e1);
        let vv = dot(ld, q) * id;
        if (vv < 0.0 || uu + vv > 1.0) { continue; }
        let t = dot(e2, q) * id;
        if (t > 0.0 && t < h.t) {
          h.t = t; h.ok = true; h.inst = ii; h.prim = tri; h.bary = vec2f(uu, vv);
          if (shadow) { return h; }
        }
      }
    }
  }
  return h;
}
