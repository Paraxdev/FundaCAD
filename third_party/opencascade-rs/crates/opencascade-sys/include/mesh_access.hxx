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
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangulation.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_DataMapOfShapeShape.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>
#include <algorithm>
#include <cmath>
#include <memory>
#include <sstream>
#include <unordered_set>
#include <vector>

class MeshAccess {
public:
  // The shape that is meshed and read: the body, with a face TShape it holds
  // at several placements given a TShape of its own per placement.
  TopoDS_Shape shape;
  std::vector<TopoDS_Face> untied;
  TopTools_IndexedMapOfShape faceMap;
  // build123d's faces() keeps the first position but the last occurrence of a
  // face met twice by the explorer, and the orientation it carries decides the
  // winding flip.
  std::vector<TopoDS_Face> faces;
  TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
  std::vector<std::vector<TopoDS_Face>> edgeAncestors;

  MeshAccess() = default;
  MeshAccess(const MeshAccess &) = delete;
  MeshAccess &operator=(const MeshAccess &) = delete;
  // An untied face shares its edges with the body, which would keep the
  // face's mesh alive on them.
  ~MeshAccess() {
    for (const TopoDS_Face &f : untied) {
      try {
        BRepTools::Clean(f);
      } catch (...) {
      }
    }
  }
};

struct MeshUntie {
  std::unordered_set<const TopoDS_TShape *> seen;
  TopTools_DataMapOfShapeShape placed;
  std::vector<TopoDS_Face> made;
};

// `s` as its parent stores it, `up` the placement of that parent. A face keeps
// one triangulation per TShape, but BRepMesh discretises the edges of every
// placed copy on their own, and with a relative deflection (a share of the
// edge's axis aligned box) a turned copy gets another number of points. So the
// copies of a patterned body joined into this one would share the mesh of the
// last one meshed and not meet their neighbours. A copy gets a face TShape of
// its own over the same surface and the same edges.
inline TopoDS_Shape mesh_access_untie(const TopoDS_Shape &s, const TopLoc_Location &up, MeshUntie &st) {
  if (s.ShapeType() > TopAbs_FACE) {
    return s;
  }
  const TopLoc_Location here = up * s.Location();
  const auto rebuilt = [&](const std::vector<TopoDS_Shape> &kids) {
    BRep_Builder b;
    TopoDS_Shape c = s.EmptyCopied();
    c.Location(TopLoc_Location());
    c.Orientation(TopAbs_FORWARD);
    for (const TopoDS_Shape &k : kids) {
      b.Add(c, k);
    }
    c.Location(s.Location(), false);
    c.Orientation(s.Orientation());
    c.Closed(s.Closed());
    return c;
  };
  std::vector<TopoDS_Shape> kids;
  if (s.ShapeType() == TopAbs_FACE) {
    const TopoDS_Shape key = s.Located(here, false);
    if (const TopoDS_Shape *done = st.placed.Seek(key)) {
      return done->Located(s.Location(), false).Oriented(s.Orientation());
    }
    if (st.seen.insert(s.TShape().get()).second) {
      st.placed.Bind(key, s);
      return s;
    }
    for (TopoDS_Iterator it(s, false, false); it.More(); it.Next()) {
      kids.push_back(it.Value());
    }
    const TopoDS_Shape c = rebuilt(kids);
    st.placed.Bind(key, c);
    st.made.push_back(TopoDS::Face(c));
    return c;
  }
  bool changed = false;
  for (TopoDS_Iterator it(s, false, false); it.More(); it.Next()) {
    kids.push_back(mesh_access_untie(it.Value(), here, st));
    changed = changed || !kids.back().IsEqual(it.Value());
  }
  return changed ? rebuilt(kids) : s;
}

inline std::unique_ptr<MeshAccess> mesh_access_new(const TopoDS_Shape &shape) {
  std::unique_ptr<MeshAccess> m(new MeshAccess());
  m->shape = shape;
  try {
    MeshUntie st;
    const TopoDS_Shape own = mesh_access_untie(shape, TopLoc_Location(), st);
    m->shape = own;
    m->untied = st.made;
  } catch (...) {
    m->shape = shape;
  }
  try {
    for (TopExp_Explorer ex(m->shape, TopAbs_FACE); ex.More(); ex.Next()) {
      const TopoDS_Face &f = TopoDS::Face(ex.Current());
      Standard_Integer i = m->faceMap.FindIndex(f);
      if (i == 0) {
        m->faceMap.Add(f);
        m->faces.push_back(f);
      } else {
        m->faces[i - 1] = f;
      }
    }
    TopExp::MapShapesAndAncestors(m->shape, TopAbs_EDGE, TopAbs_FACE, m->edgeFaces);
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

inline bool mesh_access_mesh(const MeshAccess &m, double linear, bool relative, double angular, bool parallel,
                             bool clean_first) {
  try {
    if (clean_first) {
      BRepTools::Clean(m.shape);
    }
    BRepMesh_IncrementalMesh mesher(m.shape, linear, relative, angular, parallel);
    return mesher.IsDone();
  } catch (...) {
    return false;
  }
}

inline bool mesh_access_has_mesh(const MeshAccess &m) {
  for (const TopoDS_Face &f : m.faces) {
    TopLoc_Location loc;
    if (!BRep_Tool::Triangulation(f, loc).IsNull()) {
      return true;
    }
  }
  return false;
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

// Where the faces along an edge hold different points for the same step of the
// edge's polygon, the two points as [x y z x y z], placed like the nodes of
// mesh_access_face_triangulation. BRepMesh discretises an edge once, but every
// face then merges the boundary nodes that fall within its own UV tolerance of
// each other, so along an edge shorter than that the faces stop agreeing. A
// seam has one polygon per side, and both are read.
//
// `uneven` counts the edges whose faces hold polygons of different lengths.
// BRepMesh keeps a stored face mesh that is fine enough and judges every face
// alone, so once another body sharing some of these faces was meshed at
// another deflection, a kept face and a remeshed one disagree along their edge.
//
// A folded polygon gets its distance off the edge recorded as its deflection:
// BRepCheck holds every stored polygon to the deflection it claims, and calls
// the meshed shape invalid over a fold the mesher left unrecorded.
inline bool mesh_access_edge_splits(const MeshAccess &m, rust::Vec<double> &out, int32_t &uneven) {
  uneven = 0;
  try {
    struct Side {
      Handle(Poly_PolygonOnTriangulation) poly;
      Handle(Poly_Triangulation) tri;
      gp_Trsf trsf;
      bool ident;
    };
    const auto point = [](const Side &s, Standard_Integer k) {
      gp_Pnt p = s.tri->Node(s.poly->Node(k));
      if (!s.ident) {
        p.Transform(s.trsf);
      }
      return p;
    };
    const auto record = [&](const Side &s, const TopoDS_Shape &e) {
      BRepAdaptor_Curve curve(TopoDS::Edge(e));
      if (!s.poly->HasParameters() || !curve.Is3DCurve()) {
        return;
      }
      double off = 0.0;
      for (Standard_Integer k = 1; k <= s.poly->NbNodes(); ++k) {
        off = std::max(off, point(s, k).Distance(curve.Value(s.poly->Parameter(k))));
      }
      if (off > s.poly->Deflection()) {
        s.poly->Deflection(off);
      }
    };
    std::vector<Side> sides;
    for (Standard_Integer i = 1; i <= m.edgeFaces.Extent(); ++i) {
      const TopoDS_Shape &e = m.edgeFaces.FindKey(i);
      sides.clear();
      bool differ = false, apart = false, folded = false;
      for (const TopoDS_Face &f : m.edgeAncestors.at(i - 1)) {
        TopLoc_Location loc;
        const Handle(Poly_Triangulation) &tri = BRep_Tool::Triangulation(f, loc);
        if (tri.IsNull()) {
          continue;
        }
        for (TopAbs_Orientation o : {TopAbs_FORWARD, TopAbs_REVERSED}) {
          const Handle(Poly_PolygonOnTriangulation) &poly =
              BRep_Tool::PolygonOnTriangulation(TopoDS::Edge(e.Oriented(o)), tri, loc);
          if (poly.IsNull()) {
            continue;
          }
          bool skip = false;
          for (const Side &s : sides) {
            skip = skip || s.poly == poly;
          }
          // Node() does not check its index in a release kernel.
          for (Standard_Integer k = 1; k <= poly->NbNodes(); ++k) {
            skip = skip || poly->Node(k) < 1 || poly->Node(k) > tri->NbNodes();
          }
          if (!skip) {
            for (Standard_Integer k = 2; k <= poly->NbNodes(); ++k) {
              folded = folded || poly->Node(k) == poly->Node(k - 1);
            }
            sides.push_back({poly, tri, loc.Transformation(), loc.IsIdentity()});
          }
        }
      }
      for (size_t j = 1; j < sides.size(); ++j) {
        const Standard_Integer n = sides[0].poly->NbNodes();
        if (sides[j].poly->NbNodes() != n) {
          differ = true;
          continue;
        }
        for (Standard_Integer k = 1; k <= n; ++k) {
          const gp_Pnt a = point(sides[0], k), b = point(sides[j], k);
          if (a.X() != b.X() || a.Y() != b.Y() || a.Z() != b.Z()) {
            apart = true;
            for (double v : {a.X(), a.Y(), a.Z(), b.X(), b.Y(), b.Z()}) {
              out.push_back(v);
            }
          }
        }
      }
      uneven += differ ? 1 : 0;
      if (apart || folded) {
        for (const Side &s : sides) {
          record(s, e);
        }
      }
    }
    return true;
  } catch (...) {
    return false;
  }
}

// Every face the mesher left without triangles, or with fewer than can fill
// its outline (a mesh that uses its n nodes has n - 2 triangles or more), as
// [d n x y z ...]: the diagonal of the face's own box, then the n points it
// and the faces around it hold along its edges, placed like the nodes of
// mesh_access_face_triangulation. The box is the surface's, a face can be far
// larger than its outline.
inline bool mesh_access_unfilled_faces(const MeshAccess &m, rust::Vec<double> &out) {
  try {
    std::vector<double> pts;
    for (const TopoDS_Face &f : m.faces) {
      TopLoc_Location own;
      const Handle(Poly_Triangulation) &mine = BRep_Tool::Triangulation(f, own);
      if (!mine.IsNull() && mine->NbTriangles() >= mine->NbNodes() - 2) {
        continue;
      }
      Bnd_Box box;
      BRepBndLib::Add(f, box, false);
      if (box.IsVoid() || box.IsOpen()) {
        continue;
      }
      pts.clear();
      if (!mine.IsNull()) {
        const gp_Trsf trsf = own.Transformation();
        for (Standard_Integer k = 1; k <= mine->NbNodes(); ++k) {
          const gp_Pnt p = mine->Node(k).Transformed(trsf);
          pts.insert(pts.end(), {p.X(), p.Y(), p.Z()});
        }
      }
      for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More(); ex.Next()) {
        const Standard_Integer i = m.edgeFaces.FindIndex(ex.Current());
        if (i == 0) {
          continue;
        }
        for (const TopoDS_Face &g : m.edgeAncestors.at(i - 1)) {
          TopLoc_Location loc;
          const Handle(Poly_Triangulation) &tri = BRep_Tool::Triangulation(g, loc);
          if (tri.IsNull() || g.IsSame(f)) {
            continue;
          }
          const gp_Trsf trsf = loc.Transformation();
          for (TopAbs_Orientation o : {TopAbs_FORWARD, TopAbs_REVERSED}) {
            const Handle(Poly_PolygonOnTriangulation) &poly =
                BRep_Tool::PolygonOnTriangulation(TopoDS::Edge(ex.Current().Oriented(o)), tri, loc);
            if (poly.IsNull()) {
              continue;
            }
            for (Standard_Integer k = 1; k <= poly->NbNodes(); ++k) {
              if (poly->Node(k) < 1 || poly->Node(k) > tri->NbNodes()) {
                continue;
              }
              const gp_Pnt p = tri->Node(poly->Node(k)).Transformed(trsf);
              pts.insert(pts.end(), {p.X(), p.Y(), p.Z()});
            }
          }
        }
      }
      out.push_back(std::sqrt(box.SquareExtent()));
      out.push_back(static_cast<double>(pts.size() / 3));
      for (double v : pts) {
        out.push_back(v);
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
