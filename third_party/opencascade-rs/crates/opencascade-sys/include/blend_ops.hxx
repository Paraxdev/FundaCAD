// Fillets and chamfers as the Python engine's `blends.py` drives them, one call each from Rust.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <Poly_Triangulation.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <cmath>
#include <memory>
#include <vector>

using BlShape = std::unique_ptr<TopoDS_Shape>;
using BlShapes = std::unique_ptr<std::vector<TopoDS_Shape>>;

inline std::vector<TopoDS_Shape> bl_children(const TopoDS_Shape &s) {
  std::vector<TopoDS_Shape> out;
  if (s.IsNull()) return out;
  for (TopoDS_Iterator it(s); it.More(); it.Next()) out.push_back(it.Value());
  return out;
}

// status: 0 built, 1 not done, 2 built but BRepCheck calls it invalid.
inline BlShape blend_fillet(const TopoDS_Shape &shape, const TopoDS_Shape &edges,
                            rust::Slice<const double> radii, int32_t &status) {
  BRepFilletAPI_MakeFillet mk(shape);
  std::vector<TopoDS_Shape> es = bl_children(edges);
  for (size_t i = 0; i < es.size() && i < radii.size(); ++i) mk.Add(radii[i], TopoDS::Edge(es[i]));
  mk.Build();
  if (!mk.IsDone()) {
    status = 1;
    return BlShape(new TopoDS_Shape());
  }
  TopoDS_Shape out = mk.Shape();
  status = BRepCheck_Analyzer(out).IsValid() ? 0 : 2;
  return BlShape(new TopoDS_Shape(out));
}

// d1 along the first face the ancestor map lists for each edge, d2 along the other.
inline BlShape blend_chamfer(const TopoDS_Shape &shape, const TopoDS_Shape &edges,
                             rust::Slice<const double> d1, rust::Slice<const double> d2,
                             int32_t &status) {
  TopTools_IndexedDataMapOfShapeListOfShape map;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, map);
  BRepFilletAPI_MakeChamfer mk(shape);
  std::vector<TopoDS_Shape> es = bl_children(edges);
  for (size_t i = 0; i < es.size() && i < d1.size() && i < d2.size(); ++i) {
    const TopoDS_Edge &e = TopoDS::Edge(es[i]);
    mk.Add(d1[i], d2[i], e, TopoDS::Face(map.FindFromKey(e).First()));
  }
  mk.Build();
  if (!mk.IsDone()) {
    status = 1;
    return BlShape(new TopoDS_Shape());
  }
  TopoDS_Shape out = mk.Shape();
  status = BRepCheck_Analyzer(out).IsValid() ? 0 : 2;
  return BlShape(new TopoDS_Shape(out));
}

// blends.py `_kernel_copy`: the copy, then each edge's copy in its orientation,
// or nothing when an edge has no image.
inline BlShapes blend_copy(const TopoDS_Shape &shape, const TopoDS_Shape &edges) {
  BlShapes out(new std::vector<TopoDS_Shape>());
  BRepBuilderAPI_Copy mk(shape, false);
  std::vector<TopoDS_Shape> copied;
  for (const TopoDS_Shape &e : bl_children(edges)) {
    const TopTools_ListOfShape &got = mk.Modified(e);
    if (got.Size() == 0) return out;
    copied.push_back(got.First().Oriented(e.Orientation()));
  }
  out->push_back(mk.Shape());
  for (const TopoDS_Shape &c : copied) out->push_back(c);
  return out;
}

inline std::vector<TopoDS_Shape> bl_unique_faces(const TopoDS_Shape &shape, const TopoDS_Shape &edge) {
  TopTools_IndexedDataMapOfShapeListOfShape map;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, map);
  std::vector<TopoDS_Shape> uniq;
  int idx = map.FindIndex(edge);
  if (idx == 0) return uniq;
  for (TopTools_ListOfShape::Iterator it(map.FindFromIndex(idx)); it.More(); it.Next()) {
    bool seen = false;
    for (const TopoDS_Shape &g : uniq) seen = seen || it.Value().IsSame(g);
    if (!seen) uniq.push_back(it.Value());
  }
  return uniq;
}

// topo_adj.py `faces_of_edge` read as a seam: two entries naming one face.
inline bool blend_is_seam(const TopoDS_Shape &shape, const TopoDS_Shape &edge) {
  try {
    TopTools_IndexedDataMapOfShapeListOfShape map;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, map);
    int idx = map.FindIndex(edge);
    if (idx == 0) return false;
    const TopTools_ListOfShape &l = map.FindFromIndex(idx);
    return l.Size() == 2 && l.First().IsSame(l.Last());
  } catch (...) {
    return false;
  }
}

// blends.py `_edge_dihedral_deg` at the point `p` on the edge, -1 for None.
inline double blend_dihedral_deg(const TopoDS_Shape &shape, const TopoDS_Shape &edge, double px,
                                 double py, double pz) {
  try {
    std::vector<TopoDS_Shape> faces = bl_unique_faces(shape, edge);
    if (faces.size() != 2) return -1.0;
    gp_Pnt p(px, py, pz);
    gp_Vec normals[2];
    for (int k = 0; k < 2; ++k) {
      const TopoDS_Face &fc = TopoDS::Face(faces[k]);
      Handle(Geom_Surface) surf = BRep_Tool::Surface(fc);
      GeomAPI_ProjectPointOnSurf proj(p, surf);
      double u = 0, v = 0;
      proj.LowerDistanceParameters(u, v);
      BRepAdaptor_Surface ad(fc);
      gp_Pnt q;
      gp_Vec du, dv;
      ad.D1(u, v, q, du, dv);
      gp_Vec n = du.Crossed(dv);
      if (n.Magnitude() < 1e-12) return -1.0;
      n.Normalize();
      normals[k] = n;
    }
    double d = normals[0].Dot(normals[1]);
    d = std::max(-1.0, std::min(1.0, d));
    return std::acos(d) * 180.0 / M_PI;
  } catch (...) {
    return -1.0;
  }
}

// blend_overlap.py `_triangles`: the faces of `faces` meshed on a copy, as
// [face index, a xyz, b xyz, c xyz] per triangle in world coordinates.
inline rust::Vec<double> blend_face_triangles(const TopoDS_Shape &faces, double deflection) {
  rust::Vec<double> out;
  BRepBuilderAPI_Copy cp(faces);
  TopoDS_Shape comp = cp.Shape();
  BRepTools::Clean(comp);
  BRepMesh_IncrementalMesh(comp, deflection, false, 0.5, true);
  int fi = 0;
  for (TopExp_Explorer ex(comp, TopAbs_FACE); ex.More(); ex.Next(), ++fi) {
    TopLoc_Location loc;
    Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(TopoDS::Face(ex.Current()), loc);
    if (tri.IsNull()) continue;
    gp_Trsf trsf = loc.Transformation();
    for (int i = 1; i <= tri->NbTriangles(); ++i) {
      int a, b, c;
      tri->Triangle(i).Get(a, b, c);
      out.push_back(fi);
      for (int n : {a, b, c}) {
        gp_Pnt p = tri->Node(n).Transformed(trsf);
        out.push_back(p.X());
        out.push_back(p.Y());
        out.push_back(p.Z());
      }
    }
  }
  return out;
}

inline bool blend_is_valid(const TopoDS_Shape &shape) {
  try {
    return !shape.IsNull() && BRepCheck_Analyzer(shape).IsValid();
  } catch (...) {
    return false;
  }
}
