#pragma once
// Surface parameters, boxes and arc-length samples for face bands, inspect and
// projection (fundacad-geom::{faces, inspect, projection}), each the build123d
// or OCP call the Python engine makes for the same number.

#include "rust/cxx.h"
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GCPnts_QuasiUniformDeflection.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <gp_Trsf.hxx>
#include <GProp_GProps.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <TopAbs.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax1.hxx>
#include <gp_Circ.hxx>
#include <gp_Cone.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>
#include <gp_Vec.hxx>

#include <cstdint>
#include <memory>
#include <limits>
#include <stdexcept>

inline void fq_require(const rust::Slice<double> &out, size_t n) {
  if (out.size() < n) throw std::invalid_argument("output slice too short");
}

inline const TopoDS_Face &fq_face(const TopoDS_Shape &s) {
  if (s.IsNull() || s.ShapeType() != TopAbs_FACE) throw std::invalid_argument("not a face");
  return TopoDS::Face(s);
}

inline const TopoDS_Edge &fq_edge(const TopoDS_Shape &s) {
  if (s.IsNull() || s.ShapeType() != TopAbs_EDGE) throw std::invalid_argument("not an edge");
  return TopoDS::Edge(s);
}

inline void fq_put(rust::Slice<double> &out, size_t at, const gp_XYZ &v) {
  out[at] = v.X();
  out[at + 1] = v.Y();
  out[at + 2] = v.Z();
}

// Returns the kind: 0 plane, 1 cylinder, 2 cone, 3 sphere, 4 torus, 5 surface
// of revolution, -1 anything else. out (13): [reversed flag, dir xyz, location
// xyz, r1, r2, apex xyz]. Plane: axis. Cylinder: axis, radius. Cone: axis,
// semi-angle in r1, apex. Sphere: location, radius. Torus: axis, major, minor.
// Revolution: the axis of revolution.
inline int FQ_surface(const TopoDS_Shape &shape, rust::Slice<double> out) {
  fq_require(out, 13);
  for (size_t i = 0; i < 13; ++i) out[i] = 0.0;
  const TopoDS_Face &face = fq_face(shape);
  out[0] = face.Orientation() == TopAbs_REVERSED ? 1.0 : 0.0;
  BRepAdaptor_Surface ad(face);
  gp_Ax1 ax;
  switch (ad.GetType()) {
  case GeomAbs_Plane: {
    ax = ad.Plane().Axis();
    fq_put(out, 1, ax.Direction().XYZ());
    fq_put(out, 4, ax.Location().XYZ());
    return 0;
  }
  case GeomAbs_Cylinder: {
    gp_Cylinder c = ad.Cylinder();
    fq_put(out, 1, c.Axis().Direction().XYZ());
    fq_put(out, 4, c.Axis().Location().XYZ());
    out[7] = c.Radius();
    return 1;
  }
  case GeomAbs_Cone: {
    gp_Cone c = ad.Cone();
    fq_put(out, 1, c.Axis().Direction().XYZ());
    fq_put(out, 4, c.Axis().Location().XYZ());
    out[7] = c.SemiAngle();
    fq_put(out, 9, c.Apex().XYZ());
    return 2;
  }
  case GeomAbs_Sphere: {
    gp_Sphere s = ad.Sphere();
    fq_put(out, 4, s.Location().XYZ());
    out[7] = s.Radius();
    return 3;
  }
  case GeomAbs_Torus: {
    gp_Torus t = ad.Torus();
    fq_put(out, 1, t.Axis().Direction().XYZ());
    fq_put(out, 4, t.Axis().Location().XYZ());
    out[7] = t.MajorRadius();
    out[8] = t.MinorRadius();
    return 4;
  }
  case GeomAbs_SurfaceOfRevolution: {
    ax = ad.AxeOfRevolution();
    fq_put(out, 1, ax.Direction().XYZ());
    fq_put(out, 4, ax.Location().XYZ());
    return 5;
  }
  default:
    return -1;
  }
}

// BRepGProp_Face at the middle of its parameter bounds: point, raw normal.
inline void FQ_mid_normal(const TopoDS_Shape &shape, rust::Slice<double> out) {
  fq_require(out, 6);
  BRepGProp_Face props(fq_face(shape));
  Standard_Real u0, u1, v0, v1;
  props.Bounds(u0, u1, v0, v1);
  gp_Pnt p;
  gp_Vec n;
  props.Normal((u0 + u1) / 2.0, (v0 + v1) / 2.0, p, n);
  fq_put(out, 0, p.XYZ());
  fq_put(out, 3, n.XYZ());
}

// Bnd_Box from the B-rep alone, never a triangulation. False when void.
inline bool FQ_bbox(const TopoDS_Shape &shape, bool optimal, rust::Slice<double> out) {
  fq_require(out, 6);
  Bnd_Box box;
  if (optimal)
    BRepBndLib::AddOptimal(shape, box, false, false);
  else
    BRepBndLib::Add(shape, box, false);
  if (box.IsVoid()) return false;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  out[0] = x0; out[1] = y0; out[2] = z0; out[3] = x1; out[4] = y1; out[5] = z1;
  return true;
}

// What one face adds to BRepBndLib::AddOptimal of a shape holding it. A bare
// face would also count its own edges as free ones, a compound of it does not.
inline bool FQ_face_bbox(const TopoDS_Shape &face, rust::Slice<double> out) {
  TopoDS_Compound c;
  BRep_Builder b;
  b.MakeCompound(c);
  b.Add(c, face);
  return FQ_bbox(c, true, out);
}

inline std::uint64_t FQ_tshape(const TopoDS_Shape &shape) {
  return static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(shape.TShape().get()));
}

// The shape's own placement, row-major 3x4 with any scale folded in; false
// for the identity.
inline bool FQ_location(const TopoDS_Shape &shape, rust::Slice<double> out) {
  fq_require(out, 12);
  const gp_Trsf t = shape.Location().Transformation();
  for (int r = 1; r <= 3; ++r)
    for (int c = 1; c <= 4; ++c) out[(r - 1) * 4 + (c - 1)] = t.Value(r, c);
  return !shape.Location().IsIdentity();
}

inline std::unique_ptr<TopoDS_Shape> FQ_unlocated(const TopoDS_Shape &shape) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(shape.Located(TopLoc_Location())));
}

inline int32_t FQ_orientation(const TopoDS_Shape &shape) { return static_cast<int32_t>(shape.Orientation()); }

// Edges outside every face or vertices outside every edge, which a box built
// face by face would miss.
inline bool FQ_free_parts(const TopoDS_Shape &shape) {
  return TopExp_Explorer(shape, TopAbs_EDGE, TopAbs_FACE).More() ||
         TopExp_Explorer(shape, TopAbs_VERTEX, TopAbs_EDGE).More();
}

// 0 plane, 1 cylinder, 2 cone, 3 sphere, 4 torus, 5 bezier or bspline, 6 other.
inline int32_t FQ_surface_code(const TopoDS_Shape &shape) {
  if (shape.IsNull() || shape.ShapeType() != TopAbs_FACE) return 6;
  try {
    switch (BRepAdaptor_Surface(TopoDS::Face(shape)).GetType()) {
    case GeomAbs_Plane: return 0;
    case GeomAbs_Cylinder: return 1;
    case GeomAbs_Cone: return 2;
    case GeomAbs_Sphere: return 3;
    case GeomAbs_Torus: return 4;
    case GeomAbs_BezierSurface:
    case GeomAbs_BSplineSurface: return 5;
    default: return 6;
    }
  } catch (...) {
    return 6;
  }
}

// BRepGProp with OCP's defaults (skip shared false): mass, centre xyz. kind 2
// surface, 3 volume.
inline void FQ_mass(const TopoDS_Shape &shape, int kind, rust::Slice<double> out) {
  fq_require(out, 4);
  GProp_GProps g;
  if (kind == 3)
    BRepGProp::VolumeProperties(shape, g);
  else
    BRepGProp::SurfaceProperties(shape, g);
  out[0] = g.Mass();
  fq_put(out, 1, g.CentreOfMass().XYZ());
}

// build123d `Edge.length`, GCPnts_AbscissaPoint over the adaptor.
inline double FQ_edge_length(const TopoDS_Shape &shape) {
  BRepAdaptor_Curve c(fq_edge(shape));
  return GCPnts_AbscissaPoint::Length(c);
}

// build123d `position_at(t)` for each t: arc length, edge orientation applied.
inline void FQ_edge_positions(const TopoDS_Shape &shape, rust::Slice<const double> ts, rust::Slice<double> out) {
  fq_require(out, ts.size() * 3);
  const TopoDS_Edge &e = fq_edge(shape);
  BRepAdaptor_Curve c(e);
  bool forward = e.Orientation() == TopAbs_FORWARD;
  double length = GCPnts_AbscissaPoint::Length(c);
  for (size_t i = 0; i < ts.size(); ++i) {
    double value = forward ? ts[i] : 1.0 - ts[i];
    GCPnts_AbscissaPoint ap(c, length * value, c.FirstParameter());
    if (!ap.IsDone()) throw std::runtime_error("GCPnts_AbscissaPoint failed");
    fq_put(out, i * 3, c.Value(ap.Parameter()).XYZ());
  }
}

// tessellate._uniform_param_points: n + 1 points over the raw parameter. False
// when the range is empty.
inline bool FQ_edge_param_points(const TopoDS_Shape &shape, int n, rust::Slice<double> out) {
  if (n < 1) throw std::invalid_argument("n must be positive");
  fq_require(out, static_cast<size_t>(n + 1) * 3);
  BRepAdaptor_Curve c(fq_edge(shape));
  double u0 = c.FirstParameter(), u1 = c.LastParameter();
  if (!(u1 > u0)) return false;
  for (int j = 0; j <= n; ++j) fq_put(out, static_cast<size_t>(j) * 3, c.Value(u0 + (u1 - u0) * (double(j) / n)).XYZ());
  return true;
}

// A circle edge: [axis dir xyz, centre xyz, radius]. False for other curves.
inline bool FQ_edge_circle(const TopoDS_Shape &shape, rust::Slice<double> out) {
  fq_require(out, 7);
  BRepAdaptor_Curve c(fq_edge(shape));
  if (c.GetType() != GeomAbs_Circle) return false;
  gp_Circ circ = c.Circle();
  fq_put(out, 0, circ.Axis().Direction().XYZ());
  fq_put(out, 3, circ.Position().Location().XYZ());
  out[6] = circ.Radius();
  return true;
}

// Every boundary edge of `face` as a polyline within `deflection` of the
// curve, each followed by a NaN triple. False when an edge will not sample.
inline bool FQ_face_boundary(const TopoDS_Shape &face, double deflection, rust::Vec<double> &out) {
  for (TopExp_Explorer x(face, TopAbs_EDGE); x.More(); x.Next()) {
    const TopoDS_Edge &edge = TopoDS::Edge(x.Current());
    if (BRep_Tool::Degenerated(edge)) continue;
    BRepAdaptor_Curve c(edge);
    GCPnts_QuasiUniformDeflection pts(c, deflection);
    if (!pts.IsDone() || pts.NbPoints() < 2) return false;
    for (int i = 1; i <= pts.NbPoints(); ++i) {
      const gp_Pnt p = pts.Value(i);
      out.push_back(p.X());
      out.push_back(p.Y());
      out.push_back(p.Z());
    }
    for (int k = 0; k < 3; ++k) out.push_back(std::numeric_limits<double>::quiet_NaN());
  }
  return true;
}

inline bool FQ_edge_closed(const TopoDS_Shape &shape) {
  return BRep_Tool::IsClosed(fq_edge(shape));
}
