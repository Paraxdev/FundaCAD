#pragma once
// Canonical recognition for B-rep imports, the Python engine's `mesh_import.py`
// `_canonicalize` and `_conversion_meshes`: swept surfaces made elementary,
// near analytic spline faces rebuilt on planes, cylinders, cones and spheres,
// kept only where the mesher still draws them.

#include "rust/cxx.h"
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Geom_Surface.hxx>
#include <Poly_Triangulation.hxx>
#include <ShapeCustom.hxx>
#include <ShapeCustom_Surface.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Solid.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <bindings_common.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <memory>
#include <vector>

inline bool canonical_convertible(const TopoDS_Shape &shape) {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  for (int i = 1; i <= faces.Extent(); ++i) {
    switch (BRepAdaptor_Surface(TopoDS::Face(faces.FindKey(i))).GetType()) {
    case GeomAbs_BSplineSurface:
    case GeomAbs_BezierSurface:
    case GeomAbs_SurfaceOfExtrusion:
    case GeomAbs_SurfaceOfRevolution:
      return true;
    default:
      break;
    }
  }
  return false;
}

// The GeomAbs_SurfaceType of every face, in TopExp::MapShapes order.
inline rust::Vec<int32_t> canonical_surface_types(const TopoDS_Shape &shape) {
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  rust::Vec<int32_t> out;
  for (int i = 1; i <= faces.Extent(); ++i) {
    out.push_back(static_cast<int32_t>(BRepAdaptor_Surface(TopoDS::Face(faces.FindKey(i))).GetType()));
  }
  return out;
}

inline std::unique_ptr<TopoDS_Shape> canonical_swept_to_elementary(const TopoDS_Shape &shape) {
  TopoDS_Shape out = ShapeCustom::SweptToElementary(shape);
  return std::unique_ptr<TopoDS_Shape>(out.IsNull() ? nullptr : new TopoDS_Shape(out));
}

// Coarse on purpose, the mesh is thrown away: a sample of triangles whose
// facet normal should agree with the surface normal at their UV centre.
inline bool canonical_conversion_meshes(const TopoDS_Face &face) {
  try {
    if (face.IsNull()) {
      return false;
    }
    BRepMesh_IncrementalMesh(face, 0.05, true, 0.5, true);
    TopLoc_Location loc;
    Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
    if (tri.IsNull() || !tri->HasUVNodes() || tri->NbTriangles() == 0) {
      return false;
    }
    int n = tri->NbTriangles();
    int step = n / 64 > 1 ? n / 64 : 1;
    bool reversed = face.Orientation() == TopAbs_REVERSED;
    BRepGProp_Face surf(face);
    int sampled = 0, wrong = 0;
    for (int t = 1; t <= n; t += step) {
      int a, b, c;
      tri->Triangle(t).Get(a, b, c);
      if (reversed) {
        std::swap(b, c);
      }
      gp_Pnt pa = tri->Node(a), pb = tri->Node(b), pc = tri->Node(c);
      gp_Vec fn = gp_Vec(pa, pb).Crossed(gp_Vec(pa, pc));
      double u = (tri->UVNode(a).X() + tri->UVNode(b).X() + tri->UVNode(c).X()) / 3.0;
      double v = (tri->UVNode(a).Y() + tri->UVNode(b).Y() + tri->UVNode(c).Y()) / 3.0;
      gp_Pnt p;
      gp_Vec nrm;
      surf.Normal(u, v, p, nrm);
      double scale = fn.Magnitude() * nrm.Magnitude();
      if (scale <= 0.0 || fn.Dot(nrm) / scale < 0.5) {
        ++wrong;
      }
      ++sampled;
    }
    return wrong * 4 <= sampled;
  } catch (...) {
    return false;
  }
}

// Spline faces of `work` rebuilt on analytic surfaces within `tol`, then
// sewn, fixed and made solid. Null when no face converted or nothing solid
// came of it; `converted` says which.
inline std::unique_ptr<TopoDS_Shape> canonical_convert(const TopoDS_Shape &work, double tol, int32_t &converted) {
  converted = 0;
  TopTools_IndexedMapOfShape faces;
  TopExp::MapShapes(work, TopAbs_FACE, faces);
  std::vector<TopoDS_Shape> rebuilt;
  for (int i = 1; i <= faces.Extent(); ++i) {
    const TopoDS_Face &f = TopoDS::Face(faces.FindKey(i));
    TopoDS_Shape nf = f;
    GeomAbs_SurfaceType type = BRepAdaptor_Surface(f).GetType();
    if (type == GeomAbs_BSplineSurface || type == GeomAbs_BezierSurface) {
      Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
      Handle(Geom_Surface) ana = ShapeCustom_Surface(surf).ConvertToAnalytical(tol, false);
      if (!ana.IsNull()) {
        TopoDS_Wire outer = BRepTools::OuterWire(f);
        BRepBuilderAPI_MakeFace mf(ana, outer);
        for (TopExp_Explorer w(f, TopAbs_WIRE); w.More(); w.Next()) {
          if (!w.Current().IsSame(outer)) {
            mf.Add(TopoDS::Wire(w.Current()));
          }
        }
        if (mf.IsDone()) {
          ShapeFix_Face fix(mf.Face());
          fix.Perform();
          if (canonical_conversion_meshes(fix.Face())) {
            nf = fix.Face();
            ++converted;
          }
        }
      }
    }
    rebuilt.push_back(nf);
  }
  if (converted == 0) {
    return std::unique_ptr<TopoDS_Shape>();
  }
  BRepBuilderAPI_Sewing sew(tol > 1e-6 ? tol : 1e-6);
  for (const TopoDS_Shape &f : rebuilt) {
    sew.Add(f);
  }
  sew.Perform();
  ShapeFix_Shape fixer(sew.SewedShape());
  fixer.Perform();
  std::vector<TopoDS_Shape> solids;
  for (TopExp_Explorer ex(fixer.Shape(), TopAbs_SHELL); ex.More(); ex.Next()) {
    ShapeFix_Solid sf;
    solids.push_back(sf.SolidFromShell(TopoDS::Shell(ex.Current())));
  }
  if (solids.empty()) {
    return std::unique_ptr<TopoDS_Shape>();
  }
  if (solids.size() == 1) {
    return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(solids[0]));
  }
  TopoDS_Compound c;
  BRep_Builder b;
  b.MakeCompound(c);
  for (const TopoDS_Shape &s : solids) {
    b.Add(c, s);
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(c));
}
