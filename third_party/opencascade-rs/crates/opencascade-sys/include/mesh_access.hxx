#pragma once
// Bulk readback for the viewport mesh (fundacad-geom::mesh): whole face
// triangulations and per-edge queries in one call each, so meshing a body is
// not one FFI round trip per node. Every OCCT exception is caught here and
// reported as a false return, Standard_Failure is not a std::exception.

#include "rust/cxx.h"
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Curve2d.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepLib_ToolTriangulatedShape.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_QuasiUniformDeflection.hxx>
#include <Poly_Triangulation.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>
#include <cmath>
#include <memory>
#include <sstream>
#include <vector>

class MeshAccess {
public:
  TopoDS_Shape shape;
  TopTools_IndexedMapOfShape faceMap;
  // build123d's faces() keeps the first position but the last occurrence of a
  // face met twice by the explorer, and the orientation it carries decides the
  // winding flip.
  std::vector<TopoDS_Face> faces;
  TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
  std::vector<std::vector<TopoDS_Face>> edgeAncestors;
};

inline std::unique_ptr<MeshAccess> mesh_access_new(const TopoDS_Shape &shape) {
  std::unique_ptr<MeshAccess> m(new MeshAccess());
  m->shape = shape;
  try {
    for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
      const TopoDS_Face &f = TopoDS::Face(ex.Current());
      Standard_Integer i = m->faceMap.FindIndex(f);
      if (i == 0) {
        m->faceMap.Add(f);
        m->faces.push_back(f);
      } else {
        m->faces[i - 1] = f;
      }
    }
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, m->edgeFaces);
    for (Standard_Integer i = 1; i <= m->edgeFaces.Extent(); ++i) {
      std::vector<TopoDS_Face> anc;
      for (const TopoDS_Shape &s : m->edgeFaces.FindFromIndex(i)) {
        anc.push_back(TopoDS::Face(s));
      }
      m->edgeAncestors.push_back(anc);
    }
  } catch (...) {
    m->faceMap.Clear();
    m->faces.clear();
    m->edgeFaces.Clear();
    m->edgeAncestors.clear();
  }
  return m;
}

inline bool mesh_access_mesh(const TopoDS_Shape &shape, double linear, bool relative, double angular, bool parallel,
                             bool clean_first) {
  try {
    if (clean_first) {
      BRepTools::Clean(shape);
    }
    BRepMesh_IncrementalMesh mesher(shape, linear, relative, angular, parallel);
    return mesher.IsDone();
  } catch (...) {
    return false;
  }
}

inline std::unique_ptr<TopoDS_Shape> mesh_access_read_brep(rust::Str text) {
  try {
    std::istringstream in(std::string(text.data(), text.size()));
    BRep_Builder builder;
    std::unique_ptr<TopoDS_Shape> shape(new TopoDS_Shape());
    BRepTools::Read(*shape, in, builder);
    if (shape->IsNull()) {
      return std::unique_ptr<TopoDS_Shape>();
    }
    return shape;
  } catch (...) {
    return std::unique_ptr<TopoDS_Shape>();
  }
}

inline bool mesh_access_bnd_box(const TopoDS_Shape &shape, rust::Vec<double> &out) {
  try {
    Bnd_Box box;
    BRepBndLib::Add(shape, box, true);
    if (box.IsVoid()) {
      return false;
    }
    double xm, ym, zm, xM, yM, zM;
    box.Get(xm, ym, zm, xM, yM, zM);
    for (double v : {xm, ym, zm, xM, yM, zM}) {
      out.push_back(v);
    }
    return true;
  } catch (...) {
    return false;
  }
}

inline int32_t mesh_access_face_count(const MeshAccess &m) { return static_cast<int32_t>(m.faces.size()); }

inline bool mesh_access_face_reversed(const MeshAccess &m, int32_t face) {
  return m.faces.at(face).Orientation() == TopAbs_REVERSED;
}

// The plane's axis direction when the face is planar, the exact normal the
// coplanar seam test compares.
inline bool mesh_access_face_plane_normal(const MeshAccess &m, int32_t face, rust::Vec<double> &out) {
  try {
    BRepAdaptor_Surface surf(m.faces.at(face));
    if (surf.GetType() != GeomAbs_Plane) {
      return false;
    }
    // By value: Plane() returns a temporary gp_Pln, so a reference into it
    // dangles at the end of this statement.
    const gp_Dir d = surf.Plane().Axis().Direction();
    out.push_back(d.X());
    out.push_back(d.Y());
    out.push_back(d.Z());
    return true;
  } catch (...) {
    return false;
  }
}

// Nodes placed in world space and 0-based triangles as stored. With
// `with_normals` the surface normals are computed onto the triangulation first
// and placed like the nodes; they follow the surface, not the face orientation.
inline bool mesh_access_face_triangulation(const MeshAccess &m, int32_t face, bool with_normals,
                                           rust::Vec<double> &nodes, rust::Vec<int32_t> &tris,
                                           rust::Vec<double> &normals) {
  try {
    const TopoDS_Face &f = m.faces.at(face);
    TopLoc_Location loc;
    const Handle(Poly_Triangulation) &tri = BRep_Tool::Triangulation(f, loc);
    if (tri.IsNull()) {
      return false;
    }
    const bool ident = loc.IsIdentity();
    const gp_Trsf trsf = loc.Transformation();
    const Standard_Integer n = tri->NbNodes();
    nodes.reserve(3 * n);
    for (Standard_Integer i = 1; i <= n; ++i) {
      gp_Pnt p = tri->Node(i);
      if (!ident) {
        p.Transform(trsf);
      }
      nodes.push_back(p.X());
      nodes.push_back(p.Y());
      nodes.push_back(p.Z());
    }
    const Standard_Integer nt = tri->NbTriangles();
    tris.reserve(3 * nt);
    for (Standard_Integer i = 1; i <= nt; ++i) {
      Standard_Integer a, b, c;
      tri->Triangle(i).Get(a, b, c);
      tris.push_back(a - 1);
      tris.push_back(b - 1);
      tris.push_back(c - 1);
    }
    if (with_normals) {
      BRepLib_ToolTriangulatedShape::ComputeNormals(f, tri);
      if (tri->HasNormals()) {
        normals.reserve(3 * n);
        for (Standard_Integer i = 1; i <= n; ++i) {
          gp_Dir d = tri->Normal(i);
          if (!ident) {
            d.Transform(trsf);
          }
          normals.push_back(d.X());
          normals.push_back(d.Y());
          normals.push_back(d.Z());
        }
      }
    }
    return true;
  } catch (...) {
    return false;
  }
}

inline int32_t mesh_access_edge_count(const MeshAccess &m) { return static_cast<int32_t>(m.edgeAncestors.size()); }

// The face index of every entry in the edge's ancestor list, a seam's face
// listed once per side.
inline void mesh_access_edge_faces(const MeshAccess &m, int32_t edge, rust::Vec<int32_t> &out) {
  for (const TopoDS_Face &f : m.edgeAncestors.at(edge)) {
    out.push_back(m.faceMap.FindIndex(f) - 1);
  }
}

inline const TopoDS_Edge &mesh_access_edge(const MeshAccess &m, int32_t edge) {
  return TopoDS::Edge(m.edgeFaces.FindKey(edge + 1));
}

inline bool mesh_access_edge_degenerated(const MeshAccess &m, int32_t edge) {
  try {
    return BRep_Tool::Degenerated(mesh_access_edge(m, edge));
  } catch (...) {
    return false;
  }
}

inline bool mesh_access_edge_closed_on(const MeshAccess &m, int32_t edge, int32_t ancestor) {
  try {
    return BRep_Tool::IsClosed(mesh_access_edge(m, edge), m.edgeAncestors.at(edge).at(ancestor));
  } catch (...) {
    return false;
  }
}

// 1 a line with its two endpoints in `out`, 0 another curve, -1 no usable curve.
inline int32_t mesh_access_edge_line(const MeshAccess &m, int32_t edge, rust::Vec<double> &out) {
  try {
    BRepAdaptor_Curve ad(mesh_access_edge(m, edge));
    if (ad.GetType() != GeomAbs_Line) {
      return 0;
    }
    for (double u : {ad.FirstParameter(), ad.LastParameter()}) {
      gp_Pnt p = ad.Value(u);
      out.push_back(p.X());
      out.push_back(p.Y());
      out.push_back(p.Z());
    }
    return 1;
  } catch (...) {
    return -1;
  }
}

inline bool mesh_access_edge_range(const MeshAccess &m, int32_t edge, double &first, double &last) {
  try {
    BRepAdaptor_Curve ad(mesh_access_edge(m, edge));
    first = ad.FirstParameter();
    last = ad.LastParameter();
    return true;
  } catch (...) {
    return false;
  }
}

inline bool mesh_access_edge_values(const MeshAccess &m, int32_t edge, rust::Slice<const double> params,
                                    rust::Vec<double> &out) {
  try {
    BRepAdaptor_Curve ad(mesh_access_edge(m, edge));
    for (double u : params) {
      gp_Pnt p = ad.Value(u);
      out.push_back(p.X());
      out.push_back(p.Y());
      out.push_back(p.Z());
    }
    return true;
  } catch (...) {
    return false;
  }
}

// GCPnts_QuasiUniformDeflection over the adaptor's own range: every point and
// its parameter, false when the range is empty or the algorithm fails.
inline bool mesh_access_edge_deflection(const MeshAccess &m, int32_t edge, double deflection,
                                        rust::Vec<double> &points, rust::Vec<double> &params) {
  try {
    BRepAdaptor_Curve ad(mesh_access_edge(m, edge));
    const double u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    if (!(u1 > u0)) {
      return false;
    }
    GCPnts_QuasiUniformDeflection alg(ad, deflection, u0, u1);
    if (!alg.IsDone()) {
      return false;
    }
    for (Standard_Integer i = 1; i <= alg.NbPoints(); ++i) {
      gp_Pnt p = alg.Value(i);
      points.push_back(p.X());
      points.push_back(p.Y());
      points.push_back(p.Z());
      params.push_back(alg.Parameter(i));
    }
    return true;
  } catch (...) {
    return false;
  }
}

// _meets_smoothly of the Python engine's `tessellate.py`, whole: whether the two ancestor
// faces share a tangent plane along the edge, sampled at the middle first so a
// crease costs one sample. The adaptors are built once for all three samples,
// which is where this earns its place over the per-sample normal call below.
// 1 smooth, 0 not, -1 the query raised.
inline int32_t mesh_access_edge_smooth(const MeshAccess &m, int32_t edge, double cos_tol) {
  try {
    const std::vector<TopoDS_Face> &anc = m.edgeAncestors.at(edge);
    if (anc.size() < 2) {
      return 0;
    }
    const TopoDS_Edge &e = mesh_access_edge(m, edge);
    BRepAdaptor_Curve2d pcurve[2] = {BRepAdaptor_Curve2d(e, anc[0]), BRepAdaptor_Curve2d(e, anc[1])};
    // Unrestricted: the restricted form computes the face's UV bounds, which
    // walks every edge of the face, and D1 never looks at them.
    BRepAdaptor_Surface surf[2] = {BRepAdaptor_Surface(anc[0], false), BRepAdaptor_Surface(anc[1], false)};
    double t0 = 0.0, t1 = 0.0;
    BRep_Tool::Range(e, t0, t1);
    const double fracs[3] = {0.5, 0.15, 0.85};
    for (double frac : fracs) {
      const double t = t0 + (t1 - t0) * frac;
      double n[2][3];
      for (int k = 0; k < 2; ++k) {
        gp_Pnt2d uv = pcurve[k].Value(t);
        gp_Pnt p;
        gp_Vec du, dv;
        surf[k].D1(uv.X(), uv.Y(), p, du, dv);
        gp_Vec cr = du.Crossed(dv);
        const double mag = std::sqrt(cr.X() * cr.X() + cr.Y() * cr.Y() + cr.Z() * cr.Z());
        if (mag < 1e-12) {
          return 0;
        }
        n[k][0] = cr.X() / mag;
        n[k][1] = cr.Y() / mag;
        n[k][2] = cr.Z() / mag;
      }
      const double d = n[0][0] * n[1][0] + n[0][1] * n[1][1] + n[0][2] * n[1][2];
      if (std::abs(d) < cos_tol) {
        return 0;
      }
    }
    return 1;
  } catch (...) {
    return -1;
  }
}

inline bool mesh_access_edge_brep_range(const MeshAccess &m, int32_t edge, double &first, double &last) {
  try {
    BRep_Tool::Range(mesh_access_edge(m, edge), first, last);
    return true;
  } catch (...) {
    return false;
  }
}

// The unnormalised surface normal du x dv of an ancestor face at edge parameter
// `t`, read through the edge's pcurve on that face.
inline bool mesh_access_edge_face_normal(const MeshAccess &m, int32_t edge, int32_t ancestor, double t,
                                         rust::Vec<double> &out) {
  try {
    const TopoDS_Face &f = m.edgeAncestors.at(edge).at(ancestor);
    BRepAdaptor_Curve2d pc(mesh_access_edge(m, edge), f);
    BRepAdaptor_Surface surf(f);
    gp_Pnt2d uv = pc.Value(t);
    gp_Pnt p;
    gp_Vec du, dv;
    surf.D1(uv.X(), uv.Y(), p, du, dv);
    gp_Vec n = du.Crossed(dv);
    out.push_back(n.X());
    out.push_back(n.Y());
    out.push_back(n.Z());
    return true;
  } catch (...) {
    return false;
  }
}
