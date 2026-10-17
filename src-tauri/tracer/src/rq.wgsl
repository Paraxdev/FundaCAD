enable wgpu_ray_query;
@group(0) @binding(10) var acc: acceleration_structure;
fn trace(o: vec3f, d: vec3f, tmax: f32, shadow: bool) -> Hit {
  var rq: ray_query;
  let fl = select(RAY_FLAG_FORCE_OPAQUE, RAY_FLAG_FORCE_OPAQUE | RAY_FLAG_TERMINATE_ON_FIRST_HIT, shadow);
  rayQueryInitialize(&rq, acc, RayDesc(fl, 0xFFu, 0.0, tmax, o, d));
  loop { if (!rayQueryProceed(&rq)) { break; } }
  let x = rayQueryGetCommittedIntersection(&rq);
  var h: Hit;
  h.ok = x.kind != RAY_QUERY_INTERSECTION_NONE;
  h.t = x.t;
  h.inst = x.instance_custom_data;
  h.prim = x.primitive_index;
  h.bary = x.barycentrics;
  return h;
}
