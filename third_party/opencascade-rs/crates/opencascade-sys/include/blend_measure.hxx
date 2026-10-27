#pragma once

// A test helper: how smoothly a blended body's faces meet. The FFI has no
// curvature query, and the G2 and G3 goldens need one.

#include "rust/cxx.h"
#include "edge_curvature.hxx"

#include <BRepCheck_Analyzer.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>

#include <vector>

namespace blendmeasure {

// κ along a walk into `face` from edge point `p`, perpendicular to the edge:
// the value and the rate at the edge from a cubic fit over `span`, signed
// against the face's outward normal. False where the face cannot be walked.
inline bool walk(const TopoDS_Face &face, const TopoDS_Edge &edge, double t, double span, double &k0, double &k1,
                 gp_Vec &normal) {
  BRepAdaptor_Surface surf(face, false);
  BRepAdaptor_Curve crv(edge);
  BRepAdaptor_Curve2d pc(edge, face);
  double flip = face.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
  gp_Pnt p;
  gp_Vec T;
  crv.D1(t, p, T);
  if (T.Magnitude() < 1e-12) return false;
  T.Normalize();
  gp_Pnt2d uv = pc.Value(t);
  gp_Pnt sp;
  gp_Vec su, sv;
  surf.D1(uv.X(), uv.Y(), sp, su, sv);
  gp_Vec n = su.Crossed(sv);
  if (n.Magnitude() < 1e-12) return false;
  n.Normalize();
  normal = n.Multiplied(flip);
  gp_Vec d = n.Crossed(T).Normalized();
  // Which way is into the face: step a little in uv along d and classify.
  double a = su.Dot(su), b = su.Dot(sv), c = sv.Dot(sv), e = d.Dot(su), f = d.Dot(sv), den = a * c - b * b;
  if (std::abs(den) < 1e-18) return false;
  double du = (e * c - f * b) / den, dv = (a * f - b * e) / den, step = span * 1e-3;
  BRepClass_FaceClassifier cls(face, gp_Pnt2d(uv.X() + du * step, uv.Y() + dv * step), 1e-9);
  if (cls.State() != TopAbs_IN) d.Reverse();
  Handle(Geom_Surface) gs = BRep_Tool::Surface(face);
  const int n_s = 9;
  double xs[n_s], ks[n_s];
  for (int j = 0; j < n_s; ++j) {
    double s = span * j / (n_s - 1);
    gp_Pnt q = p.Translated(d.Multiplied(s));
    GeomAPI_ProjectPointOnSurf proj(q, gs);
    if (proj.NbPoints() == 0) return false;
    double u, v;
    proj.LowerDistanceParameters(u, v);
    BRepLProp_SLProps props(surf, u, v, 2, 1e-9);
    if (!props.IsNormalDefined()) return false;
    gp_Vec dj = gp_Vec(props.Normal()).Crossed(T);
    if (dj.Magnitude() < 1e-12) return false;
    double k = normal_curvature(props, dj.Normalized());
    if (std::isnan(k)) return false;
    xs[j] = s / span;
    ks[j] = k * flip;
  }
  // Least squares cubic in x = s / span.
  double M[4][5] = {};
  for (int j = 0; j < n_s; ++j) {
    double pw[4] = {1, xs[j], xs[j] * xs[j], xs[j] * xs[j] * xs[j]};
    for (int r = 0; r < 4; ++r) {
      for (int q = 0; q < 4; ++q) M[r][q] += pw[r] * pw[q];
      M[r][4] += pw[r] * ks[j];
    }
  }
  for (int col = 0; col < 4; ++col) {
    int piv = col;
    for (int r = col + 1; r < 4; ++r)
      if (std::abs(M[r][col]) > std::abs(M[piv][col])) piv = r;
    for (int q = 0; q < 5; ++q) std::swap(M[col][q], M[piv][q]);
    if (std::abs(M[col][col]) < 1e-300) return false;
    for (int r = 0; r < 4; ++r) {
      if (r == col) continue;
      double m = M[r][col] / M[col][col];
      for (int q = 0; q < 5; ++q) M[r][q] -= m * M[col][q];
    }
  }
  k0 = M[0][4] / M[0][0];
  k1 = M[1][4] / M[1][1] / span;
  return true;
}

} // namespace blendmeasure

// [largest curvature jump times radius, largest curvature rate jump times
// radius squared, largest crease in degrees among edges whose faces meet
// within 5 degrees, edges measured as tangent contacts, largest tolerance,
// 1 when BRepCheck passes]. The walks span 4 percent of `reach` into each face.
inline rust::Vec<double> blend_contact_jumps_unguarded(const TopoDS_Shape &shape, double radius, double reach) {
  double dk = 0, drate = 0, crease = 0, contacts = 0, tol = 0;
  TopTools_IndexedDataMapOfShapeListOfShape map;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, map);
  for (int i = 1; i <= map.Extent(); ++i) {
    const TopoDS_Edge &edge = TopoDS::Edge(map.FindKey(i));
    if (BRep_Tool::Degenerated(edge)) continue;
    std::vector<TopoDS_Face> faces;
    for (TopTools_ListOfShape::Iterator it(map.FindFromIndex(i)); it.More(); it.Next()) {
      bool seen = false;
      for (const TopoDS_Face &f : faces) seen = seen || f.IsSame(it.Value());
      if (!seen) faces.push_back(TopoDS::Face(it.Value()));
    }
    if (faces.size() != 2) continue;
    BRepAdaptor_Curve crv(edge);
    double t0 = crv.FirstParameter(), t1 = crv.LastParameter();
    const double at[3] = {0.25, 0.5, 0.75};
    for (double frac : at) {
      double t = t0 + (t1 - t0) * frac;
      double k0[2], k1[2];
      gp_Vec n[2];
      bool ok = true;
      for (int k = 0; k < 2 && ok; ++k) {
        try {
          ok = blendmeasure::walk(faces[k], edge, t, 0.04 * reach, k0[k], k1[k], n[k]);
        } catch (...) {
          ok = false;
        }
      }
      if (!ok) continue;
      double ang = n[0].Angle(n[1]) * 180.0 / M_PI;
      if (ang < 5.0) crease = std::max(crease, ang);
      if (ang > 0.05) continue;
      contacts += frac == 0.5 ? 1 : 0;
      dk = std::max(dk, std::abs(k0[0] - k0[1]) * radius);
      drate = std::max(drate, std::abs(k1[0] + k1[1]) * radius * radius);
    }
  }
  for (TopExp_Explorer ex(shape, TopAbs_VERTEX); ex.More(); ex.Next())
    tol = std::max(tol, BRep_Tool::Tolerance(TopoDS::Vertex(ex.Current())));
  for (TopExp_Explorer ex(shape, TopAbs_EDGE); ex.More(); ex.Next())
    tol = std::max(tol, BRep_Tool::Tolerance(TopoDS::Edge(ex.Current())));
  for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next())
    tol = std::max(tol, BRep_Tool::Tolerance(TopoDS::Face(ex.Current())));
  rust::Vec<double> out;
  for (double x : {dk, drate, crease, contacts, tol, BRepCheck_Analyzer(shape).IsValid() ? 1.0 : 0.0}) out.push_back(x);
  return out;
}

// Empty when the measurement raised.
inline rust::Vec<double> blend_contact_jumps(const TopoDS_Shape &shape, double radius, double reach) {
  try {
    return blend_contact_jumps_unguarded(shape, radius, reach);
  } catch (...) {
    return rust::Vec<double>();
  }
}
