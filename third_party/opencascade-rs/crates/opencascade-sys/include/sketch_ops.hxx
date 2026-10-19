// Sketch helpers: glyph outlines turned into faces, a cylinder's axis for a
// tangent plane, and a point on an edge by length fraction for text on a path.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepLib.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomAdaptor_Surface.hxx>
#include <Geom2dAPI_Interpolate.hxx>
#include <Geom2d_BezierCurve.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <Geom_Surface.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TColgp_HArray1OfPnt2d.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Cone.hxx>
#include <gp_Sphere.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Geom_BezierCurve.hxx>
#include <ShapeFix_Face.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax3.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <memory>
#include <stdexcept>

// loc xyz, dir xyz, radius; false when the face is not a cylinder.
inline bool sk_cylinder_axis(const TopoDS_Shape &shape, rust::Slice<double> out) {
  if (out.size() < 7) throw std::invalid_argument("out takes 7 values");
  BRepAdaptor_Surface ad(TopoDS::Face(shape));
  if (ad.GetType() != GeomAbs_Cylinder) return false;
  gp_Cylinder c = ad.Cylinder();
  gp_Pnt l = c.Axis().Location();
  gp_Dir d = c.Axis().Direction();
  out[0] = l.X(); out[1] = l.Y(); out[2] = l.Z();
  out[3] = d.X(); out[4] = d.Y(); out[5] = d.Z();
  out[6] = c.Radius();
  return true;
}

// build123d `position_at` and the first derivative at a length fraction,
// orientation respected: point xyz then derivative xyz.
inline void sk_edge_at(const TopoDS_Shape &shape, double fraction, rust::Slice<double> out) {
  if (out.size() < 6) throw std::invalid_argument("out takes 6 values");
  TopoDS_Edge edge = TopoDS::Edge(shape);
  BRepAdaptor_Curve curve(edge);
  bool forward = edge.Orientation() == TopAbs_FORWARD;
  double value = forward ? fraction : 1.0 - fraction;
  double length = GCPnts_AbscissaPoint::Length(curve);
  GCPnts_AbscissaPoint ap(curve, length * value, curve.FirstParameter());
  if (!ap.IsDone()) throw std::runtime_error("no point at that length");
  gp_Pnt p;
  gp_Vec d;
  curve.D1(ap.Parameter(), p, d);
  if (!forward) d.Reverse();
  out[0] = p.X(); out[1] = p.Y(); out[2] = p.Z();
  out[3] = d.X(); out[4] = d.Y(); out[5] = d.Z();
}

// One planar face at z=0 from contours. `data` is [wire count, then per wire:
// segment count, then per segment: degree (1 line, 2 quadratic, 3 cubic) and
// degree + 1 points as x, y]. The first wire bounds the face, the rest are holes.
inline std::unique_ptr<TopoDS_Shape> sk_glyph_face(rust::Slice<const double> data) {
  size_t i = 0;
  auto next = [&]() -> double {
    if (i >= data.size()) throw std::invalid_argument("glyph data ends early");
    return data[i++];
  };
  int wires = (int)next();
  if (wires < 1) throw std::invalid_argument("a glyph face needs a boundary");
  std::unique_ptr<BRepBuilderAPI_MakeFace> face;
  for (int w = 0; w < wires; ++w) {
    int segs = (int)next();
    BRepBuilderAPI_MakeWire mw;
    for (int s = 0; s < segs; ++s) {
      int degree = (int)next();
      if (degree < 1 || degree > 3) throw std::invalid_argument("bad segment degree");
      TColgp_Array1OfPnt poles(1, degree + 1);
      for (int k = 1; k <= degree + 1; ++k) {
        double x = next();
        double y = next();
        poles.SetValue(k, gp_Pnt(x, y, 0));
      }
      if (poles(1).Distance(poles(degree + 1)) < 1e-9) continue;
      TopoDS_Edge e;
      if (degree == 1) {
        BRepBuilderAPI_MakeEdge me(poles(1), poles(2));
        if (!me.IsDone()) continue;
        e = me.Edge();
      } else {
        Handle(Geom_BezierCurve) bz = new Geom_BezierCurve(poles);
        BRepBuilderAPI_MakeEdge me(bz);
        if (!me.IsDone()) continue;
        e = me.Edge();
      }
      mw.Add(e);
      if (!mw.IsDone()) throw std::runtime_error("glyph contour does not connect");
    }
    if (!mw.IsDone()) {
      if (w == 0) throw std::runtime_error("glyph boundary is empty");
      continue;
    }
    TopoDS_Wire wire = mw.Wire();
    if (w == 0) {
      face.reset(new BRepBuilderAPI_MakeFace(gp_Pln(gp_Ax3()), wire, true));
      if (!face->IsDone()) throw std::runtime_error("glyph face did not build");
    } else {
      face->Add(wire);
    }
  }
  ShapeFix_Face fix(face->Face());
  fix.FixOrientation();
  fix.Perform();
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(fix.Result()));
}

inline Handle(Geom_Surface) sk_untrimmed_surface(const TopoDS_Face &face) {
  Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
  Handle(Geom_RectangularTrimmedSurface) trimmed = Handle(Geom_RectangularTrimmedSurface)::DownCast(surf);
  return trimmed.IsNull() ? surf : trimmed->BasisSurface();
}

// The surface of a face at an anchor. `query` is [x, y, z, fu, fv, mode]: mode 0
// projects the point, 1 takes fu, fv as fractions of the face's (u, v) bounds.
// `out` takes 19 values: kind (1 plane, 2 cylinder, 3 cone, 4 sphere, 0 other),
// u, v, point xyz, dP/du xyz, dP/dv xyz, face orientation (1 forward, -1
// reversed), radius (the reference radius of a cone), cone half angle, umin,
// umax, vmin, vmax. False when the point does not project.
inline bool sk_surface_at(const TopoDS_Shape &shape, rust::Slice<const double> query, rust::Slice<double> out) {
  if (query.size() < 6) throw std::invalid_argument("query takes 6 values");
  if (out.size() < 19) throw std::invalid_argument("out takes 19 values");
  TopoDS_Face face = TopoDS::Face(shape);
  Handle(Geom_Surface) surf = sk_untrimmed_surface(face);
  double umin, umax, vmin, vmax;
  BRepTools::UVBounds(face, umin, umax, vmin, vmax);
  double u, v;
  if (query[5] == 1.0) {
    u = umin + query[3] * (umax - umin);
    v = vmin + query[4] * (vmax - vmin);
  } else {
    GeomAPI_ProjectPointOnSurf proj(gp_Pnt(query[0], query[1], query[2]), surf);
    if (proj.NbPoints() == 0) return false;
    proj.LowerDistanceParameters(u, v);
  }
  GeomAdaptor_Surface ad(surf);
  double kind = 0, radius = 0, angle = 0;
  switch (ad.GetType()) {
  case GeomAbs_Plane: kind = 1; break;
  case GeomAbs_Cylinder: kind = 2; radius = ad.Cylinder().Radius(); break;
  case GeomAbs_Cone: kind = 3; radius = ad.Cone().RefRadius(); angle = ad.Cone().SemiAngle(); break;
  case GeomAbs_Sphere: kind = 4; radius = ad.Sphere().Radius(); break;
  default: break;
  }
  gp_Pnt p;
  gp_Vec du, dv;
  surf->D1(u, v, p, du, dv);
  double vals[19] = {kind, u, v, p.X(), p.Y(), p.Z(), du.X(), du.Y(), du.Z(), dv.X(), dv.Y(), dv.Z(),
                     face.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0, radius, angle, umin, umax, vmin, vmax};
  for (int k = 0; k < 19; ++k) out[k] = vals[k];
  return true;
}

// One glyph on a face's surface, `data` laid out as for sk_glyph_face but in
// the surface's (u, v), plus degree 0: a point count, then that many (u, v)
// points to interpolate. `depth` thickens along the surface normal (negative
// against it), 0 gives the face itself.
inline std::unique_ptr<TopoDS_Shape> sk_glyph_on_face(const TopoDS_Shape &shape, rust::Slice<const double> data,
                                                     double depth) {
  Handle(Geom_Surface) surf = sk_untrimmed_surface(TopoDS::Face(shape));
  size_t i = 0;
  auto next = [&]() -> double {
    if (i >= data.size()) throw std::invalid_argument("glyph data ends early");
    return data[i++];
  };
  int wires = (int)next();
  if (wires < 1) throw std::invalid_argument("a glyph face needs a boundary");
  std::unique_ptr<BRepBuilderAPI_MakeFace> face;
  for (int w = 0; w < wires; ++w) {
    int segs = (int)next();
    BRepBuilderAPI_MakeWire mw;
    for (int s = 0; s < segs; ++s) {
      int degree = (int)next();
      Handle(Geom2d_Curve) c2d;
      if (degree == 0) {
        int n = (int)next();
        if (n < 2) throw std::invalid_argument("an interpolated segment needs two points");
        Handle(TColgp_HArray1OfPnt2d) pts = new TColgp_HArray1OfPnt2d(1, n);
        for (int k = 1; k <= n; ++k) {
          double a = next();
          double b = next();
          pts->SetValue(k, gp_Pnt2d(a, b));
        }
        if (pts->Value(1).Distance(pts->Value(n)) < 1e-12) continue;
        Geom2dAPI_Interpolate it(pts, false, 1e-12);
        it.Perform();
        if (!it.IsDone()) continue;
        c2d = it.Curve();
      } else {
        if (degree > 3) throw std::invalid_argument("bad segment degree");
        TColgp_Array1OfPnt2d poles(1, degree + 1);
        for (int k = 1; k <= degree + 1; ++k) {
          double a = next();
          double b = next();
          poles.SetValue(k, gp_Pnt2d(a, b));
        }
        if (poles(1).Distance(poles(degree + 1)) < 1e-12) continue;
        c2d = new Geom2d_BezierCurve(poles);
      }
      BRepBuilderAPI_MakeEdge me(c2d, surf);
      if (!me.IsDone()) continue;
      TopoDS_Edge e = me.Edge();
      BRepLib::BuildCurves3d(e, 1e-7);
      mw.Add(e);
      if (!mw.IsDone()) throw std::runtime_error("glyph contour does not connect");
    }
    if (!mw.IsDone()) {
      if (w == 0) throw std::runtime_error("glyph boundary is empty");
      continue;
    }
    if (w == 0) {
      face.reset(new BRepBuilderAPI_MakeFace(surf, mw.Wire(), true));
      if (!face->IsDone()) throw std::runtime_error("glyph face did not build");
    } else {
      face->Add(mw.Wire());
    }
  }
  ShapeFix_Face fix(face->Face());
  fix.FixOrientation();
  fix.Perform();
  TopoDS_Shape glyph = fix.Result();
  if (depth == 0.0) return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(glyph));
  BRepOffsetAPI_MakeThickSolid thick;
  thick.MakeThickSolidBySimple(glyph, depth);
  if (!thick.IsDone()) throw std::runtime_error("glyph did not thicken");
  TopExp_Explorer ex(thick.Shape(), TopAbs_SOLID);
  if (!ex.More()) throw std::runtime_error("glyph thickened to no solid");
  TopoDS_Solid solid = TopoDS::Solid(ex.Current());
  // Note: thickening along the normal comes back inside out, a fuse of it adds the whole body.
  BRepLib::OrientClosedSolid(solid);
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(solid));
}
