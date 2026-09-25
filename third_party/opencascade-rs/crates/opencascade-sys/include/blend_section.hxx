// the Python engine's `section_blend.py`: fillets and chamfers built from their cross section
// for the ones BRepFilletAPI refuses. At each sample along the edge the two
// faces give the ball centre, its contacts and the arc (a G2 curve, a conic or
// a chord), the section closes a hair outside the body, the sections are lofted
// and the loft is cut from a convex edge or fused onto a concave one.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Curve2d.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_BooleanOperation.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_FindPlane.hxx>
#include <BRepBuilderAPI_GTransform.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GC_MakeSegment.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Message_ProgressRange.hxx>
#include <Message_ProgressScope.hxx>
#include <Geom_BezierCurve.hxx>
#include <Geom_BezierSurface.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColStd_Array2OfReal.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_GTrsf.hxx>
#include <gp_Lin.hxx>
#include <gp_Mat.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <functional>
#include <memory>
#include <string>
#include <tuple>
#include <vector>

namespace secblend {

const double G2_SETBACK = 1.55;
const double G2_TENSION = 0.5;
const int SKIN_STEPS = 4;

struct SectionError {
  std::string msg;
};
struct DraftGaveUp : SectionError {
  explicit DraftGaveUp(const std::string &m) { msg = m; }
};

enum class Misfit { None, OffFace, AcrossAxis, IntoBody, Mixed };

// The ball does not fit the edge at the asked size. `fits` is the largest
// share of that size that does, NaN when none does.
struct TooLarge : SectionError {
  Misfit why;
  double fits;
  gp_Pnt at;
  TooLarge(Misfit w, double f, const gp_Pnt &p) : why(w), fits(f), at(p) { msg = "the blend does not fit the edge"; }
};

// Opt needs C++17, which the bridges do not build with.
template <typename T> struct Opt {
  bool has = false;
  T val{};
  Opt() {}
  Opt(const T &v) : has(true), val(v) {}
  explicit operator bool() const { return has; }
  T &operator*() { return val; }
  const T &operator*() const { return val; }
  T *operator->() { return &val; }
  const T *operator->() const { return &val; }
  void reset() { has = false; }
};

inline SectionError err(const std::string &m) { return SectionError{m}; }

// The job was cancelled. Not a SectionError, so no fallback swallows it.
struct Cancelled {};

// The cancel of the job this thread is building for, while blend_section runs.
// Every boolean takes a fresh range from it, so OCCT can stop mid boolean too.
struct CancelScope {
  Message_ProgressScope scope;
  CancelScope *prev;
  explicit CancelScope(const Message_ProgressRange &range);
  ~CancelScope();
  CancelScope(const CancelScope &) = delete;
  CancelScope &operator=(const CancelScope &) = delete;
};

inline CancelScope *&current_cancel() {
  static thread_local CancelScope *cur = nullptr;
  return cur;
}

inline CancelScope::CancelScope(const Message_ProgressRange &range)
    : scope(range, nullptr, 1.0, true), prev(current_cancel()) {
  current_cancel() = this;
}

inline CancelScope::~CancelScope() { current_cancel() = prev; }

inline void check_cancel() {
  CancelScope *c = current_cancel();
  if (c != nullptr && c->scope.UserBreak()) throw Cancelled{};
}

inline Message_ProgressRange next_range() {
  CancelScope *c = current_cancel();
  return c != nullptr ? c->scope.Next() : Message_ProgressRange();
}

inline gp_Vec V(const gp_Pnt &p) { return gp_Vec(p.X(), p.Y(), p.Z()); }
inline gp_Pnt P(const gp_Vec &v) { return gp_Pnt(v.X(), v.Y(), v.Z()); }

inline double conic_weight_scale(double profile) {
  double p = std::isnan(profile) ? 0.0 : std::max(-0.99, std::min(0.95, profile));
  return p <= 0 ? 1.0 + p : 1.0 / (1.0 - p);
}

// A G2 section with every weight 1. The profile used to scale the middle
// weight, up to 20, and 400 at a corner patch, which kept OCCT's booleans busy
// for minutes. Here it slides the control points instead: towards the corner
// for a fuller section, towards the chord for a flatter one. The first three
// points stay on each face's tangent line, so the curvature still meets the
// face at zero, and profile 0 is exactly the plain G2 section.
inline std::vector<gp_Vec> g2_poles(const gp_Vec &Qa, const gp_Vec &K, const gp_Vec &Qb, double profile) {
  double p = std::isnan(profile) ? 0.0 : std::max(-0.99, std::min(0.95, profile));
  double t = 1 - G2_TENSION;
  std::vector<gp_Vec> ps = {Qa, Qa + (K - Qa).Multiplied(t), K, Qb + (K - Qb).Multiplied(t), Qb};
  for (int n = 4; n < 6; ++n) {
    std::vector<gp_Vec> up = {ps.front()};
    for (int i = 1; i <= n; ++i) {
      double a = static_cast<double>(i) / (n + 1);
      up.push_back(ps[i - 1].Multiplied(a) + ps[i].Multiplied(1 - a));
    }
    up.push_back(ps.back());
    ps = up;
  }
  if (std::abs(p) < 1e-12) return ps;
  gp_Vec M = (Qa + Qb).Multiplied(0.5);
  std::vector<gp_Vec> limit = p > 0 ? std::vector<gp_Vec>{Qa, K, K, K, K, K, Qb}
                                    : std::vector<gp_Vec>{Qa, Qa, Qa, M, Qb, Qb, Qb};
  double w = std::abs(p);
  for (size_t i = 1; i + 1 < ps.size(); ++i) ps[i] = ps[i].Multiplied(1 - w) + limit[i].Multiplied(w);
  return ps;
}

enum class Op { Cut, Fuse, Common };

inline int solid_count(const TopoDS_Shape &s) {
  int n = 0;
  for (TopExp_Explorer ex(s, TopAbs_SOLID); ex.More(); ex.Next()) ++n;
  return n;
}

inline double volume(const TopoDS_Shape &s) {
  GProp_GProps g;
  BRepGProp::VolumeProperties(s, g);
  return g.Mass();
}

inline TopoDS_Shape copy(const TopoDS_Shape &s) { return BRepBuilderAPI_Copy(s, false).Shape(); }

// A section that leaves the plane of its frame, as it does on a surface curving
// along the edge, gets no cap. A boolean with the open shell left is garbage, a
// 1.1 mm3 tool had nothing in common with the body and still cut 15 mm3 from
// it, and the retries around it spent 15 s before giving up.
inline bool closed_solid(const TopoDS_Shape &s) {
  if (solid_count(s) == 0) return false;
  TopTools_IndexedDataMapOfShapeListOfShape m;
  TopExp::MapShapesAndAncestors(s, TopAbs_EDGE, TopAbs_FACE, m);
  for (int i = 1; i <= m.Extent(); ++i)
    if (m(i).Extent() < 2 && !BRep_Tool::Degenerated(TopoDS::Edge(m.FindKey(i)))) return false;
  return true;
}

constexpr double LOFT_PLANE_TOL = 1e-6;

// ThruSections caps each end of a loft with a plane through the end wire, else
// with a face the wire alone makes (its PerformPlan). A section with neither
// leaves the loft open, and every section on a surface curving along the edge
// is like that, so the first one is checked before sampling the rest.
inline bool cappable(const TopoDS_Wire &w) {
  return BRepBuilderAPI_FindPlane(w, LOFT_PLANE_TOL).Found() || BRepBuilderAPI_MakeFace(w).IsDone();
}

struct Side {
  TopoDS_Face face;
  BRepGProp_Face props;
  Handle(Geom_Surface) surf;
  bool planar;
  BRepAdaptor_Curve2d pcurve;
  int inward_sign = 1;
  gp_Vec inward_cached;
  gp_Vec normal_on_edge_cached;

  Side(const TopoDS_Face &f, const TopoDS_Edge &edge)
      : face(f), props(f), surf(BRep_Tool::Surface(f)),
        planar(BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane), pcurve(edge, f) {}

  gp_Vec normal_uv(double u, double v) {
    gp_Pnt p;
    gp_Vec n;
    props.Normal(u, v, p, n);
    if (n.Magnitude() < 1e-12) throw err("a face normal degenerates along the edge");
    return n.Normalized();
  }

  gp_Vec normal_on_edge(double t) {
    gp_Pnt2d uv = pcurve.Value(t);
    return normal_uv(uv.X(), uv.Y());
  }

  Opt<std::pair<gp_Pnt, gp_Vec>> foot(const gp_Pnt &pnt) {
    if (planar) return {};
    GeomAPI_ProjectPointOnSurf proj(pnt, surf);
    if (proj.NbPoints() == 0) return {};
    double u, v;
    proj.LowerDistanceParameters(u, v);
    gp_Pnt q = proj.NearestPoint();
    return std::make_pair(q, normal_uv(u, v));
  }

  bool contains(const gp_Pnt &pnt, double tol) {
    GeomAPI_ProjectPointOnSurf proj(pnt, surf);
    if (proj.NbPoints() == 0) return false;
    double u, v;
    proj.LowerDistanceParameters(u, v);
    TopAbs_State st = BRepClass_FaceClassifier(face, gp_Pnt2d(u, v), tol).State();
    return st == TopAbs_IN || st == TopAbs_ON;
  }
};

using Sides = std::vector<std::unique_ptr<Side>>;

inline std::vector<TopoDS_Face> faces_of(const TopoDS_Shape &shape, const TopoDS_Shape &edge) {
  TopTools_IndexedDataMapOfShapeListOfShape m;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, m);
  int idx = m.FindIndex(edge);
  if (idx == 0) throw err("the edge is not on this body");
  std::vector<TopoDS_Face> uniq;
  for (TopTools_ListOfShape::Iterator it(m.FindFromIndex(idx)); it.More(); it.Next()) {
    bool seen = false;
    for (const TopoDS_Face &g : uniq) seen = seen || it.Value().IsSame(g);
    if (!seen) uniq.push_back(TopoDS::Face(it.Value()));
  }
  if (uniq.size() != 2) throw err("the edge does not sit between two faces");
  return uniq;
}

inline Opt<gp_Vec> solve3(const double rows[3][3], const double rhs[3]) {
  double a = rows[0][0], b = rows[0][1], c = rows[0][2];
  double d = rows[1][0], e = rows[1][1], f = rows[1][2];
  double g = rows[2][0], h = rows[2][1], i = rows[2][2];
  double det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (std::abs(det) < 1e-14) return {};
  double x = (rhs[0] * (e * i - f * h) - b * (rhs[1] * i - f * rhs[2]) + c * (rhs[1] * h - e * rhs[2])) / det;
  double y = (a * (rhs[1] * i - f * rhs[2]) - rhs[0] * (d * i - f * g) + c * (d * rhs[2] - rhs[1] * g)) / det;
  double z = (a * (e * rhs[2] - rhs[1] * h) - b * (d * rhs[2] - rhs[1] * g) + rhs[0] * (d * h - e * g)) / det;
  return gp_Vec(x, y, z);
}

struct Ball {
  gp_Vec C;
  gp_Vec feet[2];
  gp_Vec normals[2];
};

inline Ball ball(const gp_Pnt &Pp, const gp_Vec &T, Sides &sides, gp_Vec n0[2], int s, double r) {
  gp_Vec Pv = V(Pp);
  Ball out;
  out.feet[0] = Pv;
  out.feet[1] = Pv;
  out.normals[0] = n0[0];
  out.normals[1] = n0[1];
  for (int it = 0; it < 4; ++it) {
    double rows[3][3] = {{out.normals[0].X(), out.normals[0].Y(), out.normals[0].Z()},
                         {out.normals[1].X(), out.normals[1].Y(), out.normals[1].Z()},
                         {T.X(), T.Y(), T.Z()}};
    double rhs[3] = {out.feet[0].Dot(out.normals[0]) - s * r, out.feet[1].Dot(out.normals[1]) - s * r, Pv.Dot(T)};
    auto nxt = solve3(rows, rhs);
    if (!nxt) throw err("the faces are parallel here, there is no corner to round");
    out.C = *nxt;
    bool moved = false;
    for (int k = 0; k < 2; ++k) {
      auto got = sides[k]->foot(P(out.C));
      if (!got) {
        out.feet[k] = out.C + out.normals[k].Multiplied(s * r);
        continue;
      }
      gp_Vec n = got->second;
      if (n.Dot(out.normals[k]) < 0) n.Reverse();
      out.feet[k] = V(got->first);
      out.normals[k] = n;
      moved = true;
    }
    if (!moved) break;
  }
  return out;
}

inline TopoDS_Wire make_wire(const std::vector<gp_Pnt> &points, const Handle(Geom_Curve) & curve) {
  BRepBuilderAPI_MakeWire mk;
  for (size_t i = 0; i + 1 < points.size(); ++i) {
    if (points[i].Distance(points[i + 1]) < 1e-9) continue;
    // From the pointer: GCC will not apply OCCT's templated upcast operator
    // to this copy initialisation, which MSVC accepts.
    Handle(Geom_Curve) seg(GC_MakeSegment(points[i], points[i + 1]).Value().get());
    mk.Add(BRepBuilderAPI_MakeEdge(seg).Edge());
  }
  mk.Add(BRepBuilderAPI_MakeEdge(curve).Edge());
  if (!mk.IsDone()) throw err("the blend section did not close");
  return mk.Wire();
}

inline std::vector<gp_Pnt> skin(Side &side, const gp_Vec &normal, const gp_Pnt &a, const gp_Pnt &b, double offset,
                                double reach) {
  std::vector<gp_Pnt> out;
  for (int j = 0; j <= SKIN_STEPS; ++j) {
    gp_Pnt q = P(V(a) + (V(b) - V(a)).Multiplied(static_cast<double>(j) / SKIN_STEPS));
    gp_Pnt foot = q;
    gp_Vec n = normal;
    auto got = side.foot(q);
    if (got && got->first.Distance(q) < reach) {
      foot = got->first;
      n = got->second;
      if (n.Dot(normal) < 0) n.Reverse();
    }
    out.push_back(P(V(foot) + n.Multiplied(offset)));
  }
  return out;
}

inline gp_Pnt corner(const gp_Pnt &Q1, const gp_Pnt &Q2, const gp_Vec &n1, const gp_Vec &n2, const gp_Pnt &Pp) {
  gp_Vec w1 = V(Pp) - V(Q1);
  w1 = w1 - n1.Multiplied(w1.Dot(n1));
  gp_Vec w2 = V(Pp) - V(Q2);
  w2 = w2 - n2.Multiplied(w2.Dot(n2));
  if (w1.Magnitude() < 1e-9 || w2.Magnitude() < 1e-9) return Pp;
  w1.Normalize();
  w2.Normalize();
  gp_Vec d = V(Q1) - V(Q2);
  double a = w1.Dot(w1), b = w1.Dot(w2), e = w2.Dot(w2);
  double c = w1.Dot(d), f = w2.Dot(d);
  double den = a * e - b * b;
  if (std::abs(den) < 1e-12) return Pp;
  double t1 = (b * f - c * e) / den;
  double t2 = (a * f - b * c) / den;
  return P((V(Q1) + w1.Multiplied(t1) + V(Q2) + w2.Multiplied(t2)).Multiplied(0.5));
}

inline bool clamp_to_axis(gp_Pnt Q[2], const gp_Pnt &K, const gp_Pnt &Pp, const gp_Ax1 &axis) {
  gp_Vec loc(axis.Location().XYZ()), d(axis.Direction());
  auto radial = [&](const gp_Pnt &p) {
    gp_Vec w = V(p) - loc;
    return w - d.Multiplied(w.Dot(d));
  };
  gp_Vec out = radial(Pp);
  if (out.Magnitude() < 1e-9) return false;
  out.Normalize();
  double rk = radial(K).Dot(out);
  bool moved = false;
  for (int k = 0; k < 2; ++k) {
    double rq = radial(Q[k]).Dot(out);
    if (rq >= 0 || rk <= 0) continue;
    double t = rk / (rk - rq);
    Q[k] = P(V(K) + (V(Q[k]) - V(K)).Multiplied(t));
    moved = true;
  }
  return moved;
}

struct Contacts {
  gp_Pnt Q[2];
  gp_Pnt K;
  Opt<gp_Vec> C;
  gp_Vec normals[2];
};

inline Contacts contacts(const gp_Pnt &Pp, const gp_Vec &T, Sides &sides, int s, bool chamfer, double size,
                         double size2, bool g2) {
  gp_Vec n1 = sides[0]->normal_on_edge_cached, n2 = sides[1]->normal_on_edge_cached;
  Contacts out;
  if (chamfer) {
    double ds[2] = {size, (size2 != 0 && !std::isnan(size2)) ? size2 : size};
    for (int k = 0; k < 2; ++k) {
      gp_Pnt q = P(V(Pp) + sides[k]->inward_cached.Multiplied(ds[k]));
      auto got = sides[k]->foot(q);
      out.Q[k] = got ? got->first : q;
    }
    out.K = Pp;
    out.normals[0] = n1;
    out.normals[1] = n2;
    return out;
  }
  double r = g2 ? size * G2_SETBACK : size;
  gp_Vec n0[2] = {n1, n2};
  Ball b = ball(Pp, T, sides, n0, s, r);
  out.Q[0] = P(b.feet[0]);
  out.Q[1] = P(b.feet[1]);
  out.C = b.C;
  out.normals[0] = b.normals[0];
  out.normals[1] = b.normals[1];
  out.K = corner(out.Q[0], out.Q[1], b.normals[0], b.normals[1], Pp);
  return out;
}

inline Handle(Geom_Curve) make_conic(const gp_Pnt &Q0, const gp_Pnt &K, const gp_Pnt &Q1, double weight) {
  TColgp_Array1OfPnt poles(1, 3);
  poles.SetValue(1, Q0);
  poles.SetValue(2, K);
  poles.SetValue(3, Q1);
  TColStd_Array1OfReal weights(1, 3);
  weights.SetValue(1, 1.0);
  weights.SetValue(2, weight);
  weights.SetValue(3, 1.0);
  return new Geom_BezierCurve(poles, weights);
}

struct Section {
  TopoDS_Wire wire;
  gp_Vec inner;
};

inline Section section(const gp_Pnt &Pp, const gp_Vec &T, Sides &sides, int s, bool chamfer, double size,
                       double size2, bool g2, double profile, const gp_Ax1 *axis, double margin) {
  gp_Vec n1 = sides[0]->normal_on_edge_cached, n2 = sides[1]->normal_on_edge_cached;
  double c = std::max(-1.0, std::min(1.0, n1.Dot(n2)));
  if (1 + c < 1e-3) throw err("the faces fold back on each other here");
  gp_Vec m = (n1 + n2).Multiplied(1.0 / (1 + c));
  Contacts ct = contacts(Pp, T, sides, s, chamfer, size, size2, g2);
  gp_Pnt *Q = ct.Q;
  Handle(Geom_Curve) curve;
  if (chamfer) {
    if (axis != nullptr) clamp_to_axis(Q, Pp, Pp, *axis);
    curve = GC_MakeSegment(Q[1], Q[0]).Value();
  } else {
    gp_Pnt K = ct.K;
    bool clamped = axis != nullptr && clamp_to_axis(Q, K, Pp, *axis);
    double k = conic_weight_scale(profile);
    if (g2 && std::abs(profile) < 1e-12) {
      TColgp_Array1OfPnt poles(1, 5);
      poles.SetValue(1, Q[1]);
      poles.SetValue(2, P(V(Q[1]) + (V(K) - V(Q[1])).Multiplied(1 - G2_TENSION)));
      poles.SetValue(3, K);
      poles.SetValue(4, P(V(Q[0]) + (V(K) - V(Q[0])).Multiplied(1 - G2_TENSION)));
      poles.SetValue(5, Q[0]);
      curve = new Geom_BezierCurve(poles);
    } else if (g2) {
      std::vector<gp_Vec> ps = g2_poles(V(Q[1]), V(K), V(Q[0]), profile);
      TColgp_Array1OfPnt poles(1, static_cast<int>(ps.size()));
      for (size_t j = 0; j < ps.size(); ++j) poles.SetValue(static_cast<int>(j) + 1, P(ps[j]));
      curve = new Geom_BezierCurve(poles);
    } else if (clamped || std::abs(k - 1.0) > 1e-9) {
      gp_Vec a = V(Q[0]) - V(K), b = V(Q[1]) - V(K);
      if (a.Magnitude() < 1e-9 || b.Magnitude() < 1e-9) throw err("the blend centre sits on the edge");
      curve = make_conic(Q[1], K, Q[0], std::sin(a.Angle(b) / 2) * k);
    } else {
      gp_Vec toward = V(Pp) - *ct.C;
      if (toward.Magnitude() < 1e-12) throw err("the blend centre sits on the edge");
      gp_Pnt mid = P(*ct.C + toward.Normalized().Multiplied(size));
      curve = GC_MakeArcOfCircle(Q[1], mid, Q[0]).Value();
    }
  }
  double reach = std::max({Q[0].Distance(Pp), Q[1].Distance(Pp), size});
  double e = std::max(0.02 * size, 0.01) * margin;
  gp_Pnt K = P(V(Pp) + m.Multiplied(s * e));
  std::vector<gp_Pnt> run = {Q[0]};
  std::vector<gp_Pnt> sk0 = skin(*sides[0], ct.normals[0], Q[0], Pp, s * e, reach);
  run.insert(run.end(), sk0.begin(), sk0.end() - 1);
  run.push_back(K);
  std::vector<gp_Pnt> sk1 = skin(*sides[1], ct.normals[1], Pp, Q[1], s * e, reach);
  run.insert(run.end(), sk1.begin() + 1, sk1.end());
  run.push_back(Q[1]);
  gp_Vec inner = chamfer ? (V(Q[0]) + V(Q[1])).Multiplied(0.5) : *ct.C;
  return {make_wire(run, curve), inner};
}

inline int convexity(const gp_Pnt &Pp, const gp_Vec &T, Sides &sides, const gp_Vec &n1, const gp_Vec &n2,
                     double tol) {
  double step = std::max(tol * 20, 1e-4);
  const gp_Vec ns[2] = {n1, n2};
  for (int k = 0; k < 2; ++k) {
    gp_Vec d = ns[k].Crossed(T);
    if (d.Magnitude() < 1e-12) throw err("the edge runs along a face normal");
    d.Normalize();
    sides[k]->inward_sign = 1;
    if (!sides[k]->contains(P(V(Pp) + d.Multiplied(step)), tol)) {
      d.Reverse();
      sides[k]->inward_sign = -1;
    }
    sides[k]->inward_cached = d;
  }
  return sides[0]->inward_cached.Dot(n2) < 0 ? 1 : -1;
}

// --- sampling and classification -------------------------------------------

inline void points_inside(const TopoDS_Shape &tool, bool verify, const std::function<bool(const gp_Pnt &)> &yield) {
  Bnd_Box box;
  BRepBndLib::Add(tool, box);
  if (box.IsVoid()) return;
  double depth = 1e-3 * std::sqrt(box.SquareExtent());
  std::unique_ptr<BRepClass3d_SolidClassifier> cls;
  if (verify) cls.reset(new BRepClass3d_SolidClassifier(tool));
  for (TopExp_Explorer ex(tool, TopAbs_FACE); ex.More(); ex.Next()) {
    TopoDS_Face f = TopoDS::Face(ex.Current());
    double u0, u1, v0, v1;
    BRepTools::UVBounds(f, u0, u1, v0, v1);
    BRepGProp_Face props(f);
    const double ab[3][2] = {{0.5, 0.5}, {0.3, 0.7}, {0.7, 0.3}};
    for (auto &q : ab) {
      gp_Pnt pt;
      gp_Vec n;
      props.Normal(u0 + (u1 - u0) * q[0], v0 + (v1 - v0) * q[1], pt, n);
      if (n.Magnitude() < 1e-12) continue;
      gp_Pnt p = P(V(pt) - n.Normalized().Multiplied(depth));
      if (!verify) {
        if (!yield(p)) return;
        continue;
      }
      cls->Perform(p, 1e-9);
      if (cls->State() == TopAbs_IN) {
        if (!yield(p)) return;
      }
    }
  }
}

struct NearTools {
  struct Entry {
    Bnd_Box box;
    TopoDS_Shape tool;
    std::unique_ptr<BRepClass3d_SolidClassifier> cls;
  };
  std::vector<Entry> boxes;

  explicit NearTools(const std::vector<TopoDS_Shape> &tools) {
    for (const TopoDS_Shape &t : tools) {
      Bnd_Box box;
      BRepBndLib::Add(t, box);
      if (!box.IsVoid()) {
        box.Enlarge(1e-3);
        boxes.push_back({box, t, nullptr});
      }
    }
  }

  bool hit(const gp_Pnt &p, const std::function<bool(TopAbs_State)> &test) {
    for (auto &e : boxes) {
      if (e.box.IsOut(p)) continue;
      if (!e.cls) e.cls.reset(new BRepClass3d_SolidClassifier(e.tool));
      e.cls->Perform(p, 1e-9);
      if (test(e.cls->State())) return true;
    }
    return false;
  }
};

inline bool sane_volume(const TopoDS_Shape &shape) {
  double mass = volume(shape);
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  if (box.IsVoid()) return false;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  double b = (x1 - x0) * (y1 - y0) * (z1 - z0);
  return std::isfinite(mass) && 1e-6 * b < mass && mass <= 1.01 * b;
}

inline bool within_by(const TopoDS_Shape &shape, const TopoDS_Shape &trim, bool verify) {
  BRepClass3d_SolidClassifier cls(trim);
  bool ok = true;
  points_inside(shape, verify, [&](const gp_Pnt &p) {
    cls.Perform(p, 1e-6);
    if (cls.State() == TopAbs_OUT) {
      ok = false;
      return false;
    }
    return true;
  });
  return ok;
}

inline bool within(const TopoDS_Shape &shape, const TopoDS_Shape &trim) {
  return within_by(shape, trim, false) || within_by(shape, trim, true);
}

inline bool inside_point(const TopoDS_Shape &tool, const TopoDS_Shape &trim) {
  BRepClass3d_SolidClassifier trim_cls(trim);
  bool result = false;
  points_inside(tool, true, [&](const gp_Pnt &p) {
    trim_cls.Perform(p, 1e-9);
    result = trim_cls.State() == TopAbs_IN;
    return false;
  });
  return result;
}

inline TopoDS_Shape grown(const TopoDS_Shape &solid, double factor) {
  GProp_GProps g;
  BRepGProp::VolumeProperties(solid, g);
  gp_Trsf tr;
  tr.SetScale(g.CentreOfMass(), 1.0 + factor);
  return BRepBuilderAPI_Transform(solid, tr, true).Shape();
}

inline TopoDS_Shape shrunk(const TopoDS_Shape &solid, double by) {
  Bnd_Box box;
  BRepBndLib::Add(solid, box);
  if (box.IsVoid()) return solid;
  return grown(solid, -std::min(1e-3, by / std::max(std::sqrt(box.SquareExtent()), 1e-9)));
}

inline std::vector<TopoDS_Shape> loose_pieces(const TopoDS_Shape &out, const TopoDS_Shape &base,
                                              const std::vector<TopoDS_Shape> &tools) {
  NearTools nearby(tools);
  std::vector<TopoDS_Shape> loose;
  std::vector<std::pair<double, TopoDS_Shape>> solids;
  for (TopExp_Explorer ex(out, TopAbs_SOLID); ex.More(); ex.Next()) solids.push_back({volume(ex.Current()), ex.Current()});
  std::stable_sort(solids.begin(), solids.end(), [](const auto &a, const auto &b) { return a.first > b.first; });
  size_t skip = static_cast<size_t>(solid_count(base));
  for (size_t i = skip; i < solids.size(); ++i) {
    const TopoDS_Shape &piece = solids[i].second;
    for (bool verify : {false, true}) {
      int inside = 0, checked = 0;
      points_inside(piece, verify, [&](const gp_Pnt &p) {
        inside += nearby.hit(p, [](TopAbs_State st) { return st == TopAbs_IN; }) ? 1 : 0;
        checked += 1;
        return checked < 12;
      });
      if (checked && inside * 2 > checked) {
        loose.push_back(piece);
        break;
      }
    }
  }
  return loose;
}

inline TopoDS_Shape boolean(Op op, const TopoDS_Shape &base, const std::vector<TopoDS_Shape> &tools, double fuzz) {
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> alg;
  if (op == Op::Cut)
    alg.reset(new BRepAlgoAPI_Cut());
  else if (op == Op::Fuse)
    alg.reset(new BRepAlgoAPI_Fuse());
  else
    alg.reset(new BRepAlgoAPI_Common());
  TopTools_ListOfShape a, b;
  a.Append(base);
  for (const TopoDS_Shape &t : tools) b.Append(t);
  alg->SetArguments(a);
  alg->SetTools(b);
  alg->SetFuzzyValue(fuzz);
  alg->SetRunParallel(true);
  check_cancel();
  alg->Build(next_range());
  check_cancel();
  if (!alg->IsDone()) throw err("the blend would not combine with the body");
  TopoDS_Shape out = alg->Shape();
  if (op == Op::Cut && solid_count(out) > solid_count(base)) {
    std::vector<TopoDS_Shape> loose = loose_pieces(out, base, tools);
    if (!loose.empty()) {
      TopoDS_Compound kept;
      BRep_Builder builder;
      builder.MakeCompound(kept);
      for (TopExp_Explorer ex(out, TopAbs_SOLID); ex.More(); ex.Next()) {
        bool isloose = false;
        for (const TopoDS_Shape &piece : loose) isloose = isloose || ex.Current().IsSame(piece);
        if (!isloose) builder.Add(kept, ex.Current());
      }
      out = kept;
    }
  }
  return out;
}

inline bool bounded(const TopoDS_Shape &shape) {
  BRepClass3d_SolidClassifier cls(shape);
  cls.PerformInfinitePoint(1e-7);
  return cls.State() == TopAbs_OUT;
}

inline bool has_strip(const TopoDS_Shape &shape, const TopoDS_Shape &base) {
  TopTools_IndexedMapOfShape old;
  TopExp::MapShapes(base, TopAbs_FACE, old);
  for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Shape &f = ex.Current();
    if (old.Contains(f) || BRepAdaptor_Surface(TopoDS::Face(f)).GetType() != GeomAbs_BSplineSurface) continue;
    GProp_GProps g;
    BRepGProp::SurfaceProperties(f, g);
    if (std::abs(g.Mass()) > 1e-3) continue;
    GProp_GProps l;
    BRepGProp::LinearProperties(f, l);
    if (l.Mass() > 1.0) return true;
  }
  return false;
}

inline bool sound(const TopoDS_Shape &shape, const TopoDS_Shape *base = nullptr) {
  return solid_count(shape) > 0 && BRepCheck_Analyzer(shape).IsValid() && bounded(shape) && sane_volume(shape) &&
         (base == nullptr || !has_strip(shape, *base));
}

inline bool kept_base(const TopoDS_Shape &base, const TopoDS_Shape &out, const std::vector<TopoDS_Shape> &tools,
                      bool verify = true, int most = 24) {
  BRepClass3d_SolidClassifier oc(out);
  NearTools nearby(tools);
  int checked = 0, lost = 0;
  points_inside(base, verify, [&](const gp_Pnt &p) {
    if (nearby.hit(p, [](TopAbs_State st) { return st != TopAbs_OUT; })) return true;
    oc.Perform(p, 1e-9);
    checked += 1;
    lost += oc.State() != TopAbs_IN ? 1 : 0;
    return checked < most;
  });
  return lost * 2 <= checked;
}

inline bool applied_by(Op op, const TopoDS_Shape &base, const TopoDS_Shape &out,
                       const std::vector<TopoDS_Shape> &tools, bool verify) {
  bool fuse = op == Op::Fuse;
  if (solid_count(out) > solid_count(base) && (fuse || !loose_pieces(out, base, tools).empty())) return false;
  TopAbs_State changed = fuse ? TopAbs_OUT : TopAbs_IN;
  BRepClass3d_SolidClassifier bc(base), oc(out);
  for (size_t ti = 0; ti < tools.size(); ++ti) {
    std::vector<gp_Pnt> landed, missed;
    points_inside(tools[ti], verify, [&](const gp_Pnt &p) {
      bc.Perform(p, 1e-9);
      if (bc.State() != changed) return true;
      oc.Perform(p, 1e-9);
      (oc.State() != changed ? landed : missed).push_back(p);
      return landed.size() + missed.size() < 12;
    });
    if (missed.empty()) continue;
    if (!fuse) {
      if (landed.empty()) return false;
      continue;
    }
    std::vector<TopoDS_Shape> rest;
    for (size_t j = 0; j < tools.size(); ++j)
      if (j != ti) rest.push_back(tools[j]);
    NearTools others(rest);
    auto alone = [&](const gp_Pnt &p) { return !others.hit(p, [](TopAbs_State st) { return st == TopAbs_IN; }); };
    bool any_missed = false, any_landed = false;
    for (const gp_Pnt &p : missed)
      if (alone(p)) {
        any_missed = true;
        break;
      }
    if (any_missed) {
      for (const gp_Pnt &p : landed)
        if (alone(p)) {
          any_landed = true;
          break;
        }
      if (!any_landed) return false;
    }
  }
  return kept_base(base, out, tools, verify);
}

// A face of a cut that lies inside one of the tools is body the cut left behind.
// The tools reach a little past the body, so a face the cut made is on a tool
// and a face that survived is outside every tool. applied_by forgives a missed
// point that another tool also covers, which is exactly where overlapping tools
// leave a corner standing: two tools met on a G2 corner at 19 mm and 1400 mm3
// of the box stayed, with all its old faces.
inline bool left_inside(const TopoDS_Shape &out, const std::vector<TopoDS_Shape> &tools) {
  std::vector<std::pair<Bnd_Box, std::unique_ptr<BRepClass3d_SolidClassifier>>> around;
  for (const TopoDS_Shape &t : tools) {
    Bnd_Box box;
    BRepBndLib::Add(t, box);
    if (box.IsVoid()) continue;
    around.emplace_back(box, std::unique_ptr<BRepClass3d_SolidClassifier>(new BRepClass3d_SolidClassifier(t)));
  }
  const double uv[5][2] = {{0.5, 0.5}, {0.3, 0.7}, {0.7, 0.3}, {0.25, 0.25}, {0.75, 0.75}};
  for (TopExp_Explorer ex(out, TopAbs_FACE); ex.More(); ex.Next()) {
    TopoDS_Face f = TopoDS::Face(ex.Current());
    double u0, u1, v0, v1;
    BRepTools::UVBounds(f, u0, u1, v0, v1);
    BRepAdaptor_Surface surf(f);
    int inside = 0;
    for (auto &q : uv) {
      gp_Pnt2d at(u0 + (u1 - u0) * q[0], v0 + (v1 - v0) * q[1]);
      if (BRepClass_FaceClassifier(f, at, 1e-7).State() != TopAbs_IN) continue;
      gp_Pnt p = surf.Value(at.X(), at.Y());
      for (auto &n : around) {
        if (n.first.IsOut(p)) continue;
        n.second->Perform(p, 1e-4);
        if (n.second->State() == TopAbs_IN) {
          inside += 1;
          break;
        }
      }
    }
    if (inside >= 2) return true;
  }
  return false;
}

inline bool applied(Op op, const TopoDS_Shape &base, const TopoDS_Shape &out, const std::vector<TopoDS_Shape> &tools) {
  if (op == Op::Cut && left_inside(out, tools)) return false;
  return applied_by(op, base, out, tools, false) || applied_by(op, base, out, tools, true);
}

inline TopoDS_Shape boolean_one(Op op, const TopoDS_Shape &base, const TopoDS_Shape &tool, double fuzz) {
  std::vector<std::tuple<TopoDS_Shape, TopoDS_Shape, double>> attempts = {
      std::make_tuple(base, tool, fuzz), std::make_tuple(base, tool, 0.0),
      std::make_tuple(base, tool, std::max(fuzz * 1000, 1e-2))};
  if (op == Op::Fuse) attempts.insert(attempts.begin() + 2, std::make_tuple(tool, base, fuzz));
  attempts.push_back(std::make_tuple(base, shrunk(tool, 2e-3), fuzz));
  attempts.push_back(std::make_tuple(base, shrunk(tool, 2e-2), fuzz));
  for (auto &at : attempts) {
    check_cancel();
    TopoDS_Shape out;
    try {
      out = boolean(op, copy(std::get<0>(at)), {copy(std::get<1>(at))}, std::get<2>(at));
    } catch (const SectionError &) {
      continue;
    }
    if (sound(out, &base) && applied(op, base, out, {tool})) return out;
  }
  throw err("the blend would not combine with the body");
}

// The draft pass gives up on the first one-shot boolean that fails, and the full
// pass then runs the same booleans again. When no section was thinned out for
// the draft the tools are identical, so that one-shot is known to fail and
// repeating it cost a whole extra minute on a full G2 corner.
struct OneShotMemo {
  int calls = 0;
  int gave_up_at = -1;
  bool thinned = false;
  bool replay = false;
  bool never = false;
};
inline OneShotMemo &one_shot_memo() {
  static thread_local OneShotMemo m;
  return m;
}

inline TopoDS_Shape boolean_all(Op op, const TopoDS_Shape &base, const std::vector<TopoDS_Shape> &tools, double fuzz,
                                bool one_shot) {
  OneShotMemo &memo = one_shot_memo();
  int call = memo.calls++;
  bool known_bad = tools.size() > 1 && (memo.never || (memo.replay && call == memo.gave_up_at));
  using clock = std::chrono::steady_clock;
  auto started = clock::now();
  auto elapsed = [&]() { return std::chrono::duration<double>(clock::now() - started).count(); };
  if (!known_bad) try {
      TopoDS_Shape out = boolean(op, base, tools, fuzz);
      if (sound(out, &base) && applied(op, base, out, tools)) return out;
    } catch (const SectionError &) {
      if (tools.size() == 1 && !one_shot) throw;
    }
  if (one_shot) {
    memo.gave_up_at = call;
    throw DraftGaveUp("the blend would not combine with the body");
  }
  if (tools.size() == 1) return boolean_one(op, base, tools[0], fuzz);
  double budget = std::max(20.0, 4 * elapsed());
  auto out_of_time = [&]() { return elapsed() > budget; };
  try {
    TopoDS_Shape merged = tools[0];
    for (size_t i = 1; i < tools.size(); ++i) {
      if (out_of_time()) throw err("the blend would not combine with the body");
      merged = boolean_one(Op::Fuse, merged, tools[i], fuzz);
    }
    TopoDS_Shape out = boolean_one(op, base, merged, fuzz);
    if (applied(op, base, out, tools)) return out;
  } catch (const SectionError &) {
  }
  size_t n = tools.size();
  std::vector<std::vector<size_t>> orders(3);
  for (size_t i = 0; i < n; ++i) orders[0].push_back(i);
  for (size_t i = n; i-- > 0;) orders[1].push_back(i);
  for (size_t i = 0; i < n; i += 2) orders[2].push_back(i);
  for (size_t i = 1; i < n; i += 2) orders[2].push_back(i);
  for (auto &order : orders) {
    TopoDS_Shape cur = base;
    std::vector<TopoDS_Shape> pending;
    for (size_t i : order) pending.push_back(tools[i]);
    while (!pending.empty()) {
      std::vector<TopoDS_Shape> failed;
      for (const TopoDS_Shape &t : pending) {
        if (out_of_time()) throw err("the blend would not combine with the body");
        try {
          cur = boolean_one(op, cur, t, fuzz);
        } catch (const SectionError &) {
          failed.push_back(t);
        }
      }
      if (failed.size() == pending.size()) break;
      pending = failed;
    }
    if (pending.empty() && (op != Op::Cut || !left_inside(cur, tools))) return cur;
  }
  throw err("the blend would not combine with the body");
}

// --- trims -------------------------------------------------------------------

struct Trim {
  bool keep_inside;
  TopoDS_Shape solid;
};

inline Opt<Trim> trim_solid(const TopoDS_Face &g, const gp_Pnt &at, double size) {
  GeomAPI_ProjectPointOnSurf proj(at, BRep_Tool::Surface(g));
  if (proj.NbPoints() == 0) return {};
  double u, v;
  proj.LowerDistanceParameters(u, v);
  gp_Pnt p;
  gp_Vec n;
  BRepGProp_Face(g).Normal(u, v, p, n);
  if (n.Magnitude() < 1e-12) return {};
  n.Normalize();
  gp_Pnt body_side = P(V(at) - n.Multiplied(1e-3 * size));
  BRepAdaptor_Surface ad(g);
  GeomAbs_SurfaceType kind = ad.GetType();
  if (kind == GeomAbs_Plane) {
    gp_Dir z(-n.X(), -n.Y(), -n.Z());
    gp_Ax2 ax(p, z);
    gp_Pnt origin = ax.Location().Translated(gp_Vec(ax.XDirection()).Multiplied(-size) +
                                             gp_Vec(ax.YDirection()).Multiplied(-size));
    return Trim{true, BRepPrimAPI_MakeBox(gp_Ax2(origin, z, ax.XDirection()), 2 * size, 2 * size, size).Shape()};
  }
  if (kind == GeomAbs_Cylinder) {
    gp_Cylinder cyl = ad.Cylinder();
    gp_Ax1 axis = cyl.Axis();
    double along = gp_Vec(axis.Location(), at).Dot(gp_Vec(axis.Direction()));
    gp_Pnt base = axis.Location().Translated(gp_Vec(axis.Direction()).Multiplied(along - size));
    TopoDS_Shape solid = BRepPrimAPI_MakeCylinder(gp_Ax2(base, axis.Direction()), cyl.Radius(), 2 * size).Shape();
    return Trim{gp_Lin(axis).Distance(body_side) < cyl.Radius(), solid};
  }
  if (kind == GeomAbs_Sphere) {
    gp_Sphere sph = ad.Sphere();
    TopoDS_Shape solid = BRepPrimAPI_MakeSphere(sph.Location(), sph.Radius()).Shape();
    return Trim{sph.Location().Distance(body_side) < sph.Radius(), solid};
  }
  return {};
}

inline double r6(double x) { return std::round(x * 1e6) / 1e6 + 0.0; }

inline Opt<std::string> surface_key(const TopoDS_Face &face, bool keep_inside) {
  auto canonical = [](gp_Dir d) {
    bool neg = d.Z() < 0 || (d.Z() == 0 && (d.Y() < 0 || (d.Y() == 0 && d.X() < 0)));
    return neg ? d.Reversed() : d;
  };
  auto num = [](double x) {
    char buf[40];
    std::snprintf(buf, sizeof buf, "%.6f,", r6(x));
    return std::string(buf);
  };
  std::string k = keep_inside ? "1|" : "0|";
  BRepAdaptor_Surface ad(face);
  GeomAbs_SurfaceType kind = ad.GetType();
  if (kind == GeomAbs_Plane) {
    gp_Pln pl = ad.Plane();
    gp_Dir n = canonical(pl.Axis().Direction());
    return "plane" + num(n.X()) + num(n.Y()) + num(n.Z()) + num(gp_Vec(n).Dot(gp_Vec(pl.Location().XYZ()))) + k;
  }
  if (kind == GeomAbs_Cylinder) {
    gp_Cylinder c = ad.Cylinder();
    gp_Dir d = canonical(c.Axis().Direction());
    gp_Vec loc(c.Axis().Location().XYZ());
    gp_Vec foot = loc - gp_Vec(d).Multiplied(loc.Dot(gp_Vec(d)));
    return "cyl" + num(d.X()) + num(d.Y()) + num(d.Z()) + num(foot.X()) + num(foot.Y()) + num(foot.Z()) +
           num(c.Radius()) + k;
  }
  if (kind == GeomAbs_Sphere) {
    gp_Sphere sp = ad.Sphere();
    return "sph" + num(sp.Location().X()) + num(sp.Location().Y()) + num(sp.Location().Z()) + num(sp.Radius()) + k;
  }
  return {};
}

inline bool trim_misses(const TopoDS_Shape &tool, bool keep_inside, const TopoDS_Shape &trim) {
  Bnd_Box tb, trim_box;
  BRepBndLib::Add(tool, tb);
  BRepBndLib::Add(trim, trim_box);
  if (tb.IsVoid()) return true;
  if (!keep_inside) return tb.IsOut(trim_box);
  double x0, y0, z0, x1, y1, z1;
  tb.Get(x0, y0, z0, x1, y1, z1);
  for (double x : {x0, x1})
    for (double y : {y0, y1})
      for (double z : {z0, z1})
        if (BRepClass3d_SolidClassifier(trim, gp_Pnt(x, y, z), 1e-7).State() != TopAbs_IN) return false;
  return true;
}

inline bool touches(const TopoDS_Shape &edge, const std::vector<TopoDS_Vertex> &vertices) {
  for (TopExp_Explorer ex(edge, TopAbs_VERTEX); ex.More(); ex.Next())
    for (const TopoDS_Vertex &v : vertices)
      if (ex.Current().IsSame(v)) return true;
  return false;
}

inline std::pair<bool, gp_Pnt> convex_between(const TopoDS_Face &own, const TopoDS_Face &g, const TopoDS_Edge &bound) {
  double tol = std::max(BRep_Tool::Tolerance(bound), 1e-6);
  Sides ab;
  ab.emplace_back(new Side(own, bound));
  ab.emplace_back(new Side(g, bound));
  BRepAdaptor_Curve crv(bound);
  double t = 0.5 * (crv.FirstParameter() + crv.LastParameter());
  gp_Pnt Pp;
  gp_Vec Vv;
  crv.D1(t, Pp, Vv);
  if (Vv.Magnitude() < 1e-12) throw err("the boundary has a cusp");
  gp_Vec T = Vv.Normalized();
  gp_Vec na = ab[0]->normal_on_edge(t), nb = ab[1]->normal_on_edge(t);
  if (std::abs(na.Dot(nb)) > 0.9998) return {false, Pp};
  return {convexity(Pp, T, ab, na, nb, tol) > 0, Pp};
}

inline std::vector<Trim> trims(const TopoDS_Shape &shape, const TopoDS_Edge &edge, const std::vector<TopoDS_Face> &faces,
                               int s, double size) {
  std::vector<TopoDS_Vertex> ends;
  for (TopExp_Explorer ex(edge, TopAbs_VERTEX); ex.More(); ex.Next()) ends.push_back(TopoDS::Vertex(ex.Current()));
  TopTools_IndexedDataMapOfShapeListOfShape emap;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, emap);
  std::vector<Trim> out;
  std::vector<Opt<std::string>> keys;
  std::vector<TopoDS_Face> seen(faces);
  auto seen_has = [&](const TopoDS_Shape &g) {
    for (const TopoDS_Face &x : seen)
      if (g.IsSame(x)) return true;
    return false;
  };
  auto add = [&](const TopoDS_Face &g, const Opt<Trim> &trim) {
    if (!trim) return;
    seen.push_back(g);
    auto key = surface_key(g, trim->keep_inside);
    if (key) {
      for (auto &k : keys)
        if (k && *k == *key) return;
    }
    keys.push_back(key);
    out.push_back(*trim);
  };
  for (const TopoDS_Face &own : faces) {
    for (TopExp_Explorer ee(own, TopAbs_EDGE); ee.More(); ee.Next()) {
      TopoDS_Edge bound = TopoDS::Edge(ee.Current());
      if (bound.IsSame(edge) || BRep_Tool::Degenerated(bound)) continue;
      if (s > 0 && !touches(bound, ends)) continue;
      int idx = emap.FindIndex(bound);
      if (!idx) continue;
      for (TopTools_ListOfShape::Iterator it(emap.FindFromIndex(idx)); it.More(); it.Next()) {
        TopoDS_Face g = TopoDS::Face(it.Value());
        if (seen_has(g)) continue;
        std::pair<bool, gp_Pnt> cv;
        try {
          cv = convex_between(own, g, bound);
        } catch (const SectionError &) {
          continue;
        }
        if (!cv.first) continue;
        add(g, trim_solid(g, cv.second, size));
      }
    }
  }
  if (s < 0) {
    TopTools_IndexedDataMapOfShapeListOfShape vmap;
    TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vmap);
    BRepAdaptor_Curve crv(edge);
    double mid = 0.5 * (crv.FirstParameter() + crv.LastParameter());
    for (const TopoDS_Vertex &v : ends) {
      int idx = vmap.FindIndex(v);
      if (!idx) continue;
      double t = BRep_Tool::Parameter(v, edge);
      gp_Pnt Pp;
      gp_Vec Vv;
      crv.D1(t, Pp, Vv);
      if (Vv.Magnitude() < 1e-12) continue;
      gp_Vec leaving = t > mid ? Vv.Normalized() : Vv.Normalized().Reversed();
      for (TopTools_ListOfShape::Iterator it(vmap.FindFromIndex(idx)); it.More(); it.Next()) {
        TopoDS_Face g = TopoDS::Face(it.Value());
        if (seen_has(g) || BRepAdaptor_Surface(g).GetType() != GeomAbs_Plane) continue;
        BRepGProp_Face props(g);
        double u0, u1, v0, v1;
        props.Bounds(u0, u1, v0, v1);
        gp_Pnt q;
        gp_Vec n;
        props.Normal(0.5 * (u0 + u1), 0.5 * (v0 + v1), q, n);
        if (n.Magnitude() < 1e-12 || leaving.Dot(n.Normalized()) < 1e-3) continue;
        add(g, trim_solid(g, Pp, size));
      }
    }
  }
  return out;
}

inline TopoDS_Shape outside_removed(const TopoDS_Shape &tool, const TopoDS_Shape &trim, double fuzz) {
  Bnd_Box box;
  BRepBndLib::Add(tool, box);
  box.Enlarge(1.0 + 0.1 * std::sqrt(box.SquareExtent()));
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  TopoDS_Shape around = BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Shape();
  for (double fz : {fuzz, 0.0}) {
    TopoDS_Shape got;
    try {
      TopoDS_Shape outside = boolean(Op::Cut, around, {trim}, fz);
      got = boolean(Op::Cut, tool, {outside}, fz);
    } catch (const SectionError &) {
      continue;
    }
    if (volume(got) > 1e-9 && BRepCheck_Analyzer(got).IsValid() && within(got, trim)) return got;
  }
  throw err("the blend could not be trimmed where its face ends");
}

inline std::vector<TopoDS_Shape> apply_trims(std::vector<TopoDS_Shape> tools, const std::vector<Trim> &trim_list,
                                             double fuzz) {
  for (const Trim &tr : trim_list) {
    std::vector<TopoDS_Shape> out;
    for (const TopoDS_Shape &t : tools) {
      if (trim_misses(t, tr.keep_inside, tr.solid)) {
        out.push_back(t);
        continue;
      }
      if (!tr.keep_inside) {
        TopoDS_Shape cut = boolean(Op::Cut, t, {tr.solid}, fuzz);
        if (volume(cut) > 1e-9) out.push_back(cut);
        continue;
      }
      Opt<TopoDS_Shape> kept;
      std::vector<std::tuple<TopoDS_Shape, TopoDS_Shape, double>> attempts = {
          std::make_tuple(t, tr.solid, fuzz), std::make_tuple(t, tr.solid, 0.0), std::make_tuple(tr.solid, t, fuzz)};
      for (int i = 0; i < 5 && !kept; ++i) {
        std::tuple<TopoDS_Shape, TopoDS_Shape, double> at;
        if (i < 3)
          at = attempts[i];
        else
          at = std::make_tuple(t, grown(tr.solid, i == 3 ? 1e-5 : 1e-4), fuzz);
        TopoDS_Shape got;
        try {
          got = boolean(Op::Common, std::get<0>(at), {std::get<1>(at)}, std::get<2>(at));
        } catch (const SectionError &) {
          continue;
        }
        if (volume(got) > 1e-9 && within(got, tr.solid)) kept = got;
      }
      if (!kept && inside_point(t, tr.solid)) kept = outside_removed(t, tr.solid, fuzz);
      if (kept) out.push_back(*kept);
    }
    tools = out;
  }
  return tools;
}

inline bool straight_meridian(const TopoDS_Face &f) {
  GeomAbs_SurfaceType kind = BRepAdaptor_Surface(f).GetType();
  return kind == GeomAbs_Plane || kind == GeomAbs_Cylinder || kind == GeomAbs_Cone;
}

// A torus or sphere on the axis is revolved too, for a fillet only, which is
// what an earlier rim fillet leaves next to a cup's rim.
inline Opt<gp_Ax1> common_axis(const BRepAdaptor_Curve &crv, const std::vector<TopoDS_Face> &faces, bool curved_ok) {
  if (crv.GetType() != GeomAbs_Circle) return {};
  gp_Ax1 ax = crv.Circle().Axis();
  auto on_axis = [&](const gp_Ax1 &other) {
    return other.IsParallel(ax, 1e-6) && gp_Lin(ax).Distance(other.Location()) < 1e-6;
  };
  for (const TopoDS_Face &f : faces) {
    BRepAdaptor_Surface ad(f);
    GeomAbs_SurfaceType kind = ad.GetType();
    if (kind == GeomAbs_Plane) {
      if (!ad.Plane().Axis().IsParallel(ax, 1e-6)) return {};
    } else if (kind == GeomAbs_Cylinder || kind == GeomAbs_Cone) {
      if (!on_axis(kind == GeomAbs_Cylinder ? ad.Cylinder().Axis() : ad.Cone().Axis())) return {};
    } else if (curved_ok && kind == GeomAbs_Torus) {
      if (!on_axis(ad.Torus().Axis())) return {};
    } else if (curved_ok && kind == GeomAbs_Sphere) {
      if (gp_Lin(ax).Distance(ad.Sphere().Location()) >= 1e-6) return {};
    } else {
      return {};
    }
  }
  return ax;
}

// --- one edge ----------------------------------------------------------------

inline std::pair<int, std::vector<TopoDS_Shape>> edge_tool(const TopoDS_Shape &shape, const TopoDS_Edge &edge,
                                                           bool chamfer, double size, double size2, bool g2,
                                                           double tol, bool draft, double profile, double margin) {
  std::vector<TopoDS_Face> faces = faces_of(shape, edge);
  Sides sides;
  for (const TopoDS_Face &f : faces) sides.emplace_back(new Side(f, edge));
  BRepAdaptor_Curve crv(edge);
  double t0 = crv.FirstParameter(), t1 = crv.LastParameter();
  bool straight = crv.GetType() == GeomAbs_Line && sides[0]->planar && sides[1]->planar;
  bool closed = crv.Value(t0).Distance(crv.Value(t1)) < tol * 10;

  struct Frame {
    gp_Pnt P;
    gp_Vec T, n1, n2;
  };
  auto frame = [&](double t) {
    gp_Pnt Pp;
    gp_Vec Vv;
    crv.D1(t, Pp, Vv);
    if (Vv.Magnitude() < 1e-12) throw err("the edge has a cusp");
    return Frame{Pp, Vv.Normalized(), sides[0]->normal_on_edge(t), sides[1]->normal_on_edge(t)};
  };

  Frame fm = frame(0.5 * (t0 + t1));
  int s = convexity(fm.P, fm.T, sides, fm.n1, fm.n2, tol);
  if (s > 0) margin = 1.0;
  sides[0]->normal_on_edge_cached = fm.n1;
  sides[1]->normal_on_edge_cached = fm.n2;
  // A convex G2 section whose longer setback leaves the face would be lofted
  // anyway and cut the body into a shape nobody asked for, or keep the boolean
  // busy for minutes.
  if (g2 && s > 0 && !chamfer) {
    Contacts c = contacts(fm.P, fm.T, sides, s, chamfer, size, size2, g2);
    for (int k = 0; k < 2; ++k)
      if (!sides[k]->contains(c.Q[k], std::max(tol * 10, 1e-5)))
        throw err("at this size the G2 blend runs off the face, it sets back 1.55 times the radius");
  }
  double reach = size * (g2 ? G2_SETBACK : 1.0) + (std::isnan(size2) ? 0.0 : size2);
  double fuzz = std::max(tol * 10, 1e-5);

  Opt<gp_Ax1> axis = closed ? common_axis(crv, faces, !chamfer) : Opt<gp_Ax1>();
  if (axis)
    for (auto &sd : sides) sd->planar = sd->planar || straight_meridian(sd->face);
  auto set_frame = [&](const Frame &f) {
    sides[0]->normal_on_edge_cached = f.n1;
    sides[1]->normal_on_edge_cached = f.n2;
    if (!chamfer) return;
    const gp_Vec ns[2] = {f.n1, f.n2};
    for (int k = 0; k < 2; ++k) {
      gp_Vec d = ns[k].Crossed(f.T);
      if (d.Magnitude() < 1e-12) throw err("the edge runs along a face normal");
      sides[k]->inward_cached = d.Normalized().Multiplied(sides[k]->inward_sign);
    }
  };
  std::vector<Frame> probes;
  if (closed)
    for (int k = 0; k < 8; ++k) probes.push_back(frame(t0 + (t1 - t0) * k / 8));
  else
    probes.push_back(fm);
  std::unique_ptr<BRepClass3d_SolidClassifier> body;
  const bool meridian[2] = {sides[0]->planar, sides[1]->planar};
  // A fill's ball has to rest on both faces, it hangs in the air past either
  // one's end and across the axis it reaches through the far wall. A cut's may
  // run on past a face along that face's surface, carving what lies above it,
  // but not into the body beyond, which is no corner of this edge. A curved
  // meridian keeps its surface while the ball rests on the face, past it the
  // cut carves along its tangent plane at the edge, like a flat face whose
  // contact runs past its end; on the far side of the tube the ball would land
  // in the wrong place.
  auto misfit = [&](double k) {
    double sz = size * k, sz2 = std::isnan(size2) ? size2 : size2 * k;
    for (int j = 0; j < 2; ++j) sides[j]->planar = meridian[j];
    if (axis) {
      bool on[2] = {false, false}, off[2] = {false, false};
      for (const Frame &f : probes) {
        if (sides[0]->planar && sides[1]->planar) break;
        set_frame(f);
        Contacts c = contacts(f.P, f.T, sides, s, chamfer, sz, sz2, g2);
        for (int j = 0; j < 2; ++j)
          if (!sides[j]->planar) (sides[j]->contains(c.Q[j], fuzz) ? on : off)[j] = true;
      }
      for (int j = 0; j < 2; ++j) {
        if (!off[j]) continue;
        if (s < 0) return Misfit::OffFace;
        if (on[j]) return Misfit::Mixed;
        sides[j]->planar = true;
      }
    }
    for (const Frame &f : probes) {
      set_frame(f);
      Contacts c = contacts(f.P, f.T, sides, s, chamfer, sz, sz2, g2);
      if (s < 0 && axis) {
        gp_Pnt Q[2] = {c.Q[0], c.Q[1]};
        if (clamp_to_axis(Q, f.P, f.P, *axis)) return Misfit::AcrossAxis;
      }
      for (int j = 0; j < 2; ++j) {
        if (sides[j]->contains(c.Q[j], fuzz)) continue;
        if (s < 0) return Misfit::OffFace;
        if (!body) body.reset(new BRepClass3d_SolidClassifier(shape));
        body->Perform(c.Q[j], fuzz);
        if (body->State() == TopAbs_IN) return Misfit::IntoBody;
      }
    }
    return Misfit::None;
  };
  Misfit why = misfit(1.0);
  if (why != Misfit::None) {
    double lo = 0.0, hi = 1.0;
    if (misfit(1e-3) == Misfit::None) {
      lo = 1e-3;
      for (int i = 0; i < 30; ++i) {
        check_cancel();
        double mid = 0.5 * (lo + hi);
        (misfit(mid) == Misfit::None ? lo : hi) = mid;
      }
      why = misfit(hi);
    }
    throw TooLarge(why, lo > 0 ? lo : std::nan(""), fm.P);
  }
  set_frame(fm);

  if (axis) {
    Frame f0 = frame(t0);
    sides[0]->normal_on_edge_cached = f0.n1;
    sides[1]->normal_on_edge_cached = f0.n2;
    Section sec = section(f0.P, f0.T, sides, s, chamfer, size, size2, g2, profile, &*axis, margin);
    BRepBuilderAPI_MakeFace face(sec.wire, true);
    if (face.IsDone()) {
      BRepPrimAPI_MakeRevol rev(face.Face(), *axis);
      rev.Build();
      if (rev.IsDone()) {
        std::vector<TopoDS_Shape> tools = {rev.Shape()};
        return {s, apply_trims(tools, trims(shape, edge, faces, s, 50 * reach + 10), fuzz)};
      }
    }
  }

  std::vector<double> ts;
  if (straight) {
    ts = {t0, t1};
  } else {
    int n = closed ? 48 : 24;
    for (int k = 0; k <= n; ++k) ts.push_back(t0 + (t1 - t0) * k / n);
  }
  std::vector<TopoDS_Wire> wires;
  bool have_prev = false;
  gp_Vec prev_inner, prev_T;
  gp_Pnt prev_P;
  for (double t : ts) {
    check_cancel();
    Frame f = frame(t);
    sides[0]->normal_on_edge_cached = f.n1;
    sides[1]->normal_on_edge_cached = f.n2;
    if (chamfer) {
      const gp_Vec ns[2] = {f.n1, f.n2};
      for (int k = 0; k < 2; ++k) {
        gp_Vec d = ns[k].Crossed(f.T);
        if (d.Magnitude() < 1e-12) throw err("the edge runs along a face normal");
        sides[k]->inward_cached = d.Normalized().Multiplied(sides[k]->inward_sign);
      }
    }
    Section sec = section(f.P, f.T, sides, s, chamfer, size, size2, g2, profile, nullptr, margin);
    if (wires.empty() && !cappable(sec.wire)) throw err("the blend sections would not close into a solid");
    if (have_prev && (sec.inner - prev_inner).Dot(prev_T) <= 1e-3 * f.P.Distance(prev_P))
      throw err("at this size the blend is tighter than the edge's own curve");
    have_prev = true;
    prev_inner = sec.inner;
    prev_T = f.T;
    prev_P = f.P;
    wires.push_back(sec.wire);
  }

  auto loft = [](const std::vector<TopoDS_Wire> &ws) {
    BRepOffsetAPI_ThruSections mk(true, ws.size() == 2, LOFT_PLANE_TOL);
    mk.CheckCompatibility(false);
    for (const TopoDS_Wire &w : ws) mk.AddWire(w);
    check_cancel();
    mk.Build();
    if (!mk.IsDone()) throw err("the blend sections would not loft");
    if (!closed_solid(mk.Shape())) throw err("the blend sections would not close into a solid");
    return mk.Shape();
  };
  auto slice = [](const std::vector<TopoDS_Wire> &ws, size_t a, size_t b) {
    return std::vector<TopoDS_Wire>(ws.begin() + a, ws.begin() + b);
  };

  std::vector<TopoDS_Shape> tools;
  size_t half = wires.size() / 2;
  if (draft && wires.size() > 4) {
    one_shot_memo().thinned = true;
    std::vector<size_t> keep;
    for (size_t k = 0; k < wires.size(); k += 3) keep.push_back(k);
    if (keep.back() != wires.size() - 1) keep.push_back(wires.size() - 1);
    if (closed && std::find(keep.begin(), keep.end(), half) == keep.end()) {
      keep.push_back(half);
      std::sort(keep.begin(), keep.end());
    }
    size_t mid = closed ? static_cast<size_t>(std::find(keep.begin(), keep.end(), half) - keep.begin()) : 0;
    std::vector<TopoDS_Wire> kept;
    for (size_t k : keep) kept.push_back(wires[k]);
    if (closed)
      tools = {loft(slice(kept, 0, mid + 1)), loft(slice(kept, mid, kept.size()))};
    else
      tools = {loft(kept)};
  } else if (closed) {
    tools = {loft(slice(wires, 0, half + 1)), loft(slice(wires, half, wires.size()))};
  } else {
    tools = {loft(wires)};
  }
  return {s, apply_trims(tools, trims(shape, edge, faces, s, 50 * reach + 10), fuzz)};
}

// --- corners -----------------------------------------------------------------

inline std::pair<std::vector<gp_Vec>, std::vector<double>> section_poles(const gp_Vec &Qa, const gp_Vec &K,
                                                                         const gp_Vec &Qb, bool g2, double k,
                                                                         double profile) {
  if (g2 && std::abs(profile) < 1e-12) {
    double t = 1 - G2_TENSION;
    return {{Qa, Qa + (K - Qa).Multiplied(t), K, Qb + (K - Qb).Multiplied(t), Qb}, {1.0, 1.0, 1.0, 1.0, 1.0}};
  }
  if (g2) {
    std::vector<gp_Vec> ps = g2_poles(Qa, K, Qb, profile);
    return {ps, std::vector<double>(ps.size(), 1.0)};
  }
  return {{Qa, K, Qb}, {1.0, std::sin(M_PI / 4) * k, 1.0}};
}

inline TopoDS_Shape patch_solid(const gp_Vec &A, const std::vector<gp_Vec> &ns, double d, bool g2, double k,
                                double profile) {
  gp_Vec a = A, n1 = ns[0], n2 = ns[1], n3 = ns[2];
  gp_Vec up = n3.Multiplied(d);
  gp_Vec pole = a + up;
  auto ring =
      section_poles(a + n1.Multiplied(d), a + n1.Multiplied(d) + n2.Multiplied(d), a + n2.Multiplied(d), g2, k, profile);
  std::vector<std::pair<std::vector<gp_Vec>, std::vector<double>>> rows;
  for (const gp_Vec &e : ring.first) rows.push_back(section_poles(pole, e + up, e, g2, k, profile));
  int nu = static_cast<int>(ring.first.size()), nv = static_cast<int>(rows[0].first.size());
  TColgp_Array2OfPnt poles(1, nu, 1, nv);
  TColStd_Array2OfReal weights(1, nu, 1, nv);
  for (int i = 0; i < nu; ++i)
    for (int j = 0; j < nv; ++j) {
      poles.SetValue(i + 1, j + 1, P(rows[i].first[j]));
      weights.SetValue(i + 1, j + 1, ring.second[i] * rows[i].second[j]);
    }
  Handle(Geom_BezierSurface) surf = new Geom_BezierSurface(poles, weights);
  std::vector<TopoDS_Face> faces = {BRepBuilderAPI_MakeFace(surf, 0.0, 1.0, 0.0, 1.0, 1e-7).Face()};
  struct IsoEnd {
    Handle(Geom_Curve) crv;
    gp_Vec e0, e1;
  };
  std::vector<IsoEnd> isos = {{surf->UIso(0.0), a + n1.Multiplied(d), pole},
                              {surf->UIso(1.0), a + n2.Multiplied(d), pole},
                              {surf->VIso(1.0), a + n1.Multiplied(d), a + n2.Multiplied(d)}};
  for (auto &iso : isos) {
    BRepBuilderAPI_MakeWire wire;
    wire.Add(BRepBuilderAPI_MakeEdge(iso.crv).Edge());
    BRepBuilderAPI_MakePolygon cornerp(P(iso.e1), P(a), P(iso.e0));
    wire.Add(cornerp.Wire());
    if (!wire.IsDone()) throw err("the corner patch did not close");
    BRepBuilderAPI_MakeFace face(wire.Wire(), true);
    if (!face.IsDone()) throw err("the corner patch did not close");
    faces.push_back(face.Face());
  }
  BRepBuilderAPI_Sewing sew(1e-6);
  for (const TopoDS_Face &f : faces) sew.Add(f);
  sew.Perform();
  TopExp_Explorer shell(sew.SewedShape(), TopAbs_SHELL);
  if (!shell.More()) throw err("the corner patch did not close");
  ShapeFix_Solid fix;
  TopoDS_Solid solid = fix.SolidFromShell(TopoDS::Shell(shell.Current()));
  if (!BRepCheck_Analyzer(solid).IsValid() || !sane_volume(solid)) throw err("the corner patch did not close");
  return solid;
}

inline Opt<std::pair<gp_Pnt, gp_Vec>> surface_normal(const TopoDS_Face &face,
                                                                const Handle(Geom_Surface) & surf, const gp_Pnt &pnt) {
  GeomAPI_ProjectPointOnSurf proj(pnt, surf);
  if (proj.NbPoints() == 0) return {};
  double u, v;
  proj.LowerDistanceParameters(u, v);
  gp_Pnt p;
  gp_Vec n;
  BRepGProp_Face(face).Normal(u, v, p, n);
  if (n.Magnitude() < 1e-12) return {};
  return std::make_pair(proj.NearestPoint(), n.Normalized());
}

inline Opt<std::pair<gp_Vec, std::vector<gp_Vec>>> corner_ball(const std::vector<TopoDS_Face> &faces,
                                                                         const gp_Pnt &Vt, double r) {
  std::vector<gp_Pnt> feet;
  std::vector<gp_Vec> ns;
  std::vector<Handle(Geom_Surface)> surfs;
  for (const TopoDS_Face &f : faces) {
    Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
    auto got = surface_normal(f, surf, Vt);
    if (!got) return {};
    feet.push_back(Vt);
    ns.push_back(got->second);
    surfs.push_back(surf);
  }
  Opt<gp_Vec> C;
  for (int it = 0; it < 8; ++it) {
    double rows[3][3], rhs[3];
    for (int i = 0; i < 3; ++i) {
      rows[i][0] = ns[i].X();
      rows[i][1] = ns[i].Y();
      rows[i][2] = ns[i].Z();
      rhs[i] = ns[i].Dot(V(feet[i])) - r;
    }
    C = solve3(rows, rhs);
    if (!C) return {};
    double moved = 0.0;
    for (size_t k = 0; k < faces.size(); ++k) {
      auto got = surface_normal(faces[k], surfs[k], P(*C));
      if (!got) return {};
      gp_Vec n = got->second;
      if (n.Dot(ns[k]) < 0) n.Reverse();
      moved = std::max(moved, got->first.Distance(feet[k]));
      feet[k] = got->first;
      ns[k] = n;
    }
    if (moved < 1e-9) break;
  }
  return std::make_pair(*C, ns);
}

inline std::vector<TopoDS_Shape> unique(const TopTools_ListOfShape &shapes, bool degenerate_ok = true) {
  std::vector<TopoDS_Shape> out;
  for (TopTools_ListOfShape::Iterator it(shapes); it.More(); it.Next()) {
    const TopoDS_Shape &s = it.Value();
    if (!degenerate_ok && s.ShapeType() == TopAbs_EDGE && BRep_Tool::Degenerated(TopoDS::Edge(s))) continue;
    bool seen = false;
    for (const TopoDS_Shape &x : out) seen = seen || s.IsSame(x);
    if (!seen) out.push_back(s);
  }
  return out;
}

inline std::vector<TopoDS_Shape> ball_corners(const TopoDS_Shape &shape,
                                              const std::vector<std::pair<TopoDS_Shape, double>> &blended, bool g2,
                                              double profile) {
  if (blended.size() < 3) return {};
  double weight = conic_weight_scale(profile);
  bool is_ball = !g2 && std::abs(weight - 1.0) < 1e-9;
  TopTools_IndexedDataMapOfShapeListOfShape vmap, fmap;
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_EDGE, vmap);
  TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, fmap);
  std::vector<TopoDS_Shape> out, done;
  for (const auto &er : blended) {
    check_cancel();
    double r = er.second;
    for (TopExp_Explorer ex(er.first, TopAbs_VERTEX); ex.More(); ex.Next()) {
      TopoDS_Vertex v = TopoDS::Vertex(ex.Current());
      bool was = false;
      for (const TopoDS_Shape &d : done) was = was || v.IsSame(d);
      if (was) continue;
      done.push_back(v);
      std::vector<TopoDS_Shape> around = unique(vmap.FindFromIndex(vmap.FindIndex(v)), false);
      std::vector<double> radii;
      for (const TopoDS_Shape &a : around) {
        bool hit = false;
        for (const auto &b : blended)
          if (b.first.IsSame(a)) {
            radii.push_back(b.second);
            hit = true;
            break;
          }
        if (!hit) break;
      }
      if (around.size() != 3 || radii.size() != 3 ||
          *std::max_element(radii.begin(), radii.end()) - *std::min_element(radii.begin(), radii.end()) > 1e-9)
        continue;
      std::vector<TopoDS_Face> faces;
      for (const TopoDS_Shape &f : unique(fmap.FindFromIndex(fmap.FindIndex(v)))) faces.push_back(TopoDS::Face(f));
      if (faces.size() != 3) continue;
      double setback = g2 ? r * G2_SETBACK : r;
      bool planes = true;
      for (const TopoDS_Face &f : faces) planes = planes && BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane;
      if (!planes) continue;
      auto got = corner_ball(faces, BRep_Tool::Pnt(v), setback);
      if (!got) continue;
      gp_Vec C = got->first;
      std::vector<gp_Vec> &ns = got->second;
      if (!is_ball && (std::abs(ns[0].Dot(ns[1])) > 1e-6 || std::abs(ns[1].Dot(ns[2])) > 1e-6 ||
                       std::abs(ns[0].Dot(ns[2])) > 1e-6))
        continue;
      std::vector<gp_Vec> cols;
      for (int k = 0; k < 3; ++k) {
        gp_Vec d = ns[(k + 1) % 3].Crossed(ns[(k + 2) % 3]);
        double along = d.Dot(ns[k]);
        if (std::abs(along) < 1e-9) break;
        cols.push_back(d.Multiplied((setback * 1.02 + 1e-3) / along));
      }
      if (cols.size() != 3) continue;
      gp_Mat m(cols[0].XYZ(), cols[1].XYZ(), cols[2].XYZ());
      gp_GTrsf g(m, gp_XYZ(C.X(), C.Y(), C.Z()));
      TopoDS_Shape cell = BRepBuilderAPI_GTransform(BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape(), g, true).Shape();
      TopoDS_Shape cornerv;
      try {
        TopoDS_Shape kept = is_ball ? BRepPrimAPI_MakeSphere(P(C), r).Shape() : patch_solid(C, ns, setback, g2, weight, profile);
        cornerv = boolean(Op::Cut, cell, {kept}, 1e-6);
      } catch (const SectionError &) {
        continue;
      }
      if (BRepCheck_Analyzer(cornerv).IsValid() && sane_volume(cornerv)) out.push_back(cornerv);
    }
  }
  return out;
}

// --- the whole feature ---------------------------------------------------------

inline bool swallowed(const TopoDS_Shape &base, const std::vector<TopoDS_Shape> &tools) {
  NearTools nearby(tools);
  auto covered = [&](const gp_Pnt &p) { return nearby.hit(p, [](TopAbs_State st) { return st == TopAbs_IN; }); };
  int n = 0;
  bool bare = false;
  points_inside(base, true, [&](const gp_Pnt &p) {
    if (!covered(p)) {
      bare = true;
      return false;
    }
    n += 1;
    return n < 24;
  });
  if (bare) return false;
  Bnd_Box box;
  BRepBndLib::Add(base, box);
  if (box.IsVoid()) return n > 0;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  BRepClass3d_SolidClassifier bc(base);
  const int k = 6;
  for (int i = 1; i < k; ++i)
    for (int j = 1; j < k; ++j)
      for (int m = 1; m < k; ++m) {
        gp_Pnt p(x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * j / k, z0 + (z1 - z0) * m / k);
        bc.Perform(p, 1e-9);
        if (bc.State() != TopAbs_IN) continue;
        if (!covered(p)) return false;
        n += 1;
      }
  return n > 0;
}

inline TopoDS_Shape combine(const TopoDS_Shape &shape, const std::vector<TopoDS_Shape> &cut,
                            const std::vector<TopoDS_Shape> &fuse, double tol, bool one_shot) {
  double fuzz = std::max(tol * 10, 1e-5);
  if (!cut.empty() && swallowed(shape, cut)) throw err("at this size the blend removes the whole body");
  TopoDS_Shape out = shape;
  if (!cut.empty()) out = boolean_all(Op::Cut, out, cut, fuzz, one_shot);
  if (!fuse.empty()) out = boolean_all(Op::Fuse, out, fuse, fuzz, one_shot);
  check_cancel();
  try {
    ShapeUpgrade_UnifySameDomain up(copy(out), true, true, false);
    up.Build();
    TopoDS_Shape tidy = up.Shape();
    if (solid_count(tidy) == solid_count(out) &&
        (BRepCheck_Analyzer(tidy).IsValid() || !BRepCheck_Analyzer(out).IsValid()))
      out = tidy;
  } catch (...) {
  }
  if (solid_count(out) == 0) throw err("at this size the blend removes the whole body");
  if (solid_count(out) > solid_count(shape)) throw err("at this size the blend cuts the body in pieces");
  std::vector<TopoDS_Shape> all(cut);
  all.insert(all.end(), fuse.begin(), fuse.end());
  if (!sound(out, &shape) || !(kept_base(shape, out, all, false) || kept_base(shape, out, all)))
    throw err("at this size the blend makes a body that is not a valid solid");
  return out;
}

inline TopoDS_Shape section_blend_once(const TopoDS_Shape &shape, const std::vector<TopoDS_Shape> &edges, bool chamfer,
                                      double size2, bool g2, const std::vector<double> &sizes, bool draft,
                                      double profile) {
  double tol = 1e-6;
  for (const TopoDS_Shape &e : edges) tol = std::max(tol, BRep_Tool::Tolerance(TopoDS::Edge(e)));
  std::vector<TopoDS_Shape> cut, fuse;
  std::vector<std::pair<TopoDS_Shape, double>> convex;
  for (size_t k = 0; k < edges.size(); ++k) {
    check_cancel();
    auto got = edge_tool(shape, TopoDS::Edge(edges[k]), chamfer, sizes[k], size2, g2, tol, draft, profile,
                         1.0 + 0.11 * static_cast<double>(k));
    auto &dst = got.first > 0 ? cut : fuse;
    dst.insert(dst.end(), got.second.begin(), got.second.end());
    if (got.first > 0) convex.push_back({edges[k], sizes[k]});
  }
  std::vector<TopoDS_Shape> corners = chamfer ? std::vector<TopoDS_Shape>() : ball_corners(shape, convex, g2, profile);
  if (!corners.empty()) {
    try {
      std::vector<TopoDS_Shape> cut2, fuse2;
      for (const TopoDS_Shape &t : cut) cut2.push_back(copy(t));
      cut2.insert(cut2.end(), corners.begin(), corners.end());
      for (const TopoDS_Shape &t : fuse) fuse2.push_back(copy(t));
      return combine(copy(shape), cut2, fuse2, tol, draft);
    } catch (const DraftGaveUp &) {
      throw;
    } catch (const SectionError &) {
    }
  }
  return combine(draft ? copy(shape) : shape, cut, fuse, tol, draft);
}

} // namespace secblend

// the Python engine's `section_blend.py` `section_blend`. size2 NaN for none. status 0 built,
// 1 SectionBlendError (message is its sentence), 2 any other exception (its class),
// 3 cancelled through `progress`, 4 the blend does not fit an edge (message is
// "why fits x y z": fits the largest share of the size that does, -1 when none
// does, x y z a point on the edge).
inline std::unique_ptr<TopoDS_Shape> blend_section(const TopoDS_Shape &shape, const TopoDS_Shape &edges, bool chamfer,
                                                   rust::Slice<const double> sizes, double size2, bool g2, bool draft,
                                                   double profile, bool one_shot, const Message_ProgressRange &progress,
                                                   int32_t &status, rust::String &message) {
  secblend::CancelScope cancel(progress);
  std::vector<TopoDS_Shape> es;
  for (TopoDS_Iterator it(edges); it.More(); it.Next()) es.push_back(it.Value());
  std::vector<double> sz(sizes.begin(), sizes.end());
  try {
    bool bad = false;
    for (double x : sz) bad = bad || !(x > 0);
    if (bad || (!std::isnan(size2) && !(size2 > 0))) throw secblend::err("the size must be greater than 0");
    secblend::one_shot_memo() = {};
    secblend::one_shot_memo().never = !one_shot;
    if (draft && one_shot) {
      try {
        TopoDS_Shape out = secblend::section_blend_once(shape, es, chamfer, size2, g2, sz, true, profile);
        status = 0;
        return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(out));
      } catch (const secblend::DraftGaveUp &) {
        secblend::OneShotMemo &memo = secblend::one_shot_memo();
        memo.replay = !memo.thinned;
        memo.calls = 0;
      }
    }
    TopoDS_Shape out = secblend::section_blend_once(shape, es, chamfer, size2, g2, sz, false, profile);
    status = 0;
    return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(out));
  } catch (const secblend::Cancelled &) {
    status = 3;
    message = "cancelled";
  } catch (const secblend::TooLarge &e) {
    status = 4;
    char buf[160];
    std::snprintf(buf, sizeof buf, "%d %.17g %.17g %.17g %.17g", static_cast<int>(e.why),
                  std::isnan(e.fits) ? -1.0 : e.fits, e.at.X(), e.at.Y(), e.at.Z());
    message = buf;
  } catch (const secblend::SectionError &e) {
    status = 1;
    message = e.msg;
  } catch (const Standard_Failure &e) {
    status = 2;
    message = e.DynamicType()->Name();
  } catch (const std::exception &e) {
    status = 2;
    message = e.what();
  } catch (...) {
    status = 2;
    message = "Standard_Failure";
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape());
}
