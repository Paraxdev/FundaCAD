#pragma once
// Geometry readback for selector resolution (fundacad-geom::select), each probe
// computing what build123d computes for the same property in the Python engine's `geom_select.py`,
// so both engines score the same numbers. Probes never throw: an OCCT failure
// reads as a false return, which the resolver maps to Python's `except` branch.

#include "rust/cxx.h"
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <GeomLib_IsPlanarSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_SphericalSurface.hxx>
#include <Geom_Surface.hxx>
#include <TopAbs.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp.hxx>
#include <gp_Ax1.hxx>
#include <gp_Circ.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <cmath>
#include <limits>
#include <memory>
#include <vector>

using SaShapes = std::unique_ptr<std::vector<TopoDS_Shape>>;

// build123d `edges()` / `faces()` / `vertices()`: explorer order, one entry per
// TShape and location at the position first met, carrying the orientation of
// the LAST occurrence (a dict keyed by hash). Degenerate edges are dropped.
// kind: 0 vertex, 1 edge, 2 face.
inline SaShapes sa_items(const TopoDS_Shape &s, int kind) {
  SaShapes out(new std::vector<TopoDS_Shape>());
  if (s.IsNull()) return out;
  TopAbs_ShapeEnum t = kind == 0 ? TopAbs_VERTEX : (kind == 1 ? TopAbs_EDGE : TopAbs_FACE);
  try {
    TopTools_IndexedMapOfShape seen;
    for (TopExp_Explorer ex(s, t); ex.More(); ex.Next()) {
      const TopoDS_Shape &c = ex.Current();
      Standard_Integer i = seen.FindIndex(c);
      if (i == 0) {
        seen.Add(c);
        out->push_back(c);
      } else {
        (*out)[i - 1] = c;
      }
    }
    if (kind == 1) {
      std::vector<TopoDS_Shape> kept;
      for (const TopoDS_Shape &e : *out)
        if (!BRep_Tool::Degenerated(TopoDS::Edge(e))) kept.push_back(e);
      out->swap(kept);
    }
  } catch (...) {
    out->clear();
  }
  return out;
}

// build123d `Mixin1D._occt_param_at(position)` in PARAMETER mode.
inline double sa_param_at(const BRepAdaptor_Curve &c, const TopoDS_Edge &e, double position) {
  bool forward = e.Orientation() == TopAbs_FORWARD;
  double value = forward ? position : 1.0 - position;
  double length = GCPnts_AbscissaPoint::Length(c);
  return GCPnts_AbscissaPoint(c, length * value, c.FirstParameter()).Parameter();
}

// build123d `tangent_at(position)`, false where it raises (a zero derivative).
inline bool sa_tangent(const TopoDS_Edge &e, double position, double out[3]) {
  try {
    BRepAdaptor_Curve c(e);
    double u = sa_param_at(c, e, position);
    gp_Vec d = c.DN(u, 1);
    if (d.Magnitude() == 0.0) return false;
    if (e.Orientation() != TopAbs_FORWARD) d.Reverse();
    if (d.Magnitude() <= gp::Resolution()) return false;
    d.Normalize();
    out[0] = d.X(); out[1] = d.Y(); out[2] = d.Z();
    return true;
  } catch (...) {
    return false;
  }
}

inline double sa_curve_code(GeomAbs_CurveType t) {
  switch (t) {
  case GeomAbs_Line: return 0;
  case GeomAbs_Circle: return 1;
  case GeomAbs_Ellipse: return 2;
  case GeomAbs_BezierCurve:
  case GeomAbs_BSplineCurve: return 3;
  default: return 4;
  }
}

// [ok, mid xyz, ok, tangent(0.5) xyz, ok, length, curve code, ok, radius,
//  centre xyz, ok, first vertex xyz, last vertex xyz], 23 values.
inline bool sa_edge_probe(const TopoDS_Shape &shape, rust::Slice<double> out) {
  if (out.size() < 23) return false;
  for (size_t i = 0; i < 23; ++i) out[i] = 0.0;
  if (shape.IsNull() || shape.ShapeType() != TopAbs_EDGE) return false;
  const TopoDS_Edge &e = TopoDS::Edge(shape);
  out[10] = 4;
  try {
    BRepAdaptor_Curve c(e);
    gp_Pnt p = c.Value(sa_param_at(c, e, 0.5));
    out[0] = 1; out[1] = p.X(); out[2] = p.Y(); out[3] = p.Z();
  } catch (...) {
  }
  double t[3];
  if (sa_tangent(e, 0.5, t)) {
    out[4] = 1; out[5] = t[0]; out[6] = t[1]; out[7] = t[2];
  }
  try {
    GProp_GProps props;
    BRepGProp::LinearProperties(e, props);
    out[8] = 1; out[9] = props.Mass();
  } catch (...) {
  }
  try {
    BRepAdaptor_Curve c(e);
    GeomAbs_CurveType ct = c.GetType();
    out[10] = sa_curve_code(ct);
    if (ct == GeomAbs_Circle) {
      gp_Circ circ = c.Circle();
      gp_Pnt o = circ.Position().Location();
      out[11] = 1; out[12] = circ.Radius(); out[13] = o.X(); out[14] = o.Y(); out[15] = o.Z();
    }
  } catch (...) {
    out[11] = 0;
  }
  try {
    TopTools_IndexedMapOfShape vs;
    for (TopExp_Explorer ex(e, TopAbs_VERTEX); ex.More(); ex.Next()) vs.Add(ex.Current());
    if (vs.Extent() > 0) {
      gp_Pnt a = BRep_Tool::Pnt(TopoDS::Vertex(vs.FindKey(1)));
      gp_Pnt b = BRep_Tool::Pnt(TopoDS::Vertex(vs.FindKey(vs.Extent())));
      out[16] = 1;
      out[17] = a.X(); out[18] = a.Y(); out[19] = a.Z();
      out[20] = b.X(); out[21] = b.Y(); out[22] = b.Z();
    }
  } catch (...) {
    out[16] = 0;
  }
  return true;
}

inline bool sa_edge_tangent(const TopoDS_Shape &shape, double position, rust::Slice<double> out) {
  if (out.size() < 3 || shape.IsNull() || shape.ShapeType() != TopAbs_EDGE) return false;
  double t[3];
  if (!sa_tangent(TopoDS::Edge(shape), position, t)) return false;
  out[0] = t[0]; out[1] = t[1]; out[2] = t[2];
  return true;
}

// build123d `filter_by(Axis)` on an edge: a line whose direction at its first
// parameter is parallel to the axis within `ang_tol` radians. -1 where it raises.
inline int sa_edge_line_parallel(const TopoDS_Shape &shape, double ax, double ay, double az,
                                 double ang_tol) {
  try {
    if (shape.IsNull() || shape.ShapeType() != TopAbs_EDGE) return 0;
    BRepAdaptor_Curve c(TopoDS::Edge(shape));
    if (c.GetType() != GeomAbs_Line) return 0;
    gp_Pnt p;
    gp_Vec v;
    c.D1(c.FirstParameter(), p, v);
    gp_Ax1 edge_axis(p, gp_Dir(v));
    gp_Ax1 axis(gp_Pnt(0, 0, 0), gp_Dir(ax, ay, az));
    return axis.IsParallel(edge_axis, ang_tol) ? 1 : 0;
  } catch (...) {
    return -1;
  }
}

inline double sa_surface_code(GeomAbs_SurfaceType t) {
  switch (t) {
  case GeomAbs_Plane: return 0;
  case GeomAbs_Cylinder: return 1;
  case GeomAbs_Cone: return 2;
  case GeomAbs_Sphere: return 3;
  case GeomAbs_Torus: return 4;
  case GeomAbs_BezierSurface:
  case GeomAbs_BSplineSurface: return 5;
  default: return 6;
  }
}

// [ok, centre xyz, ok, normal xyz, ok, area, surface code, ok, radius], 13 values.
// The centre is build123d `Face.center()`: the area centroid of a planar face,
// the point at the middle of the UV bounds otherwise.
inline bool sa_face_probe(const TopoDS_Shape &shape, rust::Slice<double> out) {
  if (out.size() < 13) return false;
  for (size_t i = 0; i < 13; ++i) out[i] = 0.0;
  if (shape.IsNull() || shape.ShapeType() != TopAbs_FACE) return false;
  const TopoDS_Face &face = TopoDS::Face(shape);
  out[10] = 6;
  try {
    Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
    bool planar = !surf.IsNull() && GeomLib_IsPlanarSurface(surf, 1e-6).IsPlanar();
    gp_Pnt c;
    if (planar) {
      GProp_GProps props;
      BRepGProp::SurfaceProperties(face, props);
      c = props.CentreOfMass();
    } else {
      double u0, u1, v0, v1;
      BRepTools::UVBounds(face, u0, u1, v0, v1);
      gp_Vec n;
      BRepGProp_Face(face).Normal(0.5 * (u0 + u1), 0.5 * (v0 + v1), c, n);
    }
    out[0] = 1; out[1] = c.X(); out[2] = c.Y(); out[3] = c.Z();
  } catch (...) {
  }
  try {
    double u0, u1, v0, v1;
    BRepTools::UVBounds(face, u0, u1, v0, v1);
    gp_Pnt p;
    gp_Vec n;
    BRepGProp_Face(face).Normal(0.5 * (u0 + u1), 0.5 * (v0 + v1), p, n);
    if (n.Magnitude() > gp::Resolution()) {
      n.Normalize();
      out[4] = 1; out[5] = n.X(); out[6] = n.Y(); out[7] = n.Z();
    }
  } catch (...) {
  }
  try {
    GProp_GProps props;
    BRepGProp::SurfaceProperties(face, props);
    out[8] = 1; out[9] = props.Mass();
  } catch (...) {
  }
  try {
    BRepAdaptor_Surface a(face);
    GeomAbs_SurfaceType st = a.GetType();
    out[10] = sa_surface_code(st);
    // build123d `Face.radius`: cylinders and spheres whose surface is the
    // elementary one itself, not a trimmed or offset wrapper.
    if (st == GeomAbs_Cylinder || st == GeomAbs_Sphere) {
      Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
      Handle(Geom_CylindricalSurface) cyl = Handle(Geom_CylindricalSurface)::DownCast(surf);
      Handle(Geom_SphericalSurface) sph = Handle(Geom_SphericalSurface)::DownCast(surf);
      if (!cyl.IsNull()) {
        out[11] = 1; out[12] = cyl->Radius();
      } else if (!sph.IsNull()) {
        out[11] = 1; out[12] = sph->Radius();
      }
    }
  } catch (...) {
  }
  return true;
}

// build123d `distance_to_with_closest_points(point)`: [distance, point on shape xyz].
inline bool sa_distance(const TopoDS_Shape &shape, double x, double y, double z,
                        rust::Slice<double> out) {
  if (out.size() < 4 || shape.IsNull()) return false;
  try {
    TopoDS_Shape v = BRepBuilderAPI_MakeVertex(gp_Pnt(x, y, z)).Vertex();
    BRepExtrema_DistShapeShape calc;
    calc.LoadS1(shape);
    calc.LoadS2(v);
    calc.Perform();
    if (!calc.IsDone() || calc.NbSolution() < 1) return false;
    gp_Pnt p = calc.PointOnShape1(1);
    out[0] = calc.Value(); out[1] = p.X(); out[2] = p.Y(); out[3] = p.Z();
    return true;
  } catch (...) {
    return false;
  }
}

// Distance to the face's untrimmed surface, infinity where no projection exists.
inline double sa_surface_distance(const TopoDS_Shape &shape, double x, double y, double z) {
  try {
    if (shape.IsNull() || shape.ShapeType() != TopAbs_FACE) return std::numeric_limits<double>::infinity();
    GeomAPI_ProjectPointOnSurf proj(gp_Pnt(x, y, z), BRep_Tool::Surface(TopoDS::Face(shape)));
    if (proj.NbPoints() < 1) return std::numeric_limits<double>::infinity();
    return proj.LowerDistance();
  } catch (...) {
    return std::numeric_limits<double>::infinity();
  }
}

// build123d `bounding_box()` diagonal (optimal, mesh ignored), 1.0 when empty.
inline double sa_bbox_diag(const TopoDS_Shape &shape) {
  try {
    if (shape.IsNull()) return 1.0;
    Bnd_Box box;
    BRepBndLib::AddOptimal(shape, box, false, false);
    if (box.IsVoid()) return 1.0;
    double x0, y0, z0, x1, y1, z1;
    box.Get(x0, y0, z0, x1, y1, z1);
    double d = std::sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) + (z1 - z0) * (z1 - z0));
    return d > 0.0 ? d : 1.0;
  } catch (...) {
    return 1.0;
  }
}
