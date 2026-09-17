// Sketch helpers: glyph outlines turned into faces, a cylinder's axis for a
// tangent plane, and a point on an edge by length fraction for text on a path.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>
#include <BRepAdaptor_Curve.hxx>
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
