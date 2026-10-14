#pragma once

// A solid whose file draws edges away from the faces they bound, healed: each
// such edge is redrawn along the curve where its two faces meet, between its
// own two corners, outlines that run the wrong way are turned and tolerances
// are reset. The healed solid is kept only when the kernel accepts it, its
// skin is closed and its exact volume agrees with a mesh of it.

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Wire.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Geom2dAPI_Interpolate.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom2d_Curve.hxx>
#include <GeomAPI_IntCS.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <GeomAPI_ProjectPointOnCurve.hxx>
#include <GeomLProp_SLProps.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_Curve.hxx>
#include <Geom_Surface.hxx>
#include <NCollection_DataMap.hxx>
#include <Poly_Triangulation.hxx>
#include <ShapeAnalysis_Surface.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_ShapeTolerance.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_HArray1OfReal.hxx>
#include <TColgp_HArray1OfPnt.hxx>
#include <TColgp_HArray1OfPnt2d.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Vec2d.hxx>
#include <algorithm>
#include <cstdio>
#include <cmath>
#include <map>
#include <string>
#include <utility>
#include <vector>

// An edge farther than this from a face it bounds is redrawn.
const double STEP_HEAL_LIMIT = 1e-3;

// How far an edge's curve is from where its pcurve on `face` puts it.
inline double step_heal_gap(const TopoDS_Edge &edge, const TopoDS_Face &face) {
  BRepAdaptor_Curve curve(edge);
  double pf = 0.0, pl = 0.0;
  Handle(Geom2d_Curve) on = BRep_Tool::CurveOnSurface(edge, face, pf, pl);
  Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  if (on.IsNull() || surface.IsNull()) {
    return 0.0;
  }
  double first = curve.FirstParameter(), last = curve.LastParameter(), gap = 0.0;
  for (int k = 0; k <= 8; ++k) {
    gp_Pnt2d uv = on->Value(pf + (pl - pf) * k / 8);
    gap = std::max(gap, curve.Value(first + (last - first) * k / 8).Distance(surface->Value(uv.X(), uv.Y())));
  }
  return gap;
}

inline int step_heal_edges_away(const TopoDS_Shape &shape, double limit, double &widest) {
  TopTools_IndexedDataMapOfShapeListOfShape faces_of;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, faces_of);
  int away = 0;
  for (int i = 1; i <= faces_of.Extent(); ++i) {
    const TopoDS_Edge &edge = TopoDS::Edge(faces_of.FindKey(i));
    if (BRep_Tool::Degenerated(edge)) {
      continue;
    }
    double gap = 0.0;
    try {
      for (TopTools_ListIteratorOfListOfShape it(faces_of.FindFromIndex(i)); it.More(); it.Next()) {
        gap = std::max(gap, step_heal_gap(edge, TopoDS::Face(it.Value())));
      }
    } catch (const Standard_Failure &) {
      continue;
    }
    if (gap > limit) {
      ++away;
      widest = std::max(widest, gap);
    }
  }
  return away;
}

inline double step_heal_widest_tolerance(const TopoDS_Shape &shape) {
  double widest = 0.0;
  for (TopExp_Explorer ex(shape, TopAbs_EDGE); ex.More(); ex.Next()) {
    widest = std::max(widest, BRep_Tool::Tolerance(TopoDS::Edge(ex.Current())));
  }
  for (TopExp_Explorer ex(shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
    widest = std::max(widest, BRep_Tool::Tolerance(TopoDS::Vertex(ex.Current())));
  }
  return widest;
}

struct StepHeal {
  // Edges more than STEP_HEAL_LIMIT from a face, and the widest gap, as read.
  int away = 0;
  double widest = 0.0;
  int redrawn = 0;
  int turned = 0;
  // Why edges were not redrawn, with how many.
  std::map<std::string, int> refused;
  bool healed = false;
  // Why the redrawn solid was not kept, empty when it was or nothing was redrawn.
  std::string why_not;
  TopoDS_Solid solid;

  int refused_count() const {
    int n = 0;
    for (const auto &r : refused) {
      n += r.second;
    }
    return n;
  }
  std::string main_refusal() const {
    std::pair<std::string, int> top("", 0);
    for (const auto &r : refused) {
      if (r.second > top.second) {
        top = r;
      }
    }
    return top.first;
  }
};

namespace step_heal_detail {

const char *const CLOSED = "the edge starts and ends at one corner";
const char *const NOT_TWO = "the edge does not lie between two faces";
const char *const TANGENT = "the faces touch there without crossing";
const char *const APART = "the faces do not meet between the edge's ends";
const char *const PERIOD = "where the faces meet does not join the rest of their outlines";
const char *const CURVE = "the curve where the faces meet could not be drawn closely enough";

inline double shift(double x, double ref, double period) {
  return period > 0.0 ? x + std::round((ref - x) / period) * period : x;
}

struct Periods {
  double u = 0.0, v = 0.0;
};

inline Periods periods(const TopoDS_Face &face) {
  BRepAdaptor_Surface a(face, false);
  Periods p;
  p.u = a.IsUPeriodic() ? a.UPeriod() : 0.0;
  p.v = a.IsVPeriodic() ? a.VPeriod() : 0.0;
  return p;
}

inline gp_Pnt2d unwrap(const gp_Pnt2d &uv, const gp_Pnt2d &ref, const Periods &p) {
  return gp_Pnt2d(shift(uv.X(), ref.X(), p.u), shift(uv.Y(), ref.Y(), p.v));
}

inline gp_Pnt on_surface(const Handle(ShapeAnalysis_Surface) &sa, const gp_Pnt &p) {
  return sa->Value(sa->ValueOfUV(p, 1e-10));
}

inline double off_surface(const Handle(ShapeAnalysis_Surface) &sa, const gp_Pnt &p) {
  return on_surface(sa, p).Distance(p);
}

// The nearest point of `curve` to `q`, ends included, and its parameter.
inline double on_curve(const gp_Pnt &q, const Handle(Geom_Curve) &curve, gp_Pnt &at, double &t) {
  double best = -1.0;
  auto take = [&](const gp_Pnt &p, double par) {
    double d = p.Distance(q);
    if (best < 0.0 || d < best) {
      best = d;
      at = p;
      t = par;
    }
  };
  GeomAPI_ProjectPointOnCurve project(q, curve);
  for (int k = 1; k <= project.NbPoints(); ++k) {
    take(project.Point(k), project.Parameter(k));
  }
  for (double end : {curve->FirstParameter(), curve->LastParameter()}) {
    if (std::abs(end) < 1e100) {
      take(curve->Value(end), end);
    }
  }
  return best;
}

typedef std::vector<Handle(ShapeAnalysis_Surface)> Surfaces;

// The point on every surface and curve nearest `p`, and how far it misses
// the worst of them.
inline gp_Pnt solve_corner(const gp_Pnt &p, const Surfaces &sas, const std::vector<Handle(Geom_Curve)> &curves,
                           double &residual) {
  auto miss = [&](const gp_Pnt &x) {
    double r = 0.0;
    for (const auto &sa : sas) {
      r = std::max(r, off_surface(sa, x));
    }
    gp_Pnt at;
    double t = 0.0;
    for (const auto &c : curves) {
      r = std::max(r, on_curve(x, c, at, t));
    }
    return r;
  };
  bool found = false;
  gp_Pnt best;
  for (const auto &c : curves) {
    for (const auto &sa : sas) {
      GeomAPI_IntCS meet(c, sa->Surface());
      if (!meet.IsDone()) {
        continue;
      }
      for (int k = 1; k <= meet.NbPoints(); ++k) {
        gp_Pnt x = meet.Point(k);
        if (miss(x) < 1e-7 && (!found || x.Distance(p) < best.Distance(p))) {
          best = x;
          found = true;
        }
      }
    }
  }
  if (found) {
    residual = 0.0;
    return best;
  }
  gp_Pnt q = p;
  for (int it = 0; it < 5000; ++it) {
    gp_Pnt q0 = q;
    for (const auto &sa : sas) {
      q = on_surface(sa, q);
    }
    for (const auto &c : curves) {
      double t = 0.0;
      on_curve(q, c, q, t);
    }
    if (q.Distance(q0) < 1e-12) {
      break;
    }
  }
  residual = miss(q);
  return q;
}

inline bool normal(const Handle(ShapeAnalysis_Surface) &sa, const gp_Pnt &p, gp_Vec &n) {
  gp_Pnt2d uv = sa->ValueOfUV(p, 1e-10);
  GeomLProp_SLProps props(sa->Surface(), uv.X(), uv.Y(), 1, 1e-9);
  if (!props.IsNormalDefined()) {
    return false;
  }
  n = gp_Vec(props.Normal().XYZ());
  return true;
}

// Where two surfaces meet from A to B: stepped along n1 x n2 and pulled back
// onto both, starting off towards `aim`, `sign` -1 the other way.
inline const char *march(const gp_Pnt &A, const gp_Pnt &B, const Surfaces &sas, const std::vector<gp_Pnt> &guide,
                         int N, int sign, std::vector<gp_Pnt> &pts) {
  double L = 0.0;
  for (size_t k = 1; k < guide.size(); ++k) {
    L += guide[k].Distance(guide[k - 1]);
  }
  L = std::max(L, A.Distance(B));
  const double h = L / N;
  gp_Pnt aim = guide[guide.size() / 2];
  for (const gp_Pnt &g : guide) {
    if (g.Distance(A) > 2 * h) {
      aim = g;
      break;
    }
  }
  pts.assign(1, A);
  gp_Pnt q = A;
  gp_Vec prev;
  bool have_prev = false, reached = false;
  for (int step = 0; step < 30 * N; ++step) {
    gp_Vec n0, n1;
    if (!normal(sas[0], q, n0) || !normal(sas[1], q, n1)) {
      return step_heal_detail::TANGENT;
    }
    gp_Vec t = n0.Crossed(n1);
    if (t.Magnitude() < 1e-9) {
      return step_heal_detail::TANGENT;
    }
    t.Normalize();
    if (!have_prev) {
      if (sign * t.Dot(gp_Vec(q, aim)) < 0) {
        t.Reverse();
      }
    } else if (t.Dot(prev) < 0) {
      t.Reverse();
    }
    prev = t;
    have_prev = true;
    if (step > 0 && q.Distance(B) < 1.5 * h) {
      reached = true;
      break;
    }
    q = gp_Pnt(q.XYZ() + t.XYZ() * h);
    for (int it = 0; it < 500; ++it) {
      gp_Pnt q0 = q;
      for (const auto &sa : sas) {
        q = on_surface(sa, q);
      }
      if (q.Distance(q0) < 1e-12) {
        break;
      }
    }
    if (std::max(off_surface(sas[0], q), off_surface(sas[1], q)) > 1e-7) {
      return step_heal_detail::APART;
    }
    pts.push_back(q);
  }
  if (!reached) {
    return step_heal_detail::APART;
  }
  if (pts.size() > 2 && pts.back().Distance(B) < 0.25 * h) {
    pts.pop_back();
  }
  pts.push_back(B);
  return nullptr;
}

// Where the edges of `face` other than `edge` and the ones being redrawn put
// `vertex` in the face's parameters.
inline std::vector<gp_Pnt2d> wire_uv(const TopoDS_Face &face, const TopoDS_Edge &edge, const TopoDS_Vertex &vertex,
                                     const TopTools_IndexedMapOfShape &off) {
  std::vector<gp_Pnt2d> out;
  for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next()) {
    const TopoDS_Edge &other = TopoDS::Edge(ex.Current());
    if (other.IsSame(edge) || off.Contains(other)) {
      continue;
    }
    for (const TopoDS_Vertex &v : {TopExp::FirstVertex(other), TopExp::LastVertex(other)}) {
      if (!v.IsSame(vertex)) {
        continue;
      }
      double f = 0.0, l = 0.0;
      Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(other, face, f, l);
      if (pc.IsNull()) {
        continue;
      }
      out.push_back(pc->Value(BRep_Tool::Parameter(v, other, face)));
    }
  }
  return out;
}

struct Drawn {
  Handle(Geom_BSplineCurve) curve;
  Handle(Geom2d_BSplineCurve) on[2];
  double deviation = 0.0, length = 0.0;
};

inline const char *meet(const TopoDS_Edge &edge, const TopoDS_Face faces[2], int N,
                        const TopTools_IndexedMapOfShape &off, Drawn &out) {
  TopoDS_Vertex vA = TopExp::FirstVertex(edge), vB = TopExp::LastVertex(edge);
  if (vA.IsNull() || vB.IsNull() || vA.IsSame(vB)) {
    return CLOSED;
  }
  gp_Pnt A = BRep_Tool::Pnt(vA), B = BRep_Tool::Pnt(vB);
  Handle(Geom_Surface) surfs[2] = {BRep_Tool::Surface(faces[0]), BRep_Tool::Surface(faces[1])};
  Surfaces sas = {Handle(ShapeAnalysis_Surface)(new ShapeAnalysis_Surface(surfs[0])),
                  Handle(ShapeAnalysis_Surface)(new ShapeAnalysis_Surface(surfs[1]))};
  Handle(Geom2d_Curve) pcs[2];
  double pf[2], pl[2];
  for (int j = 0; j < 2; ++j) {
    pcs[j] = BRep_Tool::CurveOnSurface(edge, faces[j], pf[j], pl[j]);
    if (pcs[j].IsNull()) {
      return NOT_TWO;
    }
  }
  const int guide_face = step_heal_gap(edge, faces[0]) > step_heal_gap(edge, faces[1]) ? 0 : 1;
  std::vector<gp_Pnt> guide;
  for (int k = 0; k <= 200; ++k) {
    gp_Pnt2d uv = pcs[guide_face]->Value(pf[guide_face] + (pl[guide_face] - pf[guide_face]) * k / 200);
    guide.push_back(surfs[guide_face]->Value(uv.X(), uv.Y()));
  }
  Periods per[2] = {periods(faces[0]), periods(faces[1])};
  std::vector<gp_Pnt2d> ends[2][2];
  for (int j = 0; j < 2; ++j) {
    ends[j][0] = wire_uv(faces[j], edge, vA, off);
    ends[j][1] = wire_uv(faces[j], edge, vB, off);
  }

  struct Try {
    double drift;
    std::vector<gp_Pnt> pts;
    std::vector<gp_Pnt2d> uvs[2];
  };
  std::vector<Try> tries;
  const char *why = APART;
  for (int sign : {1, -1}) {
    Try t;
    const char *failed = march(A, B, sas, guide, N, sign, t.pts);
    if (failed) {
      why = failed;
      continue;
    }
    bool ok = true;
    for (int j = 0; j < 2 && ok; ++j) {
      std::vector<gp_Pnt2d> &uvs = t.uvs[j];
      for (const gp_Pnt &p : t.pts) {
        gp_Pnt2d uv = sas[j]->ValueOfUV(p, 1e-10);
        uvs.push_back(uvs.empty() ? uv : unwrap(uv, uvs.back(), per[j]));
      }
      // The run is moved by whole periods to meet the clean edges of the face
      // at an end. The file's own pcurve of this edge can be wrong by a
      // period, so it is only a last resort.
      const std::vector<gp_Pnt2d> &ca = ends[j][0], &cb = ends[j][1];
      size_t at = 0, other = uvs.size() - 1;
      const std::vector<gp_Pnt2d> *checks = &cb;
      std::vector<gp_Pnt2d> none, own = {pcs[j]->Value(pf[j])};
      const std::vector<gp_Pnt2d> *candidates = &ca;
      if (ca.empty() && !cb.empty()) {
        std::swap(at, other);
        checks = &none;
        candidates = &cb;
      } else if (ca.empty()) {
        checks = &none;
        candidates = &own;
      }
      double best_miss = -1.0, du = 0.0, dv = 0.0;
      for (const gp_Pnt2d &c : *candidates) {
        double u = shift(uvs[at].X(), c.X(), per[j].u) - uvs[at].X();
        double v = shift(uvs[at].Y(), c.Y(), per[j].v) - uvs[at].Y();
        gp_Pnt2d end(uvs[other].X() + u, uvs[other].Y() + v);
        double miss = checks->empty() ? 0.0 : 1e300;
        for (const gp_Pnt2d &x : *checks) {
          miss = std::min(miss, end.Distance(x));
        }
        if (best_miss < 0.0 || miss < best_miss) {
          best_miss = miss;
          du = u;
          dv = v;
        }
      }
      if (best_miss > 1e-3) {
        ok = false;
        why = PERIOD;
        break;
      }
      for (gp_Pnt2d &p : uvs) {
        p = gp_Pnt2d(p.X() + du, p.Y() + dv);
      }
    }
    if (!ok) {
      continue;
    }
    // The run that crosses each face's parameters the way the file's pcurves
    // do is preferred over the other.
    t.drift = 0.0;
    for (int j = 0; j < 2; ++j) {
      gp_Pnt2d o0 = pcs[j]->Value(pf[j]), o1 = pcs[j]->Value(pl[j]);
      gp_Pnt2d u0 = t.uvs[j].front(), u1 = t.uvs[j].back();
      t.drift += std::hypot((u1.X() - u0.X()) - (o1.X() - o0.X()), (u1.Y() - u0.Y()) - (o1.Y() - o0.Y()));
    }
    tries.push_back(std::move(t));
  }
  if (tries.empty()) {
    return why;
  }
  const Try &t = *std::min_element(tries.begin(), tries.end(), [](const Try &a, const Try &b) { return a.drift < b.drift; });
  const int n = static_cast<int>(t.pts.size());
  Handle(TColStd_HArray1OfReal) params = new TColStd_HArray1OfReal(1, n);
  double L = 0.0;
  params->SetValue(1, 0.0);
  for (int k = 1; k < n; ++k) {
    L += t.pts[k].Distance(t.pts[k - 1]);
    params->SetValue(k + 1, L);
  }
  Handle(TColgp_HArray1OfPnt) points = new TColgp_HArray1OfPnt(1, n);
  for (int k = 0; k < n; ++k) {
    points->SetValue(k + 1, t.pts[k]);
  }
  GeomAPI_Interpolate through(points, params, false, 1e-9);
  through.Perform();
  if (!through.IsDone()) {
    return CURVE;
  }
  out.curve = through.Curve();
  for (int j = 0; j < 2; ++j) {
    Handle(TColgp_HArray1OfPnt2d) uv = new TColgp_HArray1OfPnt2d(1, n);
    for (int k = 0; k < n; ++k) {
      uv->SetValue(k + 1, t.uvs[j][k]);
    }
    Geom2dAPI_Interpolate on(uv, params, false, 1e-9);
    on.Perform();
    if (!on.IsDone()) {
      return CURVE;
    }
    out.on[j] = on.Curve();
  }
  out.length = L;
  out.deviation = 0.0;
  for (int k = 0; k <= 8 * n; ++k) {
    double s = L * k / (8 * n);
    for (int j = 0; j < 2; ++j) {
      gp_Pnt2d uv = out.on[j]->Value(s);
      out.deviation = std::max(out.deviation, out.curve->Value(s).Distance(surfs[j]->Value(uv.X(), uv.Y())));
    }
  }
  return nullptr;
}

struct Off {
  TopoDS_Edge edge;
  std::vector<TopoDS_Face> faces;
  double gap = 0.0;
};

inline std::vector<Off> off_edges(const TopoDS_Shape &body) {
  TopTools_IndexedDataMapOfShapeListOfShape faces_of;
  TopExp::MapShapesAndAncestors(body, TopAbs_EDGE, TopAbs_FACE, faces_of);
  std::vector<Off> out;
  for (int i = 1; i <= faces_of.Extent(); ++i) {
    Off o;
    o.edge = TopoDS::Edge(faces_of.FindKey(i));
    if (BRep_Tool::Degenerated(o.edge)) {
      continue;
    }
    for (TopTools_ListIteratorOfListOfShape it(faces_of.FindFromIndex(i)); it.More(); it.Next()) {
      const TopoDS_Face &f = TopoDS::Face(it.Value());
      if (std::none_of(o.faces.begin(), o.faces.end(), [&](const TopoDS_Face &g) { return g.IsSame(f); })) {
        o.faces.push_back(f);
      }
    }
    try {
      for (const TopoDS_Face &f : o.faces) {
        o.gap = std::max(o.gap, step_heal_gap(o.edge, f));
      }
    } catch (const Standard_Failure &) {
      continue;
    }
    if (o.gap > STEP_HEAL_LIMIT) {
      out.push_back(o);
    }
  }
  return out;
}

// A corner of an edge being redrawn that is off a face around it moves to the
// point on all of them and on the edges there that are kept, which are
// re-ranged to it. Almost always the corners are right and only the edge
// curves are not; a corner on a closed face's seam is the exception.
inline int fix_corners(const TopoDS_Shape &body, const std::vector<Off> &offs, const TopTools_IndexedMapOfShape &off) {
  TopTools_IndexedDataMapOfShapeListOfShape faces_at, edges_at;
  TopExp::MapShapesAndAncestors(body, TopAbs_VERTEX, TopAbs_FACE, faces_at);
  TopExp::MapShapesAndAncestors(body, TopAbs_VERTEX, TopAbs_EDGE, edges_at);
  TopTools_IndexedMapOfShape seen;
  BRep_Builder builder;
  int refused = 0;
  for (const Off &o : offs) {
    for (const TopoDS_Vertex &v : {TopExp::FirstVertex(o.edge), TopExp::LastVertex(o.edge)}) {
      if (v.IsNull() || seen.Contains(v)) {
        continue;
      }
      seen.Add(v);
      gp_Pnt p = BRep_Tool::Pnt(v);
      Surfaces sas;
      TopTools_IndexedMapOfShape faces;
      for (TopTools_ListIteratorOfListOfShape it(faces_at.FindFromKey(v)); it.More(); it.Next()) {
        if (!faces.Contains(it.Value())) {
          faces.Add(it.Value());
          sas.push_back(Handle(ShapeAnalysis_Surface)(
              new ShapeAnalysis_Surface(BRep_Tool::Surface(TopoDS::Face(it.Value())))));
        }
      }
      double worst = 0.0;
      for (const auto &sa : sas) {
        worst = std::max(worst, off_surface(sa, p));
      }
      if (worst <= 1e-6) {
        continue;
      }
      std::vector<TopoDS_Edge> keep;
      std::vector<Handle(Geom_Curve)> curves;
      for (TopTools_ListIteratorOfListOfShape it(edges_at.FindFromKey(v)); it.More(); it.Next()) {
        const TopoDS_Edge &e = TopoDS::Edge(it.Value());
        if (off.Contains(e) || BRep_Tool::Degenerated(e) ||
            std::any_of(keep.begin(), keep.end(), [&](const TopoDS_Edge &k) { return k.IsSame(e); })) {
          continue;
        }
        double f = 0.0, l = 0.0;
        Handle(Geom_Curve) c = BRep_Tool::Curve(e, f, l);
        if (c.IsNull()) {
          continue;
        }
        keep.push_back(e);
        curves.push_back(c);
      }
      double residual = 0.0;
      gp_Pnt q = solve_corner(p, sas, curves, residual);
      if (residual > 1e-7) {
        ++refused;
        continue;
      }
      for (size_t k = 0; k < keep.size(); ++k) {
        BRepAdaptor_Curve now(keep[k]);
        gp_Pnt at;
        double t = 0.0;
        on_curve(q, curves[k], at, t);
        if (TopExp::FirstVertex(keep[k]).IsSame(v)) {
          builder.Range(keep[k], t, now.LastParameter());
        } else {
          builder.Range(keep[k], now.FirstParameter(), t);
        }
      }
      builder.UpdateVertex(v, q, 1e-7);
    }
  }
  return refused;
}

// The uv where `edge` starts and ends as `face` runs along it.
inline std::pair<gp_Pnt2d, gp_Pnt2d> run_ends(const TopoDS_Edge &edge, const TopoDS_Face &face) {
  double f = 0.0, l = 0.0;
  Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(edge, face, f, l);
  gp_Pnt2d a = pc->Value(f), b = pc->Value(l);
  return edge.Orientation() == TopAbs_REVERSED ? std::make_pair(b, a) : std::make_pair(a, b);
}

// Redrawn pcurves moved by whole periods to carry on from the edge before
// them in their wire. Returns the breaks in those wires left after.
inline int wire_periods(const TopoDS_Shape &body, const TopTools_IndexedMapOfShape &redrawn) {
  BRep_Builder builder;
  int broken = 0;
  for (TopExp_Explorer fx(body, TopAbs_FACE); fx.More(); fx.Next()) {
    const TopoDS_Face &face = TopoDS::Face(fx.Current());
    Periods per = periods(face);
    for (TopExp_Explorer wx(face, TopAbs_WIRE); wx.More(); wx.Next()) {
      std::vector<TopoDS_Edge> rows;
      for (BRepTools_WireExplorer e(TopoDS::Wire(wx.Current()), face); e.More(); e.Next()) {
        rows.push_back(e.Current());
      }
      if (std::none_of(rows.begin(), rows.end(), [&](const TopoDS_Edge &e) { return redrawn.Contains(e); })) {
        continue;
      }
      const size_t n = rows.size();
      if (per.u > 0.0 || per.v > 0.0) {
        size_t start = 0;
        while (start < n && redrawn.Contains(rows[start])) {
          ++start;
        }
        start = start % n;
        for (size_t step = 1; step < n; ++step) {
          size_t k = (start + step) % n;
          if (!redrawn.Contains(rows[k])) {
            continue;
          }
          gp_Pnt2d before = run_ends(rows[(k + n - 1) % n], face).second, mine = run_ends(rows[k], face).first;
          double du = shift(mine.X(), before.X(), per.u) - mine.X(), dv = shift(mine.Y(), before.Y(), per.v) - mine.Y();
          if (std::abs(du) > 1e-9 || std::abs(dv) > 1e-9) {
            double f = 0.0, l = 0.0;
            Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(rows[k], face, f, l);
            Handle(Geom2d_Curve) moved = Handle(Geom2d_Curve)::DownCast(pc->Translated(gp_Vec2d(du, dv)));
            builder.UpdateEdge(rows[k], moved, face, BRep_Tool::Tolerance(rows[k]));
          }
        }
      }
      for (size_t k = 0; k < n; ++k) {
        if (run_ends(rows[(k + n - 1) % n], face).second.Distance(run_ends(rows[k], face).first) > 1e-3) {
          ++broken;
        }
      }
    }
  }
  return broken;
}

// Edges counted as bo_skin_census counts them: open, crowded, flipped.
inline int skin_faults(const TopoDS_Shape &solid) {
  NCollection_DataMap<TopoDS_Shape, std::pair<int, int>, TopTools_ShapeMapHasher> sides;
  for (TopExp_Explorer f(solid, TopAbs_FACE); f.More(); f.Next()) {
    TopAbs_Orientation fo = f.Current().Orientation();
    if (fo != TopAbs_FORWARD && fo != TopAbs_REVERSED) {
      continue;
    }
    for (TopExp_Explorer x(f.Current(), TopAbs_EDGE); x.More(); x.Next()) {
      TopAbs_Orientation o = x.Current().Orientation();
      if ((o != TopAbs_FORWARD && o != TopAbs_REVERSED) || BRep_Tool::Degenerated(TopoDS::Edge(x.Current()))) {
        continue;
      }
      std::pair<int, int> *use = sides.ChangeSeek(x.Current());
      if (!use) {
        sides.Bind(x.Current(), std::make_pair(0, 0));
        use = sides.ChangeSeek(x.Current());
      }
      ++(o == TopAbs_FORWARD ? use->first : use->second);
    }
  }
  int faults = 0;
  for (auto it = NCollection_DataMap<TopoDS_Shape, std::pair<int, int>, TopTools_ShapeMapHasher>::Iterator(sides);
       it.More(); it.Next()) {
    const int along = it.Value().first, against = it.Value().second;
    faults += (along + against != 2 || along != against) ? 1 : 0;
  }
  return faults;
}

// The volume a mesh of `shape` encloses at `deflection`, and its area.
inline double mesh_volume(const TopoDS_Shape &shape, double deflection, double &area) {
  TopoDS_Shape copy = BRepBuilderAPI_Copy(shape, true, false).Shape();
  BRepMesh_IncrementalMesh(copy, deflection, false, 0.2, false);
  double volume = 0.0;
  area = 0.0;
  for (TopExp_Explorer fx(copy, TopAbs_FACE); fx.More(); fx.Next()) {
    const TopoDS_Face &face = TopoDS::Face(fx.Current());
    TopLoc_Location loc;
    Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
    if (tri.IsNull()) {
      continue;
    }
    const gp_Trsf &place = loc.Transformation();
    const bool reversed = face.Orientation() == TopAbs_REVERSED;
    for (int k = 1; k <= tri->NbTriangles(); ++k) {
      int i1 = 0, i2 = 0, i3 = 0;
      tri->Triangle(k).Get(i1, i2, i3);
      if (reversed) {
        std::swap(i2, i3);
      }
      gp_XYZ a = tri->Node(i1).Transformed(place).XYZ(), b = tri->Node(i2).Transformed(place).XYZ(),
             c = tri->Node(i3).Transformed(place).XYZ();
      volume += a.Dot(b.Crossed(c)) / 6.0;
      area += (b - a).Crossed(c - a).Modulus() / 2.0;
    }
  }
  return volume;
}

inline double exact_volume(const TopoDS_Shape &shape) {
  GProp_GProps props;
  BRepGProp::VolumeProperties(shape, props);
  return props.Mass();
}

inline void heal(const TopoDS_Solid &source, StepHeal &out) {
  TopoDS_Shape body = BRepBuilderAPI_Copy(source, true, false).Shape();
  std::vector<Off> offs = off_edges(body);
  TopTools_IndexedMapOfShape off, redrawn;
  for (const Off &o : offs) {
    off.Add(o.edge);
  }
  fix_corners(body, offs, off);

  BRep_Builder builder;
  std::vector<std::pair<double, double>> drawn;
  for (const Off &o : offs) {
    if (o.faces.size() != 2) {
      ++out.refused[NOT_TWO];
      continue;
    }
    TopoDS_Face faces[2] = {o.faces[0], o.faces[1]};
    Drawn d;
    const char *why = nullptr;
    try {
      for (int n : {48, 96, 192}) {
        why = meet(o.edge, faces, n, off, d);
        if (why || d.deviation <= 1e-5) {
          break;
        }
      }
    } catch (const Standard_Failure &) {
      why = CURVE;
    }
    if (!why && d.deviation > STEP_HEAL_LIMIT) {
      why = CURVE;
    }
    if (why) {
      ++out.refused[why];
      continue;
    }
    const double tol = std::max(1.5 * d.deviation, 1e-7);
    builder.UpdateEdge(o.edge, d.curve, tol);
    builder.UpdateEdge(o.edge, d.on[0], faces[0], tol);
    builder.UpdateEdge(o.edge, d.on[1], faces[1], tol);
    builder.Range(o.edge, 0.0, d.length);
    builder.SameParameter(o.edge, true);
    builder.SameRange(o.edge, true);
    redrawn.Add(o.edge);
    drawn.push_back({d.length, d.deviation});
  }
  out.redrawn = redrawn.Extent();
  if (out.redrawn == 0) {
    return;
  }
  const int broken = wire_periods(body, redrawn);
  ShapeFix_ShapeTolerance().SetTolerance(body, 1e-7);
  BRepLib::SameParameter(body, 1e-7, true);
  BRepLib::UpdateTolerances(body, false);

  // ShapeFix turns good wires the wrong way on a face whose outline is broken,
  // so a wire is only turned on a face that has none.
  if (broken == 0) {
    Handle(BRepTools_ReShape) reshape = new BRepTools_ReShape();
    for (TopExp_Explorer fx(body, TopAbs_FACE); fx.More(); fx.Next()) {
      const TopoDS_Face &face = TopoDS::Face(fx.Current());
      bool wrong = false;
      for (TopExp_Explorer wx(face, TopAbs_WIRE); wx.More() && !wrong; wx.Next()) {
        wrong = BRepCheck_Wire(TopoDS::Wire(wx.Current())).Orientation(face, false) != BRepCheck_NoError;
      }
      if (wrong) {
        ShapeFix_Face fix(face);
        fix.FixOrientation();
        reshape->Replace(face, fix.Face());
        ++out.turned;
      }
    }
    if (out.turned > 0) {
      body = reshape->Apply(body);
    }
  }

  if (body.ShapeType() != TopAbs_SOLID || !BRepCheck_Analyzer(body).IsValid()) {
    out.why_not = "the kernel's validity check rejects the redrawn body";
    return;
  }
  if (skin_faults(body) > 0) {
    out.why_not = "the redrawn body does not close";
    return;
  }
  Bnd_Box box;
  BRepBndLib::Add(body, box);
  if (box.IsVoid()) {
    out.why_not = "the redrawn body is empty";
    return;
  }
  const double diagonal = std::sqrt(box.SquareExtent());
  // An absolute deflection keeps the bound tight on a part the size of a
  // hand, a large part is meshed coarser so this stays quick.
  const double deflection = std::max(0.01, 1e-4 * diagonal);
  double area = 0.0;
  const double exact = exact_volume(body), meshed = mesh_volume(body, deflection, area);
  double bound = area * deflection;
  for (const auto &d : drawn) {
    bound += d.first * d.second * diagonal;
  }
  if (!(exact > 0.0) || std::abs(exact - meshed) > bound) {
    out.why_not = "the redrawn body's volume does not match a mesh of it";
    return;
  }
  out.solid = TopoDS::Solid(body);
  out.healed = true;
}

} // namespace step_heal_detail

// `solid` healed when an edge of it lies more than STEP_HEAL_LIMIT from a face
// it bounds. `healed` is set only when the result is sound, with the same
// faces in the same order.
inline StepHeal step_heal(const TopoDS_Solid &solid) {
  StepHeal out;
  bool loose = false;
  for (TopExp_Explorer ex(solid, TopAbs_EDGE); ex.More() && !loose; ex.Next()) {
    const TopoDS_Edge &e = TopoDS::Edge(ex.Current());
    loose = BRep_Tool::Tolerance(e) > STEP_HEAL_LIMIT || !BRep_Tool::SameParameter(e);
  }
  // An edge within its tolerance of its faces cannot be farther off than
  // that, so a solid of tight edges costs nothing here.
  if (!loose) {
    return out;
  }
  out.away = step_heal_edges_away(solid, STEP_HEAL_LIMIT, out.widest);
  if (out.away == 0) {
    return out;
  }
  try {
    step_heal_detail::heal(solid, out);
  } catch (const Standard_Failure &) {
    out.healed = false;
    out.why_not = "the kernel failed while redrawing them";
  }
  return out;
}

inline std::string step_heal_count(int n, const char *noun) {
  return std::to_string(n) + " " + noun + (n == 1 ? "" : "s");
}

// What healing did to a solid, empty when no edge was away from its faces.
inline std::string step_heal_note(const StepHeal &h) {
  if (h.away == 0) {
    return std::string();
  }
  char gap[32];
  std::snprintf(gap, sizeof gap, "%.2g", h.widest);
  if (h.healed) {
    const bool one = h.redrawn == 1;
    std::string said = step_heal_count(h.redrawn, "edge") + " the file draws up to " + gap + " mm away from " +
                       (one ? "its faces was" : "their faces were") + " redrawn where they meet";
    if (h.refused_count() > 0) {
      said += ", " + step_heal_count(h.refused_count(), "edge") + (h.refused_count() == 1 ? " was" : " were") +
              " not because " + h.main_refusal();
    }
    if (h.turned > 0) {
      said += ", the outline of " + step_heal_count(h.turned, "face") + " ran the wrong way and was turned";
    }
    return said;
  }
  const bool one = h.away == 1;
  return step_heal_count(h.away, "edge") + (one ? " is" : " are") + " drawn up to " + gap +
         " mm away from the faces " + (one ? "it bounds" : "they bound") +
         ", a section or a mesh of this body can gap there, " + (one ? "it was" : "they were") +
         " not redrawn because " + (h.redrawn == 0 && h.why_not.empty() ? h.main_refusal() : h.why_not);
}
