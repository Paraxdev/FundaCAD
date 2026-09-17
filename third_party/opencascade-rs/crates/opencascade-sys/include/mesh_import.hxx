#pragma once
// A triangle mesh made into B-rep, as sidecar/mesh_import.py does it: one
// planar face per triangle sewn into a solid (build123d `Mesher._get_shape`),
// coplanar facets merged (`shape_util._maybe_unify`), the facts and the face
// rebuild `shape_util._refacet_clean` works with.

#include "rust/cxx.h"
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRep_Builder.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <bindings_common.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <memory>
#include <set>
#include <stdexcept>
#include <vector>

inline std::unique_ptr<TopoDS_Shape> mesh_import_own(const TopoDS_Shape &s) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(s));
}

inline double mesh_import_bbox_volume(const TopoDS_Shape &s) {
  Bnd_Box box;
  BRepBndLib::AddOptimal(s, box, true, false);
  if (box.IsVoid()) {
    return 0.0;
  }
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  return (x1 - x0) * (y1 - y0) * (z1 - z0);
}

// build123d `is_manifold`: every edge of every top level shape on two faces.
inline bool mesh_import_is_manifold(const TopoDS_Shape &s) {
  TopTools_IndexedDataMapOfShapeListOfShape map;
  TopExp::MapShapesAndAncestors(s, TopAbs_EDGE, TopAbs_FACE, map);
  for (int i = 1; i <= map.Extent(); ++i) {
    if (map.FindFromIndex(i).Extent() != 2) {
      return false;
    }
  }
  return true;
}

inline std::unique_ptr<TopoDS_Shape> mesh_import_sew(rust::Slice<const double> pos,
                                                     rust::Slice<const uint32_t> idx) {
  size_t nvert = pos.size() / 3;
  BRepBuilderAPI_Sewing sewing;
  for (size_t t = 0; t + 2 < idx.size(); t += 3) {
    gp_Pnt p[3];
    bool ok = true;
    for (int k = 0; k < 3; ++k) {
      uint32_t v = idx[t + k];
      if (v >= nvert) {
        ok = false;
        break;
      }
      p[k] = gp_Pnt(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
    }
    if (!ok) {
      throw std::invalid_argument("a triangle references a vertex that does not exist");
    }
    try {
      BRepBuilderAPI_MakePolygon poly(p[0], p[1], p[2], true);
      if (!poly.IsDone()) {
        continue;
      }
      BRepBuilderAPI_MakeFace face(poly.Wire());
      if (!face.IsDone()) {
        continue;
      }
      GProp_GProps props;
      BRepGProp::SurfaceProperties(face.Face(), props);
      if (props.Mass() != 0.0) {
        sewing.Add(face.Face());
      }
    } catch (const Standard_Failure &) {
      // a collinear triangle has no plane, lib3mf's reader never hands one to OCCT
    }
  }
  sewing.Perform();
  TopoDS_Shape sewn = sewing.SewedShape();
  if (sewn.IsNull()) {
    throw std::runtime_error("no geometry found in the mesh file");
  }
  std::vector<TopoDS_Shell> shells;
  if (sewn.ShapeType() == TopAbs_COMPOUND) {
    for (TopExp_Explorer ex(sewn, TopAbs_SHELL); ex.More(); ex.Next()) {
      shells.push_back(TopoDS::Shell(ex.Current()));
    }
  } else if (sewn.ShapeType() == TopAbs_SHELL) {
    shells.push_back(TopoDS::Shell(sewn));
  } else {
    return mesh_import_own(sewn);
  }
  if (shells.empty()) {
    return mesh_import_own(sewn);
  }
  size_t outer = 0;
  double best = mesh_import_bbox_volume(shells[0]);
  for (size_t i = 1; i < shells.size(); ++i) {
    double v = mesh_import_bbox_volume(shells[i]);
    if (v > best) {
      best = v;
      outer = i;
    }
  }
  if (!mesh_import_is_manifold(shells[outer])) {
    return mesh_import_own(shells[outer]);
  }
  BRepBuilderAPI_MakeSolid solid(shells[outer]);
  for (size_t i = 0; i < shells.size(); ++i) {
    if (i != outer) {
      solid.Add(shells[i]);
    }
  }
  return mesh_import_own(solid.Solid());
}

inline std::unique_ptr<TopoDS_Shape> mesh_import_unify(const TopoDS_Shape &shape) {
  try {
    ShapeUpgrade_UnifySameDomain up(shape, true, true, true);
    up.Build();
    TopoDS_Shape merged = up.Shape();
    if (!merged.IsNull()) {
      TopTools_IndexedMapOfShape faces;
      TopExp::MapShapes(merged, TopAbs_FACE, faces);
      if (faces.Extent() > 0) {
        return mesh_import_own(merged);
      }
    }
  } catch (...) {
  }
  return mesh_import_own(shape);
}

// `_explode_solids`: a solid per shell of every solid, then the compound's
// top level children that hold no solid.
inline std::unique_ptr<std::vector<TopoDS_Shape>> mesh_import_explode(const TopoDS_Shape &shape) {
  std::unique_ptr<std::vector<TopoDS_Shape>> out(new std::vector<TopoDS_Shape>());
  TopTools_IndexedMapOfShape solids;
  TopExp::MapShapes(shape, TopAbs_SOLID, solids);
  if (solids.Extent() == 0) {
    out->push_back(shape);
    return out;
  }
  for (int i = 1; i <= solids.Extent(); ++i) {
    const TopoDS_Shape &sd = solids.FindKey(i);
    TopTools_IndexedMapOfShape shells;
    TopExp::MapShapes(sd, TopAbs_SHELL, shells);
    if (shells.Extent() <= 1) {
      out->push_back(sd);
      continue;
    }
    for (int k = 1; k <= shells.Extent(); ++k) {
      TopoDS_Solid mk;
      BRep_Builder b;
      b.MakeSolid(mk);
      b.Add(mk, shells.FindKey(k));
      out->push_back(*mesh_import_unify(mk));
    }
  }
  if (shape.ShapeType() == TopAbs_COMPOUND) {
    for (TopoDS_Iterator it(shape); it.More(); it.Next()) {
      TopTools_IndexedMapOfShape inner;
      TopExp::MapShapes(it.Value(), TopAbs_SOLID, inner);
      if (inner.Extent() == 0) {
        out->push_back(it.Value());
      }
    }
  }
  return out;
}

inline size_t mesh_import_shapes_len(const std::vector<TopoDS_Shape> &v) { return v.size(); }
inline std::unique_ptr<TopoDS_Shape> mesh_import_shapes_get(const std::vector<TopoDS_Shape> &v, size_t i) {
  return mesh_import_own(v.at(i));
}

// The per face facts region growing reads, faces in TopExp::MapShapes order.
class FaceFacts {
public:
  TopTools_IndexedMapOfShape faces;
  TopTools_IndexedDataMapOfShapeListOfShape edges;
};

inline std::unique_ptr<FaceFacts> face_facts_new(const TopoDS_Shape &shape) {
  std::unique_ptr<FaceFacts> f(new FaceFacts());
  TopExp::MapShapes(shape, TopAbs_FACE, f->faces);
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, f->edges);
  return f;
}

inline int32_t face_facts_count(const FaceFacts &f) { return f.faces.Extent(); }

inline bool face_facts_all_planar(const FaceFacts &f) {
  if (f.faces.Extent() == 0) {
    return false;
  }
  for (int i = 1; i <= f.faces.Extent(); ++i) {
    BRepAdaptor_Surface s(TopoDS::Face(f.faces.FindKey(i)));
    if (s.GetType() != GeomAbs_Plane) {
      return false;
    }
  }
  return true;
}

// [area, centre x y z, normal x y z] of face `i` (0 based), the centre of
// mass and the surface normal there, oriented with the face.
inline rust::Vec<double> face_facts_plane(const FaceFacts &f, int32_t i) {
  const TopoDS_Face &face = TopoDS::Face(f.faces.FindKey(i + 1));
  GProp_GProps props;
  BRepGProp::SurfaceProperties(face, props);
  gp_Pnt c = props.CentreOfMass();
  BRepAdaptor_Surface surf(face);
  gp_Pln pln = surf.Plane();
  gp_Dir d = pln.Axis().Direction();
  if (face.Orientation() == TopAbs_REVERSED) {
    d.Reverse();
  }
  rust::Vec<double> out;
  for (double v : {props.Mass(), c.X(), c.Y(), c.Z(), d.X(), d.Y(), d.Z()}) {
    out.push_back(v);
  }
  return out;
}

inline rust::Vec<double> face_facts_vertices(const FaceFacts &f, int32_t i) {
  TopTools_IndexedMapOfShape verts;
  TopExp::MapShapes(f.faces.FindKey(i + 1), TopAbs_VERTEX, verts);
  rust::Vec<double> out;
  for (int k = 1; k <= verts.Extent(); ++k) {
    gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(verts.FindKey(k)));
    out.push_back(p.X());
    out.push_back(p.Y());
    out.push_back(p.Z());
  }
  return out;
}

// Edge neighbours of face `i`, 0 based, ascending, itself excluded.
inline rust::Vec<int32_t> face_facts_neighbors(const FaceFacts &f, int32_t i) {
  std::set<int32_t> seen;
  for (TopExp_Explorer ex(f.faces.FindKey(i + 1), TopAbs_EDGE); ex.More(); ex.Next()) {
    if (!f.edges.Contains(ex.Current())) {
      continue;
    }
    for (const TopoDS_Shape &other : f.edges.FindFromKey(ex.Current())) {
      int32_t j = f.faces.FindIndex(other) - 1;
      if (j != i && j >= 0) {
        seen.insert(j);
      }
    }
  }
  rust::Vec<int32_t> out;
  for (int32_t j : seen) {
    out.push_back(j);
  }
  return out;
}

class PlanarRebuild {
public:
  std::vector<TopoDS_Face> faces;
};

inline std::unique_ptr<PlanarRebuild> planar_rebuild_new() {
  return std::unique_ptr<PlanarRebuild>(new PlanarRebuild());
}

// One region: its plane and loops of in-plane points, largest loop first.
// Loops that make no polygon are skipped, a region left with none adds no
// face. False when the face cannot be made.
inline bool planar_rebuild_add(PlanarRebuild &r, rust::Slice<const double> plane,
                               rust::Slice<const double> points, rust::Slice<const uint32_t> loop_lens) {
  std::vector<TopoDS_Wire> wires;
  size_t at = 0;
  for (uint32_t n : loop_lens) {
    BRepBuilderAPI_MakePolygon mp;
    for (uint32_t k = 0; k < n; ++k, ++at) {
      mp.Add(gp_Pnt(points[3 * at], points[3 * at + 1], points[3 * at + 2]));
    }
    mp.Close();
    if (mp.IsDone()) {
      wires.push_back(mp.Wire());
    }
  }
  if (wires.empty()) {
    return true;
  }
  gp_Pln pln(gp_Pnt(plane[0], plane[1], plane[2]), gp_Dir(plane[3], plane[4], plane[5]));
  BRepBuilderAPI_MakeFace mf(pln, wires[0]);
  for (size_t i = 1; i < wires.size(); ++i) {
    mf.Add(wires[i]);
  }
  if (!mf.IsDone()) {
    return false;
  }
  ShapeFix_Face fx(mf.Face());
  fx.Perform();
  r.faces.push_back(fx.Face());
  return true;
}

// Sew, fix, split into edge connected components and make a solid of each.
inline std::unique_ptr<TopoDS_Shape> planar_rebuild_finish(const PlanarRebuild &r, double sew_tol) {
  BRepBuilderAPI_Sewing sew(sew_tol);
  for (const TopoDS_Face &f : r.faces) {
    sew.Add(f);
  }
  sew.Perform();
  ShapeFix_Shape fixer(sew.SewedShape());
  fixer.Perform();
  TopoDS_Shape sewn = fixer.Shape();

  FaceFacts adj;
  TopExp::MapShapes(sewn, TopAbs_FACE, adj.faces);
  TopExp::MapShapesAndAncestors(sewn, TopAbs_EDGE, TopAbs_FACE, adj.edges);
  int32_t n = adj.faces.Extent();
  std::set<int32_t> unvisited;
  for (int32_t i = 0; i < n; ++i) {
    unvisited.insert(i);
  }
  std::vector<TopoDS_Shape> solids;
  while (!unvisited.empty()) {
    int32_t seed = *unvisited.begin();
    unvisited.erase(unvisited.begin());
    std::vector<int32_t> group{seed}, queue{seed};
    while (!queue.empty()) {
      int32_t k = queue.back();
      queue.pop_back();
      for (int32_t j : face_facts_neighbors(adj, k)) {
        if (unvisited.erase(j)) {
          group.push_back(j);
          queue.push_back(j);
        }
      }
    }
    BRepBuilderAPI_Sewing part(sew_tol);
    for (int32_t k : group) {
      part.Add(adj.faces.FindKey(k + 1));
    }
    part.Perform();
    for (TopExp_Explorer ex(part.SewedShape(), TopAbs_SHELL); ex.More(); ex.Next()) {
      ShapeFix_Solid sf;
      solids.push_back(sf.SolidFromShell(TopoDS::Shell(ex.Current())));
    }
  }
  if (solids.empty()) {
    return std::unique_ptr<TopoDS_Shape>();
  }
  if (solids.size() == 1) {
    return mesh_import_own(solids[0]);
  }
  TopoDS_Compound c;
  BRep_Builder b;
  b.MakeCompound(c);
  for (const TopoDS_Shape &s : solids) {
    b.Add(c, s);
  }
  return mesh_import_own(c);
}
