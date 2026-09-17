#pragma once
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <bindings_common.hxx>
#include <gp_Pnt2d.hxx>
#include <stdexcept>

inline void surface_query_require(const rust::Slice<double> &out, size_t n) {
  if (out.size() < n) {
    throw std::invalid_argument("output slice too short");
  }
}

inline void BRepTools_uv_bounds(const TopoDS_Face &face, rust::Slice<double> out) {
  surface_query_require(out, 4);
  Standard_Real umin = 0.0, umax = 0.0, vmin = 0.0, vmax = 0.0;
  BRepTools::UVBounds(face, umin, umax, vmin, vmax);
  out[0] = umin;
  out[1] = umax;
  out[2] = vmin;
  out[3] = vmax;
}

inline int BRepAdaptor_Surface_closure(const TopoDS_Face &face) {
  BRepAdaptor_Surface surface(face);
  return (surface.IsUClosed() ? 1 : 0) | (surface.IsVClosed() ? 2 : 0) | (surface.IsUPeriodic() ? 4 : 0) |
         (surface.IsVPeriodic() ? 8 : 0);
}

inline void BRepGProp_Face_point_normal(const TopoDS_Face &face, double u, double v, rust::Slice<double> out) {
  surface_query_require(out, 6);
  BRepGProp_Face props(face);
  gp_Pnt p;
  gp_Vec n;
  props.Normal(u, v, p, n);
  if (n.Magnitude() < gp::Resolution()) {
    throw std::runtime_error("the surface normal is undefined there");
  }
  n.Normalize();
  out[0] = p.X();
  out[1] = p.Y();
  out[2] = p.Z();
  out[3] = n.X();
  out[4] = n.Y();
  out[5] = n.Z();
}

inline bool GeomAPI_ProjectPointOnSurf_face(const TopoDS_Face &face, double x, double y, double z,
                                            rust::Slice<double> out) {
  surface_query_require(out, 6);
  Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
  if (surface.IsNull()) {
    return false;
  }
  GeomAPI_ProjectPointOnSurf projector(gp_Pnt(x, y, z), surface);
  if (!projector.IsDone() || projector.NbPoints() < 1) {
    return false;
  }
  Standard_Real u = 0.0, v = 0.0;
  projector.LowerDistanceParameters(u, v);
  gp_Pnt p = projector.NearestPoint();
  out[0] = u;
  out[1] = v;
  out[2] = projector.LowerDistance();
  out[3] = p.X();
  out[4] = p.Y();
  out[5] = p.Z();
  return true;
}

inline int BRepClass_FaceClassifier_uv(const TopoDS_Face &face, double u, double v, double tol) {
  BRepClass_FaceClassifier classifier(face, gp_Pnt2d(u, v), tol);
  return static_cast<int>(classifier.State());
}

inline int BRepClass_FaceClassifier_point(const TopoDS_Face &face, double x, double y, double z, double tol) {
  BRepClass_FaceClassifier classifier(face, gp_Pnt(x, y, z), tol);
  return static_cast<int>(classifier.State());
}

inline int BRepAdaptor_Curve_range(const TopoDS_Edge &edge, rust::Slice<double> out) {
  surface_query_require(out, 2);
  if (BRep_Tool::Degenerated(edge)) {
    Standard_Real first = 0.0, last = 0.0;
    BRep_Tool::Range(edge, first, last);
    out[0] = first;
    out[1] = last;
    return 4;
  }
  BRepAdaptor_Curve curve(edge);
  out[0] = curve.FirstParameter();
  out[1] = curve.LastParameter();
  return (curve.IsClosed() ? 1 : 0) | (curve.IsPeriodic() ? 2 : 0);
}

inline void BRepAdaptor_Curve_d1(const TopoDS_Edge &edge, double t, rust::Slice<double> out) {
  surface_query_require(out, 6);
  BRepAdaptor_Curve curve(edge);
  gp_Pnt p;
  gp_Vec d;
  curve.D1(t, p, d);
  out[0] = p.X();
  out[1] = p.Y();
  out[2] = p.Z();
  out[3] = d.X();
  out[4] = d.Y();
  out[5] = d.Z();
}

inline bool BRep_Tool_is_closed_on(const TopoDS_Edge &edge, const TopoDS_Face &face) {
  return BRep_Tool::IsClosed(edge, face);
}

inline double BRep_Tool_edge_tolerance(const TopoDS_Edge &edge) { return BRep_Tool::Tolerance(edge); }

inline double BRep_Tool_face_tolerance(const TopoDS_Face &face) { return BRep_Tool::Tolerance(face); }
