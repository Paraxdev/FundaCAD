// sidecar/conic_blend.py: OCCT's own fillet with the middle weight row of every
// blend face scaled, which walks the section from a chord (k = 0) through the
// circular arc (k = 1) towards the sharp corner. Boundaries that moved are
// rebuilt from their pcurves, mitre seams are re-solved section by section.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>

#include <BRepAdaptor_Curve2d.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Geom2dAPI_Interpolate.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom2d_Curve.hxx>
#include <GeomConvert.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <ShapeFix_Shape.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_HArray1OfReal.hxx>
#include <TColgp_HArray1OfPnt2d.hxx>
#include <TopExp.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace conic {

const double TOL = 1e-7;
const double PROFILE_EPS = 1e-6;
const double PROFILE_LIMIT = 0.99;
const double SEAM_FIT = 1e-7;
const double SEAM_LIMIT = 1e-4;
const size_t SEAM_SAMPLES_MAX = 400;

struct NotApplicable {
  std::string msg;
};
struct ValueError {
  std::string msg;
};

inline std::string fmt(const char *f, double v) {
  char buf[64];
  std::snprintf(buf, sizeof buf, f, v);
  return buf;
}

inline double clamp_profile(double p) {
  if (std::isnan(p)) return 0.0;
  return std::max(-PROFILE_LIMIT, std::min(PROFILE_LIMIT, p));
}

inline double weight_scale(double profile) {
  double p = clamp_profile(profile);
  return p <= 0 ? 1.0 + p : 1.0 / (1.0 - p);
}

inline std::vector<TopoDS_Shape> sub(const TopoDS_Shape &s, TopAbs_ShapeEnum kind) {
  TopTools_IndexedMapOfShape m;
  TopExp::MapShapes(s, kind, m);
  std::vector<TopoDS_Shape> out;
  for (int i = 1; i <= m.Extent(); ++i) out.push_back(m.FindKey(i));
  return out;
}

using BS = Handle(Geom_BSplineSurface);

inline BS nurbs_of(const TopoDS_Face &face) {
  Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
  double u0, u1, v0, v1;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  return GeomConvert::SurfaceToBSplineSurface(new Geom_RectangularTrimmedSurface(surf, u0, u1, v0, v1));
}

inline std::vector<bool> arc_dirs(const BS &bs) {
  std::vector<bool> out;
  for (bool along_u : {true, false}) {
    int deg = along_u ? bs->UDegree() : bs->VDegree();
    int n = along_u ? bs->NbUPoles() : bs->NbVPoles();
    if (deg != 2 || n != 3) continue;
    auto w = [&](int i) { return along_u ? bs->Weight(i, 1) : bs->Weight(1, i); };
    if (std::abs(w(1) - w(3)) < 1e-9 && w(2) < w(1) - 1e-9) out.push_back(along_u);
  }
  return out;
}

inline void reweight(const BS &bs, bool along_u, double k) {
  if (along_u) {
    for (int j = 1; j <= bs->NbVPoles(); ++j) bs->SetWeight(2, j, bs->Weight(2, j) * k);
  } else {
    for (int i = 1; i <= bs->NbUPoles(); ++i) bs->SetWeight(i, 2, bs->Weight(i, 2) * k);
  }
}

inline std::vector<TopoDS_Face> blend_faces(const TopoDS_Shape &sharp, BRepFilletAPI_MakeFillet &mk,
                                            const TopoDS_Shape &result) {
  std::vector<TopoDS_Shape> kept;
  for (const TopoDS_Shape &f : sub(sharp, TopAbs_FACE)) {
    for (TopTools_ListOfShape::Iterator it(mk.Modified(f)); it.More(); it.Next()) kept.push_back(it.Value());
    if (!mk.IsDeleted(f)) kept.push_back(f);
  }
  std::vector<TopoDS_Face> out;
  for (const TopoDS_Shape &f : sub(result, TopAbs_FACE)) {
    bool any = false;
    for (const TopoDS_Shape &k : kept) any = any || f.IsSame(k);
    if (!any) out.push_back(TopoDS::Face(f));
  }
  return out;
}

inline TopoDS_Face reskin(const TopoDS_Face &face, const BS &newsurf) {
  BRep_Builder b;
  TopoDS_Face nf;
  b.MakeFace(nf, newsurf, TopLoc_Location(), TOL);
  for (const TopoDS_Shape &w : sub(face, TopAbs_WIRE)) {
    for (const TopoDS_Shape &e : sub(w, TopAbs_EDGE)) {
      TopoDS_Edge edge = TopoDS::Edge(e);
      double f, l;
      Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(edge, face, f, l);
      if (!pc.IsNull()) b.UpdateEdge(edge, pc, nf, TOL);
    }
    b.Add(nf, TopoDS::Wire(w));
  }
  nf.Orientation(face.Orientation());
  return nf;
}

inline std::vector<gp_Pnt> trace(const TopoDS_Edge &edge, const TopoDS_Face &face,
                                 const Handle(Geom_Surface) & surf, int samples = 12) {
  BRepAdaptor_Curve2d ad(edge, face);
  double a = ad.FirstParameter(), z = ad.LastParameter();
  std::vector<gp_Pnt> out;
  for (int i = 0; i <= samples; ++i) {
    gp_Pnt2d uv = ad.Value(a + (z - a) * i / samples);
    out.push_back(surf->Value(uv.X(), uv.Y()));
  }
  return out;
}

inline std::vector<TopoDS_Edge> moved_edges(const TopoDS_Face &face, const Handle(Geom_Surface) & oldsurf,
                                            const Handle(Geom_Surface) & newsurf) {
  std::vector<TopoDS_Edge> out;
  for (const TopoDS_Shape &e : sub(face, TopAbs_EDGE)) {
    TopoDS_Edge edge = TopoDS::Edge(e);
    std::vector<gp_Pnt> o = trace(edge, face, oldsurf), n = trace(edge, face, newsurf);
    bool moved = false;
    for (size_t i = 0; i < o.size() && i < n.size(); ++i) moved = moved || o[i].Distance(n[i]) > 1e-9;
    if (moved) out.push_back(edge);
  }
  return out;
}

inline gp_Vec plane_normal(const Handle(Geom_BSplineCurve) & c) {
  gp_Pnt p1 = c->Pole(1), p2 = c->Pole(2), p3 = c->Pole(3);
  return gp_Vec(p1, p2).Crossed(gp_Vec(p1, p3));
}

inline std::vector<double> roots(double a, double b, double c) {
  double scale = std::max({std::abs(a), std::abs(b), std::abs(c)});
  if (scale == 0.0) return {};
  if (std::abs(a) < 1e-15 * scale) {
    if (std::abs(b) < 1e-15 * scale) return {};
    return {-c / b};
  }
  double disc = b * b - 4 * a * c;
  if (disc < 0.0) {
    if (disc > -1e-12 * scale * scale)
      disc = 0.0;
    else
      return {};
  }
  double sq = std::sqrt(disc);
  double q = -0.5 * (b + (b >= 0 ? sq : -sq));
  if (std::abs(q) < 1e-15 * scale) return {q / a};
  return {q / a, c / q};
}

inline bool section_crosses(const Handle(Geom_BSplineCurve) & c, const gp_Pnt &x, gp_Vec e2, double hint,
                            double &out) {
  if (e2.Magnitude() <= 0.0) return false;
  e2.Normalize();
  double w[3], q[3];
  for (int i = 0; i < 3; ++i) {
    w[i] = c->Weight(i + 1);
    q[i] = gp_Vec(x, c->Pole(i + 1)).Dot(e2);
  }
  double w0q0 = w[0] * q[0], w1q1 = w[1] * q[1], w2q2 = w[2] * q[2];
  std::vector<double> found;
  for (double s : roots(w0q0 - 2 * w1q1 + w2q2, 2 * (w1q1 - w0q0), w0q0))
    if (-1e-9 <= s && s <= 1 + 1e-9) found.push_back(s);
  if (found.empty()) return false;
  double lo = c->FirstParameter(), hi = c->LastParameter();
  double best = found[0];
  for (double s : found)
    if (std::abs(lo + s * (hi - lo) - hint) < std::abs(lo + best * (hi - lo) - hint)) best = s;
  out = lo + std::min(1.0, std::max(0.0, best)) * (hi - lo);
  return true;
}

inline Handle(Geom_BSplineCurve) arc_of(const BS &bs, bool along_u, const gp_Pnt2d &uv) {
  return Handle(Geom_BSplineCurve)::DownCast(along_u ? bs->VIso(uv.Y()) : bs->UIso(uv.X()));
}

inline bool holds_its_section(const TopoDS_Edge &edge, const TopoDS_Face &face, const std::vector<bool> &dirs,
                              int samples = 12) {
  if (dirs.size() != 1) return false;
  BRepAdaptor_Curve2d ad(edge, face);
  double lo = ad.FirstParameter(), hi = ad.LastParameter();
  double u0, u1, v0, v1;
  BRepTools::UVBounds(face, u0, u1, v0, v1);
  double span = dirs[0] ? (v1 - v0) : (u1 - u0);
  double mn = 1e300, mx = -1e300;
  for (int i = 0; i <= samples; ++i) {
    gp_Pnt2d p = ad.Value(lo + (hi - lo) * i / samples);
    double h = dirs[0] ? p.Y() : p.X();
    mn = std::min(mn, h);
    mx = std::max(mx, h);
  }
  return mx - mn <= std::max(std::abs(span), TOL) * 1e-9;
}

inline double extent(const BS &bs) {
  double lo[3] = {1e300, 1e300, 1e300}, hi[3] = {-1e300, -1e300, -1e300};
  for (int i = 1; i <= bs->NbUPoles(); ++i)
    for (int j = 1; j <= bs->NbVPoles(); ++j) {
      gp_Pnt p = bs->Pole(i, j);
      double xyz[3] = {p.X(), p.Y(), p.Z()};
      for (int c = 0; c < 3; ++c) {
        lo[c] = std::min(lo[c], xyz[c]);
        hi[c] = std::max(hi[c], xyz[c]);
      }
    }
  double s = 0;
  for (int c = 0; c < 3; ++c) s += (hi[c] - lo[c]) * (hi[c] - lo[c]);
  return std::max(TOL, std::sqrt(s));
}

struct Side {
  TopoDS_Face face;
  BS bs;
  std::vector<bool> dirs;
};

inline bool sides_agree(const TopoDS_Edge &edge, const std::vector<Side> &sides, int samples = 12) {
  const Side &a = sides[0], &b = sides[1];
  double scale = std::max(extent(a.bs), extent(b.bs));
  std::vector<gp_Pnt> ta = trace(edge, a.face, a.bs, samples), tb = trace(edge, b.face, b.bs, samples);
  bool all = true;
  for (size_t i = 0; i < ta.size() && i < tb.size(); ++i) all = all && ta[i].Distance(tb[i]) <= scale * 1e-7;
  if (all) return true;
  return holds_its_section(edge, a.face, a.dirs, samples) && holds_its_section(edge, b.face, b.dirs, samples);
}

inline std::pair<TopoDS_Vertex, TopoDS_Vertex> settle_ends(const TopoDS_Edge &edge, const gp_Pnt &start,
                                                           const gp_Pnt &end, double scale,
                                                           const std::function<std::string(double)> &too_far) {
  TopoDS_Vertex v1 = TopExp::FirstVertex(edge), v2 = TopExp::LastVertex(edge);
  gp_Pnt a = BRep_Tool::Pnt(v1), b = BRep_Tool::Pnt(v2);
  if (a.Distance(start) + b.Distance(end) > b.Distance(start) + a.Distance(end)) {
    std::swap(v1, v2);
    std::swap(a, b);
  }
  std::pair<TopoDS_Vertex, gp_Pnt> ends[2] = {{v1, start}, {v2, end}};
  gp_Pnt ps[2] = {a, b};
  for (int i = 0; i < 2; ++i) {
    double gap = ps[i].Distance(ends[i].second);
    if (gap <= std::max(BRep_Tool::Tolerance(ends[i].first), TOL)) continue;
    if (gap > scale * 1e-4) throw NotApplicable{too_far(gap)};
    BRep_Builder().UpdateVertex(ends[i].first, gap * 2.0);
  }
  return {v1, v2};
}

inline std::string edge_error_name(BRepBuilderAPI_EdgeError e) {
  const char *names[] = {"BRepBuilderAPI_EdgeDone",         "BRepBuilderAPI_PointProjectionFailed",
                         "BRepBuilderAPI_ParameterOutOfRange", "BRepBuilderAPI_DifferentPointsOnClosedCurve",
                         "BRepBuilderAPI_PointWithInfiniteParameter", "BRepBuilderAPI_DifferentsPointAndParameter",
                         "BRepBuilderAPI_LineThroughIdenticPoints"};
  int i = static_cast<int>(e);
  std::string n = (i >= 0 && i < 7) ? names[i] : "BRepBuilderAPI_EdgeError";
  return "BRepBuilderAPI_EdgeError." + n;
}

inline TopoDS_Edge reseam(const TopoDS_Edge &edge, const std::vector<Side> &sides, int samples = 24) {
  const Side &A = sides[0], &B = sides[1];
  if (A.dirs.size() != 1 || B.dirs.size() != 1)
    throw NotApplicable{"two blends meet here along a corner patch, which has no single "
                        "section to re-solve, use profile 0 for a plain fillet here"};
  BRepAdaptor_Curve2d aa(edge, A.face), ab(edge, B.face);
  double lo = aa.FirstParameter(), hi = aa.LastParameter();
  Handle(Geom_Surface) olda = BRep_Tool::Surface(A.face);
  double scale = std::max(extent(A.bs), extent(B.bs));
  std::map<double, std::pair<gp_Pnt2d, gp_Pnt2d>> solved;

  auto say = [](const std::string &why) {
    return "the two blends meeting at this corner " + why +
           " at this profile, so their seam would have to be recomputed rather than "
           "reweighted, use profile 0 here";
  };

  auto crossing = [&](double t) -> std::pair<gp_Pnt2d, gp_Pnt2d> {
    auto hit = solved.find(t);
    if (hit != solved.end()) return hit->second;
    gp_Pnt2d sa = aa.Value(t), sb = ab.Value(t);
    Handle(Geom_BSplineCurve) ca = arc_of(A.bs, A.dirs[0], sa), cb = arc_of(B.bs, B.dirs[0], sb);
    gp_Vec na = plane_normal(ca), nb = plane_normal(cb);
    gp_Vec d = na.Crossed(nb);
    if (d.Magnitude() <= 1e-12 * na.Magnitude() * nb.Magnitude()) throw NotApplicable{say("lie in the same plane")};
    gp_Pnt was = olda->Value(sa.X(), sa.Y());
    double ua = 0, ub = 0;
    bool oka = section_crosses(ca, was, na.Crossed(d), A.dirs[0] ? sa.X() : sa.Y(), ua);
    bool okb = section_crosses(cb, was, nb.Crossed(d), B.dirs[0] ? sb.X() : sb.Y(), ub);
    if (!oka || !okb) throw NotApplicable{say("no longer reach each other")};
    gp_Pnt2d pa = A.dirs[0] ? gp_Pnt2d(ua, sa.Y()) : gp_Pnt2d(sa.X(), ua);
    gp_Pnt2d pb = B.dirs[0] ? gp_Pnt2d(ub, sb.Y()) : gp_Pnt2d(sb.X(), ub);
    if (A.bs->Value(pa.X(), pa.Y()).Distance(B.bs->Value(pb.X(), pb.Y())) > scale * 1e-6)
      throw NotApplicable{say("cross their shared line at different points")};
    solved[t] = {pa, pb};
    return solved[t];
  };

  auto fit = [&](const std::vector<double> &ts, int side) -> Handle(Geom2d_BSplineCurve) {
    Handle(TColgp_HArray1OfPnt2d) arr = new TColgp_HArray1OfPnt2d(1, static_cast<int>(ts.size()));
    Handle(TColStd_HArray1OfReal) par = new TColStd_HArray1OfReal(1, static_cast<int>(ts.size()));
    for (size_t i = 0; i < ts.size(); ++i) {
      auto c = crossing(ts[i]);
      arr->SetValue(static_cast<int>(i) + 1, side == 0 ? c.first : c.second);
      par->SetValue(static_cast<int>(i) + 1, ts[i]);
    }
    Geom2dAPI_Interpolate it(arr, par, false, TOL);
    it.Perform();
    if (!it.IsDone()) throw ValueError{"could not fit a blend seam pcurve"};
    return it.Curve();
  };

  std::vector<double> ts;
  for (int i = 0; i <= samples; ++i) ts.push_back(lo + (hi - lo) * i / samples);
  Handle(Geom2d_BSplineCurve) pca, pcb;
  double err = 0;
  while (true) {
    pca = fit(ts, 0);
    pcb = fit(ts, 1);
    auto miss = [&](double t) {
      gp_Pnt2d uv = pca->Value(t);
      gp_Pnt2d c = crossing(t).first;
      return A.bs->Value(uv.X(), uv.Y()).Distance(A.bs->Value(c.X(), c.Y()));
    };
    std::vector<double> mids;
    for (size_t i = 0; i + 1 < ts.size(); ++i) mids.push_back((ts[i] + ts[i + 1]) / 2);
    err = 0;
    bool first = true;
    for (double t : mids) {
      double m = miss(t);
      err = first ? m : std::max(err, m);
      first = false;
    }
    if (err <= scale * SEAM_FIT || ts.size() >= SEAM_SAMPLES_MAX) break;
    for (double t : mids)
      if (miss(t) > scale * SEAM_FIT) ts.push_back(t);
    std::sort(ts.begin(), ts.end());
  }
  if (err > scale * SEAM_LIMIT)
    throw NotApplicable{"the seam where these two blends meet does not follow the conic family at this profile "
                        "(it misses by " +
                        fmt("%.4g", err) + "), use profile 0 here"};

  gp_Pnt2d pa0 = crossing(lo).first, pa1 = crossing(hi).first;
  auto vs = settle_ends(edge, A.bs->Value(pa0.X(), pa0.Y()), A.bs->Value(pa1.X(), pa1.Y()), scale,
                        [&](double gap) { return say("end " + fmt("%.4g", gap) + " apart"); });
  BRepBuilderAPI_MakeEdge mk(pca, A.bs, vs.first, vs.second, lo, hi);
  if (!mk.IsDone()) throw ValueError{"could not rebuild a blend seam edge (" + edge_error_name(mk.Error()) + ")"};
  TopoDS_Edge ne = mk.Edge();
  BRepLib::BuildCurve3d(ne, TOL);
  BRep_Builder().UpdateEdge(ne, pcb, B.bs, TopLoc_Location(), TOL);
  ne.Orientation(edge.Orientation());
  return ne;
}

inline TopoDS_Edge rebuild_edge(const TopoDS_Edge &edge, const TopoDS_Face &face, const BS &newsurf) {
  BRepAdaptor_Curve2d ad(edge, face);
  double f, l;
  Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(edge, face, f, l);
  double p1 = ad.FirstParameter(), p2 = ad.LastParameter();
  gp_Pnt2d head = pc->Value(p1), tail = pc->Value(p2);
  gp_Pnt start = newsurf->Value(head.X(), head.Y()), end = newsurf->Value(tail.X(), tail.Y());
  auto vs = settle_ends(edge, start, end, extent(newsurf), [](double gap) {
    return "this blend is cut across its section by a neighbouring face, so its trim would have to be "
           "recomputed rather than reweighted (a corner moves " +
           fmt("%.4g", gap) + "), use profile 0 here";
  });
  BRepBuilderAPI_MakeEdge mk(pc, newsurf, vs.first, vs.second, p1, p2);
  if (!mk.IsDone()) throw ValueError{"could not rebuild a blend section edge (" + edge_error_name(mk.Error()) + ")"};
  TopoDS_Edge ne = mk.Edge();
  BRepLib::BuildCurve3d(ne, TOL);
  ne.Orientation(edge.Orientation());
  return ne;
}

inline TopoDS_Shape conic_blend(const TopoDS_Shape &sharp, const std::vector<TopoDS_Shape> &edges, double radius,
                                double profile) {
  double k = weight_scale(profile);
  BRepFilletAPI_MakeFillet mk(sharp);
  for (const TopoDS_Shape &e : edges) mk.Add(radius, TopoDS::Edge(e));
  mk.Build();
  if (!mk.IsDone()) throw ValueError{"fillet failed"};
  TopoDS_Shape filleted = mk.Shape();
  if (std::abs(k - 1.0) < PROFILE_EPS) return filleted;

  Handle(BRepTools_ReShape) reshape = new BRepTools_ReShape();
  std::vector<std::pair<TopoDS_Edge, std::vector<Side>>> stale;
  for (const TopoDS_Face &face : blend_faces(sharp, mk, filleted)) {
    BS bs = nurbs_of(face);
    std::vector<bool> dirs = arc_dirs(bs);
    if (dirs.empty())
      throw NotApplicable{"this edge's blend has no conic profile, use profile 0 for a plain fillet here"};
    for (bool along_u : dirs) reweight(bs, along_u, k);
    for (const TopoDS_Edge &e : moved_edges(face, BRep_Tool::Surface(face), bs)) {
      bool placed = false;
      for (auto &grp : stale) {
        if (grp.first.IsSame(e)) {
          grp.second.push_back({face, bs, dirs});
          placed = true;
          break;
        }
      }
      if (!placed) stale.push_back({e, {{face, bs, dirs}}});
    }
    reshape->Replace(face, reskin(face, bs));
  }
  TopoDS_Shape out = reshape->Apply(filleted);

  Handle(BRepTools_ReShape) reshape2 = new BRepTools_ReShape();
  for (auto &grp : stale) {
    const Side &s0 = grp.second[0];
    TopoDS_Edge ne = (grp.second.size() < 2 || sides_agree(grp.first, grp.second))
                         ? rebuild_edge(grp.first, s0.face, s0.bs)
                         : reseam(grp.first, grp.second);
    reshape2->Replace(grp.first, ne);
  }
  out = reshape2->Apply(out);

  Handle(ShapeFix_Shape) fix = new ShapeFix_Shape(out);
  fix->SetPrecision(TOL);
  fix->Perform();
  out = fix->Shape();
  BRepLib::SameParameter(out, TOL, true);

  if (!BRepCheck_Analyzer(out).IsValid())
    throw ValueError{"the conic profile produced an invalid solid at profile " + fmt("%g", profile)};
  return out;
}

} // namespace conic

// status 0 built, 1 ConicNotApplicable, 2 any other refusal; `message` says why.
inline std::unique_ptr<TopoDS_Shape> blend_conic(const TopoDS_Shape &sharp, const TopoDS_Shape &edges, double radius,
                                                 double profile, int32_t &status, rust::String &message) {
  std::vector<TopoDS_Shape> es;
  for (TopoDS_Iterator it(edges); it.More(); it.Next()) es.push_back(it.Value());
  try {
    TopoDS_Shape out = conic::conic_blend(sharp, es, radius, profile);
    status = 0;
    return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(out));
  } catch (const conic::NotApplicable &e) {
    status = 1;
    message = e.msg;
  } catch (const conic::ValueError &e) {
    status = 2;
    message = e.msg;
  } catch (const Standard_Failure &e) {
    status = 2;
    const char *detail = e.GetMessageString();
    message = (detail != nullptr && *detail != '\0') ? std::string(detail) : std::string(e.DynamicType()->Name());
  } catch (const std::exception &e) {
    status = 2;
    message = e.what();
  } catch (...) {
    status = 2;
    message = "unknown C++ exception";
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape());
}
