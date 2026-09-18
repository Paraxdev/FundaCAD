// Whole operations the FundaCAD timeline builder needs, each one call from Rust.
// They mirror what build123d does for sidecar/builder.py and its helpers, so the
// same document meets the same OpenCASCADE calls in both engines.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>

#include <BOPAlgo_Splitter.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_BooleanOperation.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_GTransform.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepLib_FindSurface.hxx>
#include <BRepOffsetAPI_MakeOffset.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeTorus.hxx>
#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCE2d_MakeSegment.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomLib_IsPlanarSurface.hxx>
#include <Geom_Surface.hxx>
#include <LocOpe_DPrism.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <Standard_Failure.hxx>
#include <TColgp_HArray1OfPnt.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Circ.hxx>
#include <gp_Elips.hxx>
#include <gp_GTrsf.hxx>
#include <gp_Pln.hxx>
#include <gp_Quaternion.hxx>
#include <gp_Trsf.hxx>

#include <algorithm>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using BoShape = std::unique_ptr<TopoDS_Shape>;
using BoShapes = std::unique_ptr<std::vector<TopoDS_Shape>>;

// An OpenCASCADE failure reaches Rust as an error named after the exception
// class, the name the Python engine reports as "<feature> failed (<class>)".
#define BO_GUARD(body)                                                         \
  try {                                                                        \
    body                                                                       \
  } catch (Standard_Failure & e) {                                             \
    throw std::runtime_error(e.DynamicType()->Name());                         \
  } catch (std::exception &) {                                                 \
    throw;                                                                     \
  } catch (...) {                                                              \
    throw std::runtime_error("Standard_Failure");                              \
  }

inline BoShape bo_own(const TopoDS_Shape &s) { return BoShape(new TopoDS_Shape(s)); }

inline BoShape bo_null() { return BoShape(new TopoDS_Shape()); }

inline bool bo_is_null(const TopoDS_Shape &s) { return s.IsNull(); }

inline int bo_shape_type(const TopoDS_Shape &s) {
  return s.IsNull() ? -1 : static_cast<int>(s.ShapeType());
}

inline bool bo_is_same(const TopoDS_Shape &a, const TopoDS_Shape &b) {
  return a.IsSame(b) && a.Location().IsEqual(b.Location()) &&
         a.Orientation() == b.Orientation();
}

inline BoShape bo_compound_new() {
  TopoDS_Compound c;
  BRep_Builder b;
  b.MakeCompound(c);
  return bo_own(c);
}

inline void bo_compound_add(TopoDS_Shape &compound, const TopoDS_Shape &s) {
  if (s.IsNull()) return;
  BRep_Builder b;
  b.Add(compound, s);
}

inline BoShapes bo_children(const TopoDS_Shape &s) {
  BoShapes out(new std::vector<TopoDS_Shape>());
  if (s.IsNull()) return out;
  for (TopoDS_Iterator it(s); it.More(); it.Next()) out->push_back(it.Value());
  return out;
}

// 0 solid, 1 shell, 2 face, 3 wire, 4 edge, 5 vertex; each distinct once, in
// exploration order, which is the order build123d's `.faces()` and friends use.
inline TopAbs_ShapeEnum bo_kind(int kind) {
  switch (kind) {
  case 0: return TopAbs_SOLID;
  case 1: return TopAbs_SHELL;
  case 2: return TopAbs_FACE;
  case 3: return TopAbs_WIRE;
  case 4: return TopAbs_EDGE;
  default: return TopAbs_VERTEX;
  }
}

inline BoShapes bo_subshapes(const TopoDS_Shape &s, int kind) {
  BoShapes out(new std::vector<TopoDS_Shape>());
  if (s.IsNull()) return out;
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(s, bo_kind(kind), map);
  for (int i = 1; i <= map.Extent(); ++i) out->push_back(map.FindKey(i));
  return out;
}

inline int bo_count(const TopoDS_Shape &s, int kind) {
  if (s.IsNull()) return 0;
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes(s, bo_kind(kind), map);
  return map.Extent();
}

inline BoShape bo_copy(const TopoDS_Shape &s) {
  BO_GUARD(BRepBuilderAPI_Copy c(s); return bo_own(c.Shape());)
}

// --- measurement ------------------------------------------------------------

inline double bo_volume(const TopoDS_Shape &s) {
  if (s.IsNull()) return 0.0;
  GProp_GProps p;
  BRepGProp::VolumeProperties(s, p);
  return p.Mass();
}

inline double bo_area(const TopoDS_Shape &s) {
  if (s.IsNull()) return 0.0;
  GProp_GProps p;
  BRepGProp::SurfaceProperties(s, p);
  return p.Mass();
}

// build123d's `bounding_box()`: AddOptimal with triangulation, no shape tolerance.
inline bool bo_bbox(const TopoDS_Shape &s, bool optimal, rust::Slice<double> out) {
  if (s.IsNull() || out.size() < 6) return false;
  Bnd_Box box;
  try {
    if (optimal)
      BRepBndLib::AddOptimal(s, box, true, false);
    else
      BRepBndLib::Add(s, box, true);
  } catch (...) {
    return false;
  }
  if (box.IsVoid()) return false;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  out[0] = x0; out[1] = y0; out[2] = z0; out[3] = x1; out[4] = y1; out[5] = z1;
  return true;
}

// The largest |coordinate| of a control point box, what pick_fuzz scales by.
inline double bo_extent(const TopoDS_Shape &s) {
  if (s.IsNull()) return -1.0;
  Bnd_Box box;
  try {
    BRepBndLib::Add(s, box);
  } catch (...) {
    return -1.0;
  }
  if (box.IsVoid()) return -1.0;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  double m = 0.0;
  for (double v : {x0, y0, z0, x1, y1, z1}) m = std::max(m, std::abs(v));
  return m;
}

// (area, centre) of a face in its own frame, then the location applied, as
// defeature.py `_face_fp` computes it before rounding.
inline bool bo_face_fp(const TopoDS_Shape &shape, rust::Slice<double> out) {
  try {
    if (shape.IsNull() || shape.ShapeType() != TopAbs_FACE || out.size() < 4) return false;
    TopLoc_Location loc = shape.Location();
    TopoDS_Face face = TopoDS::Face(shape.Located(TopLoc_Location()));
    GProp_GProps props;
    BRepGProp::SurfaceProperties(face, props);
    gp_Pnt c;
    Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
    if (!surf.IsNull() && GeomLib_IsPlanarSurface(surf, 1e-6).IsPlanar()) {
      c = props.CentreOfMass();
    } else {
      double u0, u1, v0, v1;
      BRepTools::UVBounds(face, u0, u1, v0, v1);
      gp_Vec n;
      BRepGProp_Face(face).Normal(0.5 * (u0 + u1), 0.5 * (v0 + v1), c, n);
    }
    if (!loc.IsIdentity()) c.Transform(loc.Transformation());
    out[0] = props.Mass(); out[1] = c.X(); out[2] = c.Y(); out[3] = c.Z();
    return true;
  } catch (...) {
    return false;
  }
}

inline bool bo_center_of_mass(const TopoDS_Shape &s, rust::Slice<double> out) {
  try {
    GProp_GProps p;
    BRepGProp::VolumeProperties(s, p);
    gp_Pnt c = p.CentreOfMass();
    out[0] = c.X(); out[1] = c.Y(); out[2] = c.Z();
    return true;
  } catch (...) {
    return false;
  }
}

inline void bo_transform_point(const TopoDS_Shape &shape, rust::Slice<double> xyz) {
  gp_Pnt p(xyz[0], xyz[1], xyz[2]);
  p.Transform(shape.Location().Transformation());
  xyz[0] = p.X(); xyz[1] = p.Y(); xyz[2] = p.Z();
}

// Solids beyond one shell per solid: a cavity sealed inside a body.
inline int bo_void_count(const TopoDS_Shape &s) {
  return bo_count(s, 1) - bo_count(s, 0);
}

inline void bo_location_translation(const TopoDS_Shape &s, rust::Slice<double> out) {
  gp_XYZ t = s.Location().Transformation().TranslationPart();
  out[0] = t.X(); out[1] = t.Y(); out[2] = t.Z();
}

// --- transforms -------------------------------------------------------------

inline gp_Trsf bo_euler(double rx, double ry, double rz) {
  gp_Quaternion q;
  q.SetEulerAngles(gp_Intrinsic_XYZ, rx * M_PI / 180.0, ry * M_PI / 180.0, rz * M_PI / 180.0);
  gp_Trsf t;
  t.SetRotation(q);
  return t;
}

// `(Pos(d) * Rot(r))` applied to a point.
inline void bo_euler_point(double rx, double ry, double rz, double dx, double dy, double dz,
                           rust::Slice<double> xyz) {
  gp_Trsf t;
  t.SetTranslation(gp_Vec(dx, dy, dz));
  t.Multiply(bo_euler(rx, ry, rz));
  gp_Pnt p(xyz[0], xyz[1], xyz[2]);
  p.Transform(t);
  xyz[0] = p.X(); xyz[1] = p.Y(); xyz[2] = p.Z();
}

// build123d `Rot(rx, ry, rz) * shape`: intrinsic XYZ degrees, as a location.
inline BoShape bo_rotated(const TopoDS_Shape &s, double rx, double ry, double rz) {
  BO_GUARD(return bo_own(s.Moved(TopLoc_Location(bo_euler(rx, ry, rz))));)
}

inline BoShape bo_translated(const TopoDS_Shape &s, double dx, double dy, double dz) {
  BO_GUARD(gp_Trsf t; t.SetTranslation(gp_Vec(dx, dy, dz));
           return bo_own(s.Moved(TopLoc_Location(t)));)
}

// The location a plane spec places sketch-local (x, y, 0) at.
inline gp_Trsf bo_plane_trsf(double ox, double oy, double oz, double xx, double xy, double xz,
                             double nx, double ny, double nz) {
  gp_Ax3 ax(gp_Pnt(ox, oy, oz), gp_Dir(nx, ny, nz), gp_Dir(xx, xy, xz));
  gp_Trsf t;
  t.SetTransformation(ax);
  return t.Inverted();
}

inline BoShape bo_on_plane(const TopoDS_Shape &s, double ox, double oy, double oz, double xx,
                           double xy, double xz, double nx, double ny, double nz) {
  BO_GUARD(return bo_own(s.Moved(TopLoc_Location(bo_plane_trsf(ox, oy, oz, xx, xy, xz, nx, ny, nz))));)
}

// The plane's own frame as gp_Ax3 derives it: [ox oy oz xx xy xz yx yy yz nx ny nz].
inline void bo_plane_frame(double ox, double oy, double oz, double xx, double xy, double xz,
                           double nx, double ny, double nz, rust::Slice<double> out) {
  gp_Ax3 ax(gp_Pnt(ox, oy, oz), gp_Dir(nx, ny, nz), gp_Dir(xx, xy, xz));
  const gp_Dir &x = ax.XDirection();
  const gp_Dir &y = ax.YDirection();
  const gp_Dir &z = ax.Direction();
  double v[12] = {ox, oy, oz, x.X(), x.Y(), x.Z(), y.X(), y.Y(), y.Z(), z.X(), z.Y(), z.Z()};
  for (int i = 0; i < 12; ++i) out[i] = v[i];
}

inline BoShape bo_scaled(const TopoDS_Shape &s, double fx, double fy, double fz, double ax,
                         double ay, double az, bool uniform) {
  BO_GUARD(
      if (uniform) {
        gp_Trsf t;
        t.SetScale(gp_Pnt(ax, ay, az), fx);
        BRepBuilderAPI_Transform tr(s, t, true);
        TopoDS_Shape out = tr.Shape();
        BRepTools::Clean(out);
        return bo_own(out);
      }
      gp_GTrsf g;
      g.SetValue(1, 1, fx); g.SetValue(2, 2, fy); g.SetValue(3, 3, fz);
      g.SetValue(1, 4, ax * (1 - fx)); g.SetValue(2, 4, ay * (1 - fy)); g.SetValue(3, 4, az * (1 - fz));
      BRepBuilderAPI_GTransform tr(s, g, true);
      TopoDS_Shape out = tr.Shape();
      BRepTools::Clean(out);
      return bo_own(out);)
}

inline BoShape bo_mirrored(const TopoDS_Shape &s, double ox, double oy, double oz, double nx,
                           double ny, double nz) {
  BO_GUARD(gp_Trsf t; t.SetMirror(gp_Ax2(gp_Pnt(ox, oy, oz), gp_Dir(nx, ny, nz)));
           BRepBuilderAPI_Copy copy(s);
           BRepBuilderAPI_Transform tr(copy.Shape(), t, true);
           return bo_own(tr.Shape());)
}

// --- primitives, centred on the origin as build123d aligns them -------------

inline BoShape bo_centred(const TopoDS_Shape &solid) {
  Bnd_Box box;
  BRepBndLib::AddOptimal(solid, box, true, false);
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  gp_Trsf t;
  t.SetTranslation(gp_Vec(-(x0 + x1) / 2, -(y0 + y1) / 2, -(z0 + z1) / 2));
  TopoDS_Shape moved = solid.Moved(TopLoc_Location(t));
  BoShape c = bo_compound_new();
  bo_compound_add(*c, moved);
  return c;
}

inline BoShape bo_box(double l, double w, double h) {
  BO_GUARD(BRepPrimAPI_MakeBox mk(l, w, h); return bo_centred(mk.Shape());)
}

inline BoShape bo_cylinder(double r, double h) {
  BO_GUARD(BRepPrimAPI_MakeCylinder mk(gp_Ax2(), r, h, 2 * M_PI); return bo_centred(mk.Shape());)
}

inline BoShape bo_sphere(double r) {
  BO_GUARD(BRepPrimAPI_MakeSphere mk(gp_Ax2(), r, -M_PI / 2, M_PI / 2, 2 * M_PI);
           return bo_centred(mk.Shape());)
}

inline BoShape bo_cone(double r1, double r2, double h) {
  BO_GUARD(BRepPrimAPI_MakeCone mk(gp_Ax2(), r1, r2, h, 2 * M_PI); return bo_centred(mk.Shape());)
}

inline BoShape bo_torus(double big, double small) {
  BO_GUARD(BRepPrimAPI_MakeTorus mk(gp_Ax2(), big, small, 0, 2 * M_PI, 2 * M_PI);
           return bo_centred(mk.Shape());)
}

// --- booleans ---------------------------------------------------------------

inline TopoDS_Shape bo_unwrap(const TopoDS_Shape &s) {
  TopoDS_Shape cur = s;
  while (!cur.IsNull() && cur.ShapeType() == TopAbs_COMPOUND) {
    TopoDS_Iterator it(cur);
    if (!it.More()) break;
    TopoDS_Shape only = it.Value();
    it.Next();
    if (it.More()) break;
    cur = only;
  }
  return cur;
}

inline TopoDS_Shape bo_unify(const TopoDS_Shape &s) {
  ShapeUpgrade_UnifySameDomain up(s, true, true, true);
  up.AllowInternalEdges(false);
  try {
    up.Build();
    return up.Shape();
  } catch (...) {
    return s;
  }
}

// kind 0 fuse, 1 cut, 2 common. `tools` is a compound whose children are the
// tool list. `parallel` true with no fuzz is build123d's operator; false with a
// fuzz is booleans.py `_serial_bool`.
inline BoShape bo_boolean(const TopoDS_Shape &base, const TopoDS_Shape &tools, int kind,
                          bool parallel, double fuzzy, bool unwrap) {
  BO_GUARD(
      TopTools_ListOfShape args;
      args.Append(base);
      TopTools_ListOfShape tl;
      for (TopoDS_Iterator it(tools); it.More(); it.Next()) tl.Append(it.Value());
      std::unique_ptr<BRepAlgoAPI_BooleanOperation> op;
      if (kind == 0) op.reset(new BRepAlgoAPI_Fuse());
      else if (kind == 1) op.reset(new BRepAlgoAPI_Cut());
      else op.reset(new BRepAlgoAPI_Common());
      op->SetArguments(args);
      op->SetTools(tl);
      op->SetRunParallel(parallel);
      if (fuzzy > 0) op->SetFuzzyValue(fuzzy);
      op->Build();
      if (!op->IsDone()) throw std::runtime_error("StdFail_NotDone");
      TopoDS_Shape out = bo_unify(op->Shape());
      if (unwrap) out = bo_unwrap(out);
      return bo_own(out);)
}

inline BoShape bo_clean(const TopoDS_Shape &s) { BO_GUARD(return bo_own(bo_unify(s));) }

inline BoShape bo_unwrap_compound(const TopoDS_Shape &s) { return bo_own(bo_unwrap(s)); }

// shape_util.py `_drop_debris`: a solid under 0.1% of the largest one that
// does not touch it is boolean residue.
inline BoShape bo_drop_debris(const TopoDS_Shape &shape) {
  try {
    TopTools_IndexedMapOfShape map;
    TopExp::MapShapes(shape, TopAbs_SOLID, map);
    if (map.Extent() < 2) return bo_own(shape);
    std::vector<std::pair<double, TopoDS_Shape>> parts;
    for (int i = 1; i <= map.Extent(); ++i)
      parts.push_back({std::abs(bo_volume(map.FindKey(i))), map.FindKey(i)});
    std::stable_sort(parts.begin(), parts.end(),
                     [](const auto &a, const auto &b) { return a.first > b.first; });
    const TopoDS_Shape &main = parts[0].second;
    double mainVol = parts[0].first;
    std::vector<TopoDS_Shape> kept{main};
    for (size_t i = 1; i < parts.size(); ++i) {
      bool tiny = parts[i].first < 1e-3 * mainVol;
      if (tiny) {
        BRepExtrema_DistShapeShape d(parts[i].second, main);
        if (d.Value() > 1e-7) continue;
      }
      kept.push_back(parts[i].second);
    }
    if (kept.size() == parts.size()) return bo_own(shape);
    if (kept.size() == 1) return bo_own(kept[0]);
    BoShape c = bo_compound_new();
    for (auto &k : kept) bo_compound_add(*c, k);
    return c;
  } catch (...) {
    return bo_own(shape);
  }
}

// Does `outer` reach everywhere `inner` does? Control-point boxes on both
// sides, with a 1% slack on the span, so a recut face whose poles moved does
// not vote; a constituent the fuse dropped is out by its whole length.
inline bool bo_box_covers(const TopoDS_Shape &outer, const TopoDS_Shape &inner) {
  Bnd_Box a, b;
  try {
    BRepBndLib::Add(outer, a);
    BRepBndLib::Add(inner, b);
  } catch (...) {
    return true;  // unmeasurable, so it does not get a vote
  }
  if (a.IsVoid() || b.IsVoid()) return true;
  double ax0, ay0, az0, ax1, ay1, az1, bx0, by0, bz0, bx1, by1, bz1;
  a.Get(ax0, ay0, az0, ax1, ay1, az1);
  b.Get(bx0, by0, bz0, bx1, by1, bz1);
  double span = std::max({bx1 - bx0, by1 - by0, bz1 - bz0});
  double slack = std::max(1e-6, 0.01 * span);
  const double lo_a[3] = {ax0, ay0, az0}, hi_a[3] = {ax1, ay1, az1};
  const double lo_b[3] = {bx0, by0, bz0}, hi_b[3] = {bx1, by1, bz1};
  for (int i = 0; i < 3; ++i)
    if (lo_a[i] > lo_b[i] + slack || hi_a[i] < hi_b[i] - slack) return false;
  return true;
}

// shape_util.py `_unify_body`: right inside-out solids, fuse the glued pieces
// into one, keep the result only when it is valid and its volume plausible.
inline BoShape bo_unify_body(const TopoDS_Shape &shape) {
  try {
    TopTools_IndexedMapOfShape map;
    TopExp::MapShapes(shape, TopAbs_SOLID, map);
    if (map.Extent() == 0) return bo_own(shape);
    std::vector<TopoDS_Shape> solids;
    std::vector<double> vols;
    for (int i = 1; i <= map.Extent(); ++i) {
      solids.push_back(map.FindKey(i));
      vols.push_back(bo_volume(map.FindKey(i)));
    }
    if (solids.size() == 1 && vols[0] >= 0) return bo_own(shape);
    std::vector<TopoDS_Shape> fixed;
    for (auto &s : solids) {
      ShapeFix_Solid fx(TopoDS::Solid(s));
      fx.Perform();
      TopoDS_Shape out = fx.Solid();
      fixed.push_back(out.IsNull() ? s : out);
    }
    TopoDS_Shape merged;
    if (fixed.size() == 1) {
      merged = fixed[0];
    } else {
      TopTools_ListOfShape args, tools;
      args.Append(fixed[0]);
      for (size_t i = 1; i < fixed.size(); ++i) tools.Append(fixed[i]);
      BRepAlgoAPI_Fuse op;
      op.SetArguments(args);
      op.SetTools(tools);
      op.Build();
      if (!op.IsDone()) return bo_own(shape);
      try {
        op.SimplifyResult();
      } catch (...) {
      }
      merged = op.Shape();
      if (merged.IsNull()) return bo_own(shape);
    }
    BoShape cleaned = bo_drop_debris(merged);
    double hi = 0, lo = 0;
    for (double v : vols) {
      hi += std::abs(v);
      lo = std::max(lo, std::abs(v));
    }
    double tol = std::max(1.0, 0.01 * hi);
    double after = bo_volume(*cleaned);
    int nAfter = bo_count(*cleaned, 0);
    bool valid = BRepCheck_Analyzer(*cleaned).IsValid();
    // The volume bracket alone cannot see a fuse that DROPPED a constituent:
    // the result is then exactly the largest one, and `lo` is the largest one.
    // Measured on two tangent swept tubes, OCCT 7.8.1 returned the bigger tube
    // alone from the inner fuse and the bracket passed it, so the body lost the
    // smaller tube with nothing said. A union reaches everywhere its
    // constituents do, so their box is the check the bracket is missing.
    bool covers = bo_box_covers(*cleaned, shape);
    bool ok = valid && covers && nAfter >= 1 && nAfter <= (int)solids.size() && lo - tol <= after &&
              after <= hi + tol && after > 0;
    return ok ? std::move(cleaned) : bo_own(shape);
  } catch (...) {
    return bo_own(shape);
  }
}

// --- sketch curves and faces, in the sketch's local XY ----------------------

inline BoShape bo_edge_line(double x1, double y1, double x2, double y2) {
  BO_GUARD(BRepBuilderAPI_MakeEdge mk(gp_Pnt(x1, y1, 0), gp_Pnt(x2, y2, 0));
           return bo_own(mk.Edge());)
}

inline BoShape bo_edge_arc3(double x1, double y1, double mx, double my, double x2, double y2) {
  BO_GUARD(GC_MakeArcOfCircle arc(gp_Pnt(x1, y1, 0), gp_Pnt(mx, my, 0), gp_Pnt(x2, y2, 0));
           BRepBuilderAPI_MakeEdge mk(arc.Value());
           return bo_own(mk.Edge());)
}

inline BoShape bo_edge_circle(double cx, double cy, double r) {
  BO_GUARD(gp_Circ c(gp_Ax2(), r); BRepBuilderAPI_MakeEdge mk(c);
           gp_Trsf t; t.SetTranslation(gp_Vec(cx, cy, 0));
           return bo_own(mk.Edge().Moved(TopLoc_Location(t)));)
}

// Edge.make_ellipse, then Rot(0, 0, angle) and Pos(cx, cy) as locations.
inline BoShape bo_edge_ellipse(double cx, double cy, double rx, double ry, double angle) {
  BO_GUARD(
      gp_Ax2 ax;
      gp_Elips el;
      if (ry > rx) {
        el = gp_Elips(ax, ry, rx).Rotated(gp_Ax1(gp_Pnt(), gp_Dir(0, 0, 1)), M_PI / 2);
      } else {
        el = gp_Elips(ax, rx, ry);
      }
      BRepBuilderAPI_MakeEdge mk(el);
      TopoDS_Shape e = mk.Edge();
      if (angle != 0) e = e.Moved(TopLoc_Location(bo_euler(0, 0, angle)));
      gp_Trsf t; t.SetTranslation(gp_Vec(cx, cy, 0));
      return bo_own(e.Moved(TopLoc_Location(t)));)
}

inline BoShape bo_edge_spline(rust::Slice<const double> xy) {
  BO_GUARD(
      int n = (int)(xy.size() / 2);
      Handle(TColgp_HArray1OfPnt) pts = new TColgp_HArray1OfPnt(1, n);
      for (int i = 0; i < n; ++i) pts->SetValue(i + 1, gp_Pnt(xy[2 * i], xy[2 * i + 1], 0));
      GeomAPI_Interpolate ip(pts, false, 1e-6);
      ip.Perform();
      if (!ip.IsDone()) throw std::runtime_error("B-spline interpolation failed");
      BRepBuilderAPI_MakeEdge mk(ip.Curve());
      return bo_own(mk.Edge());)
}

// Face.make_rect, rotated by `angle` degrees about Z, then moved to (x, y).
inline BoShape bo_face_rect(double x, double y, double w, double h, double angle) {
  BO_GUARD(
      BRepBuilderAPI_MakeFace mk(gp_Pln(gp_Ax3()), -w / 2, w / 2, -h / 2, h / 2);
      TopoDS_Shape f = mk.Face();
      if (angle != 0) f = f.Moved(TopLoc_Location(bo_euler(0, 0, angle)));
      gp_Trsf t; t.SetTranslation(gp_Vec(x, y, 0));
      return bo_own(f.Moved(TopLoc_Location(t)));)
}

// ShapeAnalysis_FreeBounds::ConnectEdgesToWires, as build123d `Wire.combine`.
inline BoShapes bo_wires_from_edges(const TopoDS_Shape &edges, double tol) {
  BO_GUARD(
      Handle(TopTools_HSequenceOfShape) in = new TopTools_HSequenceOfShape();
      Handle(TopTools_HSequenceOfShape) out = new TopTools_HSequenceOfShape();
      for (TopExp_Explorer ex(edges, TopAbs_EDGE); ex.More(); ex.Next()) in->Append(ex.Current());
      ShapeAnalysis_FreeBounds::ConnectEdgesToWires(in, tol, false, out);
      BoShapes v(new std::vector<TopoDS_Shape>());
      for (int i = 1; i <= out->Length(); ++i) v->push_back(out->Value(i));
      return v;)
}

inline bool bo_wire_closed(const TopoDS_Shape &w) {
  if (w.IsNull()) return false;
  return BRep_Tool::IsClosed(w);
}

inline BoShape bo_wire_from_edge(const TopoDS_Shape &e) {
  BO_GUARD(BRepBuilderAPI_MakeWire mk(TopoDS::Edge(e)); return bo_own(mk.Wire());)
}

// build123d `_make_topods_face_from_wires` for a single outer wire.
inline BoShape bo_face_from_wire(const TopoDS_Shape &wire) {
  BO_GUARD(
      if (!BRepLib_FindSurface(wire, -1, true).Found())
        throw std::runtime_error("Cannot build face(s): wires not planar");
      ShapeFix_Shape sfs(wire);
      sfs.Perform();
      TopoDS_Wire w = TopoDS::Wire(sfs.Shape());
      BRepBuilderAPI_MakeFace mk(w, true);
      mk.Build();
      if (!mk.IsDone()) throw std::runtime_error("Cannot build face(s)");
      ShapeFix_Face sff(mk.Face());
      sff.FixOrientation();
      sff.Perform();
      return bo_own(sff.Result());)
}

inline bool bo_face_normal_mid(const TopoDS_Shape &f, rust::Slice<double> out) {
  try {
    TopoDS_Face face = TopoDS::Face(f);
    double u0, u1, v0, v1;
    BRepTools::UVBounds(face, u0, u1, v0, v1);
    gp_Pnt p;
    gp_Vec n;
    BRepGProp_Face(face).Normal(0.5 * (u0 + u1), 0.5 * (v0 + v1), p, n);
    if (n.Magnitude() < 1e-300) return false;
    n.Normalize();
    out[0] = n.X(); out[1] = n.Y(); out[2] = n.Z();
    return true;
  } catch (...) {
    return false;
  }
}

inline BoShape bo_reversed(const TopoDS_Shape &s) { return bo_own(s.Reversed()); }

// sketch_build.py `_subdivide_faces`: split a padded cover by every edge and
// keep the enclosed cells, in local coordinates.
inline BoShapes bo_subdivide(const TopoDS_Shape &edges) {
  BoShapes cells(new std::vector<TopoDS_Shape>());
  try {
    Bnd_Box all;
    bool any = false;
    for (TopoDS_Iterator it(edges); it.More(); it.Next()) {
      Bnd_Box b;
      BRepBndLib::AddOptimal(it.Value(), b, true, false);
      if (b.IsVoid()) continue;
      all.Add(b);
      any = true;
    }
    if (!any) return cells;
    double x0, y0, z0, x1, y1, z1;
    all.Get(x0, y0, z0, x1, y1, z1);
    double sx = x1 - x0, sy = y1 - y0;
    double pad = (sx + sy) * 0.1 + 1.0;
    double cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    double w = sx + 2 * pad, h = sy + 2 * pad;
    BoShape cover = bo_face_rect(cx, cy, w, h, 0);

    BOPAlgo_Splitter sp;
    TopTools_ListOfShape args, tools;
    args.Append(*cover);
    for (TopoDS_Iterator it(edges); it.More(); it.Next()) tools.Append(it.Value());
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Perform();
    TopoDS_Shape res = sp.Shape();
    double bx0 = cx - w / 2, bx1 = cx + w / 2, by0 = cy - h / 2, by1 = cy + h / 2;
    for (TopExp_Explorer ex(res, TopAbs_FACE); ex.More(); ex.Next()) {
      bool onCover = false;
      TopTools_IndexedMapOfShape verts;
      TopExp::MapShapes(ex.Current(), TopAbs_VERTEX, verts);
      for (int i = 1; i <= verts.Extent() && !onCover; ++i) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(verts.FindKey(i)));
        if (std::abs(p.X() - bx0) < 1e-6 || std::abs(p.X() - bx1) < 1e-6 ||
            std::abs(p.Y() - by0) < 1e-6 || std::abs(p.Y() - by1) < 1e-6)
          onCover = true;
      }
      if (!onCover) cells->push_back(ex.Current());
    }
    return cells;
  } catch (...) {
    cells->clear();
    return cells;
  }
}

// face_footprint.py `split_profile_cells`: cut located cells along the model
// edges lying in the sketch plane.
inline BoShapes bo_split_profile_cells(const TopoDS_Shape &cells, double ox, double oy, double oz,
                                       double nx, double ny, double nz, const TopoDS_Shape &shapes,
                                       double modelScale) {
  BoShapes out(new std::vector<TopoDS_Shape>());
  std::vector<TopoDS_Shape> in;
  for (TopoDS_Iterator it(cells); it.More(); it.Next()) in.push_back(it.Value());
  for (auto &c : in) out->push_back(c);
  if (in.empty()) return out;
  try {
    double tol = std::max(1e-5, (modelScale > 0 ? modelScale : 0.0) * 1e-4);
    Bnd_Box within;
    for (auto &c : in) {
      Bnd_Box b;
      BRepBndLib::AddOptimal(c, b, true, false);
      if (!b.IsVoid()) within.Add(b);
    }
    auto sd = [&](double x, double y, double z) {
      return (x - ox) * nx + (y - oy) * ny + (z - oz) * nz;
    };
    TopTools_ListOfShape tools;
    for (TopoDS_Iterator bi(shapes); bi.More(); bi.Next()) {
      TopTools_IndexedMapOfShape em;
      TopExp::MapShapes(bi.Value(), TopAbs_EDGE, em);
      for (int i = 1; i <= em.Extent(); ++i) {
        const TopoDS_Shape &e = em.FindKey(i);
        Bnd_Box eb;
        BRepBndLib::AddOptimal(e, eb, true, false);
        if (eb.IsVoid()) continue;
        double a0, a1, a2, a3, a4, a5, w0, w1, w2, w3, w4, w5;
        eb.Get(a0, a1, a2, a3, a4, a5);
        if (!within.IsVoid()) {
          within.Get(w0, w1, w2, w3, w4, w5);
          if (!(w0 - tol <= a3 && a0 - tol <= w3 && w1 - tol <= a4 && a1 - tol <= w4 &&
                w2 - tol <= a5 && a2 - tol <= w5))
            continue;
        }
        double lo = 1e300, hi = -1e300;
        for (double x : {a0, a3})
          for (double y : {a1, a4})
            for (double z : {a2, a5}) {
              double d = sd(x, y, z);
              lo = std::min(lo, d);
              hi = std::max(hi, d);
            }
        if (!(lo <= tol && hi >= -tol)) continue;
        BRepAdaptor_Curve cv(TopoDS::Edge(e));
        double f = cv.FirstParameter(), l = cv.LastParameter();
        bool inPlane = true;
        for (int k = 0; k <= 8 && inPlane; ++k) {
          gp_Pnt p = cv.Value(f + (l - f) * k / 8.0);
          if (std::abs(sd(p.X(), p.Y(), p.Z())) > tol) inPlane = false;
        }
        if (inPlane) tools.Append(e);
      }
    }
    if (tools.IsEmpty()) return out;
    BOPAlgo_Splitter sp;
    TopTools_ListOfShape args;
    for (auto &c : in) args.Append(c);
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Perform();
    if (sp.HasErrors()) return out;
    std::vector<TopoDS_Shape> split;
    for (TopExp_Explorer ex(sp.Shape(), TopAbs_FACE); ex.More(); ex.Next()) split.push_back(ex.Current());
    if (split.empty()) return out;
    double before = 0, after = 0;
    for (auto &c : in) before += bo_area(c);
    for (auto &c : split) after += bo_area(c);
    if (after < before - std::max(1e-9, before * 1e-6)) return out;
    out->clear();
    for (auto &c : split) out->push_back(c);
    return out;
  } catch (...) {
    return out;
  }
}

// build123d `Face.is_inside`: on the face within `tol`.
inline bool bo_face_contains(const TopoDS_Shape &face, double x, double y, double z, double tol) {
  try {
    BRepClass3d_SolidClassifier sc(face);
    sc.Perform(gp_Pnt(x, y, z), tol);
    return sc.IsOnAFace();
  } catch (...) {
    return false;
  }
}

inline bool bo_face_is_planar(const TopoDS_Shape &f) {
  try {
    Handle(Geom_Surface) s = BRep_Tool::Surface(TopoDS::Face(f));
    return !s.IsNull() && GeomLib_IsPlanarSurface(s, 1e-6).IsPlanar();
  } catch (...) {
    return false;
  }
}

// Plane(face).z_dir: the normal where the origin projects onto the surface.
inline bool bo_face_plane_normal(const TopoDS_Shape &f, rust::Slice<double> out) {
  try {
    TopoDS_Face face = TopoDS::Face(f);
    GeomAPI_ProjectPointOnSurf proj(gp_Pnt(0, 0, 0), BRep_Tool::Surface(face));
    double u, v;
    proj.LowerDistanceParameters(u, v);
    gp_Pnt p;
    gp_Vec n;
    BRepGProp_Face(face).Normal(u, v, p, n);
    if (n.Magnitude() < 1e-300) return false;
    n.Normalize();
    out[0] = n.X(); out[1] = n.Y(); out[2] = n.Z();
    return true;
  } catch (...) {
    return false;
  }
}

inline BoShape bo_prism(const TopoDS_Shape &face, double dx, double dy, double dz) {
  BO_GUARD(
      BRepPrimAPI_MakePrism mk(face, gp_Vec(dx, dy, dz));
      TopoDS_Shape s = mk.Shape();
      if (s.ShapeType() == TopAbs_COMPSOLID) {
        BoShape c = bo_compound_new();
        for (TopExp_Explorer ex(s, TopAbs_SOLID); ex.More(); ex.Next()) bo_compound_add(*c, ex.Current());
        return c;
      }
      return bo_own(s);)
}

inline TopoDS_Wire bo_offset_wire(const TopoDS_Wire &w, double d) {
  BRepOffsetAPI_MakeOffset mk;
  mk.Init(GeomAbs_Intersection);
  TopTools_IndexedMapOfShape em;
  TopExp::MapShapes(w, TopAbs_EDGE, em);
  if (em.Extent() == 1) {
    TopoDS_Edge e = TopoDS::Edge(em.FindKey(1));
    double f, l;
    Handle(Geom_Curve) c = BRep_Tool::Curve(e, f, l);
    double m = f + (l - f) * 0.5;
    BRepBuilderAPI_MakeWire mw(BRepBuilderAPI_MakeEdge(c, f, m).Edge(), BRepBuilderAPI_MakeEdge(c, m, l).Edge());
    mk.AddWire(mw.Wire());
  } else {
    mk.AddWire(w);
  }
  mk.Perform(d);
  TopoDS_Shape s = bo_unwrap(mk.Shape());
  if (s.IsNull() || s.ShapeType() != TopAbs_WIRE) throw std::runtime_error("RuntimeError");
  return TopoDS::Wire(s);
}

// Solid.extrude_taper: LocOpe_DPrism when it applies, else a loft between each
// wire and its 2D offset at the far end, holes subtracted.
inline BoShape bo_prism_taper(const TopoDS_Shape &faceShape, double dx, double dy, double dz,
                              double taper, double ox, double oy, double oz, double xx, double xy,
                              double xz, double nx, double ny, double nz, bool dprism) {
  BO_GUARD(
      TopoDS_Face face = TopoDS::Face(faceShape);
      double len = std::sqrt(dx * dx + dy * dy + dz * dz);
      TopoDS_Wire outer = BRepTools::OuterWire(face);
      if (dprism) {
        LocOpe_DPrism dp(face, len / std::cos(taper * M_PI / 180.0), taper * M_PI / 180.0);
        return bo_own(dp.Shape());
      }
      gp_Trsf toWorld = bo_plane_trsf(ox, oy, oz, xx, xy, xz, nx, ny, nz);
      gp_Trsf toLocal = toWorld.Inverted();
      gp_Trsf lift; lift.SetTranslation(gp_Vec(dx, dy, dz));
      double amt = -len * std::tan(taper * M_PI / 180.0);
      std::vector<TopoDS_Wire> wires{outer};
      for (TopExp_Explorer ex(face, TopAbs_WIRE); ex.More(); ex.Next())
        if (!ex.Current().IsSame(outer)) wires.push_back(TopoDS::Wire(ex.Current()));
      std::vector<TopoDS_Shape> solids;
      for (size_t i = 0; i < wires.size(); ++i) {
        double flip = i > 0 ? -1.0 : 1.0;
        TopoDS_Wire local = TopoDS::Wire(BRepBuilderAPI_Transform(wires[i], toLocal, true).Shape());
        TopoDS_Wire off = bo_offset_wire(local, flip * amt);
        TopoDS_Shape world = BRepBuilderAPI_Transform(off, toWorld, true).Shape();
        world = world.Moved(TopLoc_Location(lift));
        BRepOffsetAPI_ThruSections ts(true, false);
        ts.AddWire(wires[i]);
        ts.AddWire(TopoDS::Wire(world));
        ts.Build();
        solids.push_back(ts.Shape());
      }
      if (solids.size() == 1) return bo_own(solids[0]);
      BoShape tools = bo_compound_new();
      for (size_t i = 1; i < solids.size(); ++i) bo_compound_add(*tools, solids[i]);
      return bo_boolean(solids[0], *tools, 1, true, 0.0, true);)
}

inline bool bo_face_has_holes(const TopoDS_Shape &f) { return bo_count(f, 3) > 1; }

// --- revolve ----------------------------------------------------------------

inline BoShape bo_revolve(const TopoDS_Shape &s, double ox, double oy, double oz, double dx,
                          double dy, double dz, double angleDeg) {
  BO_GUARD(BRepPrimAPI_MakeRevol mk(s, gp_Ax1(gp_Pnt(ox, oy, oz), gp_Dir(dx, dy, dz)),
                                    angleDeg * M_PI / 180.0, false);
           return bo_own(mk.Shape());)
}
