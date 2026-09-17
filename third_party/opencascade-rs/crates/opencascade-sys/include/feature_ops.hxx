// Hole, loft and sweep operations for the FundaCAD builder, as build123d runs
// them for sidecar/hole_feature.py and sidecar/builder.py `_handle_loft` and
// `_handle_sweep`.
#pragma once
#include "builder_ops.hxx"

#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_TransitionMode.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>

#include <climits>

// build123d `Face(Wire.make_polygon(pts, close=True))`, pts flat xyz.
inline BoShape fo_polygon_face(rust::Slice<const double> pts) {
  BO_GUARD(
      BRepBuilderAPI_MakePolygon poly;
      for (size_t i = 0; i + 2 < pts.size(); i += 3) poly.Add(gp_Pnt(pts[i], pts[i + 1], pts[i + 2]));
      poly.Close();
      BRepBuilderAPI_MakeFace mk(poly.Wire(), true);
      if (!mk.IsDone()) throw std::runtime_error("StdFail_NotDone");
      return bo_own(mk.Face());)
}

// build123d `Shape.distance_to(Vector)`, -1 when it cannot be measured.
inline double fo_distance_to_point(const TopoDS_Shape &s, double x, double y, double z) {
  try {
    TopoDS_Vertex v = BRepBuilderAPI_MakeVertex(gp_Pnt(x, y, z));
    BRepExtrema_DistShapeShape d(s, v);
    if (!d.IsDone()) return -1.0;
    return d.Value();
  } catch (...) {
    return -1.0;
  }
}

inline double fo_length(const TopoDS_Shape &s) {
  if (s.IsNull()) return 0.0;
  GProp_GProps p;
  BRepGProp::LinearProperties(s, p);
  return p.Mass();
}

inline void fo_face_wires(const TopoDS_Face &face, TopoDS_Wire &outer, std::vector<TopoDS_Wire> &inner) {
  outer = BRepTools::OuterWire(face);
  for (TopExp_Explorer ex(face, TopAbs_WIRE); ex.More(); ex.Next()) {
    const TopoDS_Wire &w = TopoDS::Wire(ex.Current());
    if (!w.IsSame(outer)) inner.push_back(w);
  }
}

inline bool fo_valid(const TopoDS_Shape &s) {
  try {
    BRepCheck_Analyzer a(s);
    return a.IsValid();
  } catch (...) {
    return false;
  }
}

inline TopoDS_Shape fo_thru_sections(const std::vector<TopoDS_Wire> &wires, bool ruled) {
  if (wires.size() < 2) throw std::runtime_error("ValueError");
  BRepOffsetAPI_ThruSections mk(true, ruled);
  for (const auto &w : wires) mk.AddWire(w);
  mk.Build();
  const TopoDS_Shape &out = mk.Shape();
  // OCCT 7.8 lofts coincident profiles into an empty solid where 7.9, which
  // the Python engine runs, refuses them as not done.
  if (std::abs(bo_volume(out)) < 1e-9) throw std::runtime_error("StdFail_NotDone");
  return out;
}

// build123d `loft(sections)`: every face of every child of `sections` gives
// its outer wire, and a hole lofted the same way is cut out.
inline BoShape fo_loft_impl(const TopoDS_Shape &sections, bool ruled) {
  std::vector<TopoDS_Wire> outers;
  std::vector<std::vector<TopoDS_Wire>> holes;
  for (TopoDS_Iterator it(sections); it.More(); it.Next()) {
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(it.Value(), TopAbs_FACE, faces);
    for (int i = 1; i <= faces.Extent(); ++i) {
      TopoDS_Wire outer;
      std::vector<TopoDS_Wire> inner;
      fo_face_wires(TopoDS::Face(faces.FindKey(i)), outer, inner);
      outers.push_back(outer);
      holes.push_back(inner);
    }
  }
  size_t lo = SIZE_MAX, hi = 0;
  for (const auto &h : holes) {
    lo = std::min(lo, h.size());
    hi = std::max(hi, h.size());
  }
  std::vector<TopoDS_Wire> holeWires;
  if (!holes.empty() && hi > 0) {
    if (lo != hi || hi > 1) throw std::runtime_error("ValueError");
    for (const auto &h : holes) holeWires.push_back(h[0]);
  }
  TopoDS_Shape solid = fo_thru_sections(outers, ruled);
  if (!holeWires.empty()) {
    TopoDS_Shape hollow = fo_thru_sections(holeWires, ruled);
    BoShape tools = bo_compound_new();
    bo_compound_add(*tools, hollow);
    solid = *bo_boolean(solid, *tools, 1, true, 0.0, true);
  }
  if (!fo_valid(solid)) {
    TopoDS_Shell shell;
    BRep_Builder b;
    b.MakeShell(shell);
    for (TopExp_Explorer ex(solid, TopAbs_FACE); ex.More(); ex.Next()) b.Add(shell, ex.Current());
    TopoDS_Solid rebuilt;
    b.MakeSolid(rebuilt);
    b.Add(rebuilt, shell);
    solid = bo_unify(rebuilt);
    if (!fo_valid(solid)) throw std::runtime_error("RuntimeError");
  }
  BoShape out = bo_compound_new();
  bo_compound_add(*out, bo_unify(solid));
  return out;
}

inline BoShape fo_loft(const TopoDS_Shape &sections, bool ruled) {
  BO_GUARD(return fo_loft_impl(sections, ruled);)
}

// build123d `sweep(sections=profile, path=path, transition=Transition.RIGHT)`.
inline BoShape fo_sweep_impl(const TopoDS_Shape &profile, const TopoDS_Shape &path) {
  TopoDS_Wire spine;
  if (path.ShapeType() == TopAbs_WIRE) spine = TopoDS::Wire(path);
  else spine = BRepBuilderAPI_MakeWire(TopoDS::Edge(path)).Wire();
  BoShape out = bo_compound_new();
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(profile, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); ++i) {
    TopoDS_Wire outer;
    std::vector<TopoDS_Wire> inner;
    fo_face_wires(TopoDS::Face(faces.FindKey(i)), outer, inner);
    std::vector<TopoDS_Wire> all{outer};
    all.insert(all.end(), inner.begin(), inner.end());
    std::vector<TopoDS_Shape> shapes;
    for (const auto &w : all) {
      BRepOffsetAPI_MakePipeShell mk(spine);
      mk.SetMode(false);
      mk.SetTransitionMode(BRepBuilderAPI_RightCorner);
      mk.Add(w, false, false);
      mk.Build();
      mk.MakeSolid();
      shapes.push_back(mk.Shape());
    }
    TopoDS_Shape solid = shapes[0];
    if (shapes.size() > 1) {
      BoShape tools = bo_compound_new();
      for (size_t k = 1; k < shapes.size(); ++k) bo_compound_add(*tools, shapes[k]);
      solid = *bo_boolean(solid, *tools, 1, true, 0.0, true);
    }
    bo_compound_add(*out, bo_unify(solid));
  }
  return out;
}

inline BoShape fo_sweep(const TopoDS_Shape &profile, const TopoDS_Shape &path) {
  BO_GUARD(return fo_sweep_impl(profile, path);)
}
