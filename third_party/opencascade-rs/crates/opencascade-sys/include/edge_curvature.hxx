#pragma once

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Curve2d.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepLProp_SLProps.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <cmath>

// A face is flat across an edge for a G2 or G3 fillet of radius R while its
// curvature across the edge times R stays below this. The fillet tool applies
// the same bound to the curvature a mesh edge reports (src/features/continuity.ts).
const double FLAT_ACROSS = 1e-6;

// The curvature an edge reports when it cannot be read, so every radius refuses.
const double CURVATURE_UNKNOWN = 1e30;

// The normal curvature of the surface in tangent direction `d`, signed
// against the surface's own normal, NaN where it is not defined.
inline double normal_curvature(BRepLProp_SLProps &props, const gp_Vec &d) {
  if (!props.IsCurvatureDefined()) return NAN;
  if (props.IsUmbilic()) return props.MeanCurvature();
  gp_Dir dmax, dmin;
  props.CurvatureDirections(dmax, dmin);
  double c = d.Dot(gp_Vec(dmax));
  return props.MaxCurvature() * c * c + props.MinCurvature() * (1 - c * c);
}

// The largest normal curvature of `face` across `edge`, in its tangent plane
// perpendicular to the edge, sampled along the edge; -1 when it cannot be read.
inline double face_curvature_across(const TopoDS_Edge &edge, const TopoDS_Face &face) {
  try {
    BRepAdaptor_Surface surf(face, false);
    if (surf.GetType() == GeomAbs_Plane) return 0.0;
    BRepAdaptor_Curve crv(edge);
    BRepAdaptor_Curve2d pc(edge, face);
    double t0 = crv.FirstParameter(), t1 = crv.LastParameter();
    double worst = 0.0;
    const double fracs[5] = {0.1, 0.3, 0.5, 0.7, 0.9};
    for (double f : fracs) {
      double t = t0 + (t1 - t0) * f;
      gp_Pnt p;
      gp_Vec T;
      crv.D1(t, p, T);
      if (T.Magnitude() < 1e-12) return -1.0;
      gp_Pnt2d uv = pc.Value(t);
      BRepLProp_SLProps props(surf, uv.X(), uv.Y(), 2, 1e-9);
      if (!props.IsNormalDefined()) return -1.0;
      gp_Vec d = gp_Vec(props.Normal()).Crossed(T);
      if (d.Magnitude() < 1e-12) return -1.0;
      double k = normal_curvature(props, d.Normalized());
      if (std::isnan(k)) return -1.0;
      worst = std::max(worst, std::abs(k));
    }
    return worst;
  } catch (...) {
    return -1.0;
  }
}
