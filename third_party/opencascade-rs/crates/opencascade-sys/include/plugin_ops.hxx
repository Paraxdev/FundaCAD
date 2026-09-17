// The generic kernel a plugin component reaches through the engine's host API
// (fundacad-geom::plugins, crates/fundacad-geom/wit/plugin.wit). Each call
// mirrors the OCP call the Python plugin geometry makes, so a ported plugin
// meets the same OpenCASCADE operations. Nothing throws: a failure is a null
// shape, a false or a negative code.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>
#include "select_access.hxx"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomLib_IsPlanarSurface.hxx>
#include <Geom_Surface.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Circ.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Dir.hxx>
#include <gp_Lin.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <cmath>
#include <memory>
#include <vector>

using PoShape = std::unique_ptr<TopoDS_Shape>;
using PoShapes = std::unique_ptr<std::vector<TopoDS_Shape>>;

inline PoShape po_own(const TopoDS_Shape &s) { return PoShape(new TopoDS_Shape(s)); }
inline PoShape po_null() { return PoShape(new TopoDS_Shape()); }

// Unique sub-shapes in explorer order, the orientation of the last occurrence,
// as build123d's `solids()` and `wires()`. kind: 0 solid, 1 wire.
inline PoShapes po_items(const TopoDS_Shape &s, int kind) {
  PoShapes out(new std::vector<TopoDS_Shape>());
  if (s.IsNull()) return out;
  try {
    TopTools_IndexedMapOfShape seen;
    for (TopExp_Explorer ex(s, kind == 0 ? TopAbs_SOLID : TopAbs_WIRE); ex.More(); ex.Next()) {
      const TopoDS_Shape &c = ex.Current();
      int i = seen.FindIndex(c);
      if (i == 0) {
        seen.Add(c);
        out->push_back(c);
      } else {
        (*out)[i - 1] = c;
      }
    }
  } catch (...) {
    out->clear();
  }
  return out;
}

inline PoShape po_outer_wire(const TopoDS_Shape &face) {
  try {
    if (face.IsNull() || face.ShapeType() != TopAbs_FACE) return po_null();
    return po_own(BRepTools::OuterWire(TopoDS::Face(face)));
  } catch (...) {
    return po_null();
  }
}

// 0 plane [origin, outward normal], 1 cylinder [origin, axis, radius],
// 10 + GeomAbs_SurfaceType otherwise, -1 not a face.
inline int po_surface(const TopoDS_Shape &face, rust::Slice<double> out) {
  if (face.IsNull() || face.ShapeType() != TopAbs_FACE || out.size() < 7) return -1;
  try {
    BRepAdaptor_Surface s(TopoDS::Face(face));
    GeomAbs_SurfaceType t = s.GetType();
    if (t == GeomAbs_Plane) {
      gp_Pln p = s.Plane();
      gp_Dir n = p.Axis().Direction();
      double sign = face.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
      gp_Pnt o = p.Location();
      out[0] = o.X(); out[1] = o.Y(); out[2] = o.Z();
      out[3] = sign * n.X(); out[4] = sign * n.Y(); out[5] = sign * n.Z();
      return 0;
    }
    if (t == GeomAbs_Cylinder) {
      gp_Cylinder c = s.Cylinder();
      gp_Pnt o = c.Axis().Location();
      gp_Dir a = c.Axis().Direction();
      out[0] = o.X(); out[1] = o.Y(); out[2] = o.Z();
      out[3] = a.X(); out[4] = a.Y(); out[5] = a.Z();
      out[6] = c.Radius();
      return 1;
    }
    return 10 + static_cast<int>(t);
  } catch (...) {
    return -1;
  }
}

// 0 line [origin, direction], 1 circle [center, axis, radius],
// 10 + GeomAbs_CurveType otherwise, -1 not an edge.
inline int po_curve(const TopoDS_Shape &edge, rust::Slice<double> out) {
  if (edge.IsNull() || edge.ShapeType() != TopAbs_EDGE || out.size() < 7) return -1;
  try {
    BRepAdaptor_Curve c(TopoDS::Edge(edge));
    GeomAbs_CurveType t = c.GetType();
    if (t == GeomAbs_Line) {
      gp_Lin l = c.Line();
      out[0] = l.Location().X(); out[1] = l.Location().Y(); out[2] = l.Location().Z();
      out[3] = l.Direction().X(); out[4] = l.Direction().Y(); out[5] = l.Direction().Z();
      return 0;
    }
    if (t == GeomAbs_Circle) {
      gp_Circ k = c.Circle();
      gp_Pnt o = k.Location();
      gp_Dir a = k.Axis().Direction();
      out[0] = o.X(); out[1] = o.Y(); out[2] = o.Z();
      out[3] = a.X(); out[4] = a.Y(); out[5] = a.Z();
      out[6] = k.Radius();
      return 1;
    }
    return 10 + static_cast<int>(t);
  } catch (...) {
    return -1;
  }
}

// Every edge in explorer order, repeats kept, at segments + 1 raw parameters.
inline rust::Vec<double> po_sample_edges(const TopoDS_Shape &s, int segments) {
  rust::Vec<double> out;
  if (s.IsNull() || segments < 1) return out;
  try {
    for (TopExp_Explorer ex(s, TopAbs_EDGE); ex.More(); ex.Next()) {
      BRepAdaptor_Curve c(TopoDS::Edge(ex.Current()));
      double a = c.FirstParameter(), b = c.LastParameter();
      if (!std::isfinite(a) || !std::isfinite(b)) continue;
      for (int i = 0; i <= segments; ++i) {
        gp_Pnt p = c.Value(a + (b - a) * i / segments);
        out.push_back(p.X());
        out.push_back(p.Y());
        out.push_back(p.Z());
      }
    }
  } catch (...) {
    out.clear();
  }
  return out;
}

// build123d `Edge.position_at(position)`.
inline bool po_point_at(const TopoDS_Shape &edge, double position, rust::Slice<double> out) {
  if (edge.IsNull() || edge.ShapeType() != TopAbs_EDGE || out.size() < 3) return false;
  try {
    const TopoDS_Edge &e = TopoDS::Edge(edge);
    BRepAdaptor_Curve c(e);
    gp_Pnt p = c.Value(sa_param_at(c, e, position));
    out[0] = p.X(); out[1] = p.Y(); out[2] = p.Z();
    return true;
  } catch (...) {
    return false;
  }
}

// build123d `Face.center()`: a planar face's area centroid, a curved face's
// point at the middle of its UV bounds; other shapes their centre of mass.
inline bool po_center(const TopoDS_Shape &s, rust::Slice<double> out) {
  if (s.IsNull() || out.size() < 3) return false;
  try {
    gp_Pnt c;
    TopAbs_ShapeEnum t = s.ShapeType();
    if (t == TopAbs_FACE) {
      const TopoDS_Face &f = TopoDS::Face(s);
      Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
      if (!surf.IsNull() && GeomLib_IsPlanarSurface(surf, 1e-6).IsPlanar()) {
        GProp_GProps p;
        BRepGProp::SurfaceProperties(f, p);
        c = p.CentreOfMass();
      } else {
        double u0, u1, v0, v1;
        BRepTools::UVBounds(f, u0, u1, v0, v1);
        BRepAdaptor_Surface a(f);
        c = a.Value(0.5 * (u0 + u1), 0.5 * (v0 + v1));
      }
    } else {
      GProp_GProps p;
      if (t == TopAbs_EDGE || t == TopAbs_WIRE)
        BRepGProp::LinearProperties(s, p);
      else if (t == TopAbs_SHELL)
        BRepGProp::SurfaceProperties(s, p);
      else
        BRepGProp::VolumeProperties(s, p);
      c = p.CentreOfMass();
    }
    out[0] = c.X(); out[1] = c.Y(); out[2] = c.Z();
    return true;
  } catch (...) {
    return false;
  }
}

// build123d `Face.normal_at(point)`.
inline bool po_normal_at(const TopoDS_Shape &face, double x, double y, double z,
                         rust::Slice<double> out) {
  if (face.IsNull() || face.ShapeType() != TopAbs_FACE || out.size() < 3) return false;
  try {
    const TopoDS_Face &f = TopoDS::Face(face);
    GeomAPI_ProjectPointOnSurf proj(gp_Pnt(x, y, z), BRep_Tool::Surface(f));
    double u, v;
    proj.LowerDistanceParameters(u, v);
    gp_Pnt p;
    gp_Vec n;
    BRepGProp_Face(f).Normal(u, v, p, n);
    if (n.Magnitude() <= 1e-300) return false;
    n.Normalize();
    out[0] = n.X(); out[1] = n.Y(); out[2] = n.Z();
    return true;
  } catch (...) {
    return false;
  }
}

// ptb_occ.py `inside`: 0 in, 1 on, 2 out, over the solids in explorer order.
inline int po_classify(const TopoDS_Shape &s, double x, double y, double z, double tol) {
  if (s.IsNull()) return 2;
  try {
    for (TopExp_Explorer ex(s, TopAbs_SOLID); ex.More(); ex.Next()) {
      BRepClass3d_SolidClassifier c(ex.Current(), gp_Pnt(x, y, z), tol);
      TopAbs_State st = c.State();
      if (st == TopAbs_IN) return 0;
      if (st == TopAbs_ON) return 1;
    }
  } catch (...) {
  }
  return 2;
}

inline PoShapes po_faces_of_edge(const TopoDS_Shape &s, const TopoDS_Shape &edge) {
  PoShapes out(new std::vector<TopoDS_Shape>());
  try {
    TopTools_IndexedDataMapOfShapeListOfShape m;
    TopExp::MapShapesAndAncestors(s, TopAbs_EDGE, TopAbs_FACE, m);
    int idx = m.FindIndex(edge);
    if (idx == 0) return out;
    for (TopTools_ListOfShape::Iterator it(m.FindFromIndex(idx)); it.More(); it.Next()) {
      bool dup = false;
      for (const TopoDS_Shape &g : *out) dup = dup || g.IsSame(it.Value());
      if (!dup) out->push_back(it.Value());
    }
  } catch (...) {
    out->clear();
  }
  return out;
}

inline bool po_is_valid(const TopoDS_Shape &s) {
  try {
    return !s.IsNull() && BRepCheck_Analyzer(s).IsValid();
  } catch (...) {
    return false;
  }
}

inline PoShape po_box(double x, double y, double z, double dx, double dy, double dz) {
  try {
    return po_own(BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape());
  } catch (...) {
    return po_null();
  }
}

inline PoShape po_cylinder(double bx, double by, double bz, double ax, double ay, double az,
                           double r, double h) {
  try {
    gp_Ax2 axis(gp_Pnt(bx, by, bz), gp_Dir(ax, ay, az));
    return po_own(BRepPrimAPI_MakeCylinder(axis, r, h).Shape());
  } catch (...) {
    return po_null();
  }
}

inline PoShape po_cone(double bx, double by, double bz, double ax, double ay, double az,
                       double r1, double r2, double h) {
  try {
    gp_Ax2 axis(gp_Pnt(bx, by, bz), gp_Dir(ax, ay, az));
    return po_own(BRepPrimAPI_MakeCone(axis, r1, r2, h).Shape());
  } catch (...) {
    return po_null();
  }
}

inline PoShape po_sphere(double cx, double cy, double cz, double r) {
  try {
    return po_own(BRepPrimAPI_MakeSphere(gp_Pnt(cx, cy, cz), r).Shape());
  } catch (...) {
    return po_null();
  }
}

// ptb_occ.py `prism`'s profile: BRepBuilderAPI_MakePolygon closed, then a
// face that must be planar.
inline PoShape po_polygon_face(rust::Slice<const double> pts) {
  try {
    BRepBuilderAPI_MakePolygon poly;
    for (size_t i = 0; i + 2 < pts.size(); i += 3) poly.Add(gp_Pnt(pts[i], pts[i + 1], pts[i + 2]));
    poly.Close();
    BRepBuilderAPI_MakeFace mk(poly.Wire(), true);
    if (!mk.IsDone()) return po_null();
    return po_own(mk.Face());
  } catch (...) {
    return po_null();
  }
}

inline PoShape po_face_from_wire(const TopoDS_Shape &wire) {
  try {
    if (wire.IsNull() || wire.ShapeType() != TopAbs_WIRE) return po_null();
    BRepBuilderAPI_MakeFace mk(TopoDS::Wire(wire), true);
    if (!mk.IsDone()) return po_null();
    return po_own(mk.Face());
  } catch (...) {
    return po_null();
  }
}

inline PoShape po_prism(const TopoDS_Shape &profile, double dx, double dy, double dz) {
  try {
    BRepPrimAPI_MakePrism mk(profile, gp_Vec(dx, dy, dz));
    mk.Build();
    if (!mk.IsDone()) return po_null();
    return po_own(mk.Shape());
  } catch (...) {
    return po_null();
  }
}

inline PoShape po_revolve(const TopoDS_Shape &profile, double ox, double oy, double oz, double ax,
                          double ay, double az, double degrees) {
  try {
    gp_Ax1 axis(gp_Pnt(ox, oy, oz), gp_Dir(ax, ay, az));
    BRepPrimAPI_MakeRevol mk(profile, axis, degrees * M_PI / 180.0);
    mk.Build();
    if (!mk.IsDone()) return po_null();
    return po_own(mk.Shape());
  } catch (...) {
    return po_null();
  }
}

// ptb_occ.py `_run_bool` (kind 0 fuse, 1 cut) and `common` (kind 2, the two
// argument constructor). status: 0 done, 1 not done, 2 invalid.
inline PoShape po_boolean(int kind, const TopoDS_Shape &base, const TopoDS_Shape &tools,
                          int32_t &status) {
  status = 1;
  try {
    TopoDS_Shape out;
    if (kind == 2) {
      TopoDS_Iterator it(tools);
      if (!it.More()) return po_null();
      BRepAlgoAPI_Common op(base, it.Value());
      op.Build();
      if (!op.IsDone()) return po_null();
      out = op.Shape();
    } else {
      TopTools_ListOfShape args, tl;
      args.Append(base);
      for (TopoDS_Iterator it(tools); it.More(); it.Next()) tl.Append(it.Value());
      std::unique_ptr<BRepAlgoAPI_BooleanOperation> op;
      if (kind == 0)
        op.reset(new BRepAlgoAPI_Fuse());
      else
        op.reset(new BRepAlgoAPI_Cut());
      op->SetArguments(args);
      op->SetTools(tl);
      op->SetRunParallel(true);
      op->Build();
      if (!op->IsDone()) return po_null();
      out = op->Shape();
    }
    status = (out.IsNull() || !BRepCheck_Analyzer(out).IsValid()) ? 2 : 0;
    return po_own(out);
  } catch (...) {
    status = 1;
    return po_null();
  }
}

// ptb_occ.py `simplify`.
inline PoShape po_unify(const TopoDS_Shape &s) {
  try {
    ShapeUpgrade_UnifySameDomain up(s, true, true, true);
    up.Build();
    TopoDS_Shape out = up.Shape();
    if (!out.IsNull() && BRepCheck_Analyzer(out).IsValid()) return po_own(out);
  } catch (...) {
  }
  return po_own(s);
}

inline PoShape po_translate(const TopoDS_Shape &s, double dx, double dy, double dz) {
  try {
    gp_Trsf t;
    t.SetTranslation(gp_Vec(dx, dy, dz));
    return po_own(s.Moved(TopLoc_Location(t)));
  } catch (...) {
    return po_null();
  }
}

// shape_generate.py `place`.
inline PoShape po_place(const TopoDS_Shape &s, double ox, double oy, double oz, double zx,
                        double zy, double zz) {
  try {
    gp_Trsf t;
    t.SetTransformation(gp_Ax3(gp_Pnt(ox, oy, oz), gp_Dir(zx, zy, zz)), gp_Ax3());
    return po_own(s.Moved(TopLoc_Location(t)));
  } catch (...) {
    return po_null();
  }
}
