// Fillets and chamfers as the Python engine's `blends.py` drives them, one call each from Rust.
#pragma once
#include "rust/cxx.h"
#include <bindings_common.hxx>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <ElSLib.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Geom_Surface.hxx>
#include <Poly_Triangulation.hxx>
#include <Standard_Failure.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopTools_MapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>
#include <gp_XY.hxx>

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <memory>
#include <utility>
#include <vector>

using BlShape = std::unique_ptr<TopoDS_Shape>;
using BlShapes = std::unique_ptr<std::vector<TopoDS_Shape>>;

inline std::vector<TopoDS_Shape> bl_children(const TopoDS_Shape &s) {
  std::vector<TopoDS_Shape> out;
  if (s.IsNull()) return out;
  for (TopoDS_Iterator it(s); it.More(); it.Next()) out.push_back(it.Value());
  return out;
}

// BRepFilletAPI can close the seam between two surface pieces of one round
// with an edge flagged degenerated whose ends on its face lie millimetres
// apart, one vertex as wide as the gap standing in for both. BRepCheck takes
// it, but a mesher fans every face there to that vertex. Each such edge gets a
// vertex at each end; a true pole has both ends on one point and stays.
inline TopoDS_Shape bl_split_false_degenerate(const TopoDS_Shape &shape) {
  const double tol = 1e-4;
  const double shortest = 1e-2;
  try {
    TopTools_IndexedDataMapOfShapeListOfShape e2f, v2e;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, e2f);
    TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_EDGE, v2e);
    BRep_Builder bb;
    BRepTools_ReShape rs;
    TopTools_MapOfShape touched;
    bool split = false;
    for (int i = 1; i <= e2f.Extent(); ++i) {
      const TopoDS_Edge &ed = TopoDS::Edge(e2f.FindKey(i));
      if (!BRep_Tool::Degenerated(ed) || e2f.FindFromIndex(i).IsEmpty()) continue;
      const TopoDS_Face &f = TopoDS::Face(e2f.FindFromIndex(i).First());
      BRepAdaptor_Curve c(ed, f);
      const double t0 = c.FirstParameter(), t1 = c.LastParameter();
      const gp_Pnt p0 = c.Value(t0), p1 = c.Value(t1);
      if (p0.Distance(p1) <= std::max(shortest, 10.0 * BRep_Tool::Tolerance(ed))) continue;
      const TopoDS_Vertex v = TopExp::FirstVertex(ed);
      if (v.IsNull() || !v.IsSame(TopExp::LastVertex(ed)) || touched.Contains(v)) continue;
      const TopTools_ListOfShape &around = v2e.FindFromKey(v);
      bool clean = true;
      for (TopTools_ListOfShape::Iterator it(around); it.More() && clean; it.Next()) {
        const TopoDS_Edge &oe = TopoDS::Edge(it.Value());
        if (oe.IsSame(ed)) continue;
        clean = !BRep_Tool::Degenerated(oe) && !touched.Contains(oe) &&
                !TopExp::FirstVertex(oe).IsSame(TopExp::LastVertex(oe));
      }
      if (!clean) continue;

      TopoDS_Vertex va, vb;
      bb.MakeVertex(va, p0, tol);
      bb.MakeVertex(vb, p1, tol);
      TopoDS_Edge ne = TopoDS::Edge(ed.EmptyCopied().Oriented(TopAbs_FORWARD));
      bb.Degenerated(ne, false);
      bb.Add(ne, va.Oriented(TopAbs_FORWARD));
      bb.Add(ne, vb.Oriented(TopAbs_REVERSED));
      bb.UpdateVertex(va, t0, ne, tol);
      bb.UpdateVertex(vb, t1, ne, tol);
      if (!BRepLib::BuildCurve3d(ne, 1e-5)) continue;

      std::vector<std::pair<TopoDS_Shape, TopoDS_Shape>> swaps{{ed.Oriented(TopAbs_FORWARD), ne}};
      for (TopTools_ListOfShape::Iterator it(around); it.More(); it.Next()) {
        const TopoDS_Edge &oe = TopoDS::Edge(it.Value());
        if (oe.IsSame(ed)) continue;
        BRepAdaptor_Curve cc(oe);
        TopoDS_Edge n2 = TopoDS::Edge(oe.EmptyCopied().Oriented(TopAbs_FORWARD));
        for (TopExp_Explorer x(oe.Oriented(TopAbs_FORWARD), TopAbs_VERTEX); x.More(); x.Next()) {
          const TopoDS_Vertex &ov = TopoDS::Vertex(x.Current());
          if (!ov.IsSame(v)) {
            bb.Add(n2, ov);
            continue;
          }
          const double par = BRep_Tool::Parameter(ov, oe);
          const gp_Pnt q = cc.Value(par);
          const TopoDS_Vertex &nv = q.Distance(p0) < q.Distance(p1) ? va : vb;
          bb.Add(n2, nv.Oriented(ov.Orientation()));
          bb.UpdateVertex(nv, par, n2, tol);
        }
        swaps.emplace_back(oe.Oriented(TopAbs_FORWARD), n2);
      }
      for (const auto &s : swaps) {
        rs.Replace(s.first, s.second);
        touched.Add(s.first);
      }
      touched.Add(v);
      split = true;
    }
    if (!split) return shape;
    TopoDS_Shape out = rs.Apply(shape);
    BRepLib::SameParameter(out, 1e-5, false);
    BRepLib::UpdateTolerances(out, false);
    if (!BRepCheck_Analyzer(out).IsValid()) return shape;
    return out;
  } catch (const Standard_Failure &) {
    return shape;
  }
}

// status: 0 built, 1 not done, 2 built but BRepCheck calls it invalid. Not
// done hands back a compound of the vertices the kernel gave up at.
inline BlShape blend_fillet(const TopoDS_Shape &shape, const TopoDS_Shape &edges,
                            rust::Slice<const double> radii, int32_t &status) {
  BRepFilletAPI_MakeFillet mk(shape);
  std::vector<TopoDS_Shape> es = bl_children(edges);
  for (size_t i = 0; i < es.size() && i < radii.size(); ++i) mk.Add(radii[i], TopoDS::Edge(es[i]));
  mk.Build();
  if (!mk.IsDone()) {
    status = 1;
    TopoDS_Compound at;
    BRep_Builder b;
    b.MakeCompound(at);
    for (int i = 1; i <= mk.NbFaultyVertices(); ++i) b.Add(at, mk.FaultyVertex(i));
    return BlShape(new TopoDS_Shape(at));
  }
  TopoDS_Shape out = bl_split_false_degenerate(mk.Shape());
  status = BRepCheck_Analyzer(out).IsValid() ? 0 : 2;
  return BlShape(new TopoDS_Shape(out));
}

// --- the faces a two distance chamfer puts d1 on -------------------------------

// The ancestor map lists each Z edge of a box with its X face first, so d1 there put 12 + 12 on
// both 20 mm Y faces at 3/12, where 12 at one corner of each face and 3 at the other fits.
enum BlSidesKind { BL_SIDES_MAP, BL_SIDES_MAP_FITS, BL_SIDES_FIT, BL_SIDES_TOUCH, BL_SIDES_NONE };

// `concave`: with no fit, a concave edge on a face map order runs past, which the section build
// would clamp or cross unseen.
struct BlSides {
  int kind = BL_SIDES_MAP;
  std::vector<char> second;
  int concave = -1;
};

struct BlSeg {
  gp_XY a, b, in;
  int nb[2] = {-1, -1};
  int edge = -1;
  bool first = false;
};

struct BlFace {
  std::vector<BlSeg> segs;
  std::vector<int> edges;
  bool convex = true;
};

inline gp_XY bl_on(const gp_Pln &pln, const gp_Pnt &p) {
  double u, v;
  ElSLib::Parameters(pln, p, u, v);
  return gp_XY(u, v);
}

inline double bl_point_seg(const gp_XY &p, const gp_XY &a, const gp_XY &b) {
  gp_XY ab = b - a;
  double l2 = ab.SquareModulus();
  double t = l2 > 0 ? std::min(1.0, std::max(0.0, (p - a).Dot(ab) / l2)) : 0.0;
  return (p - (a + ab * t)).Modulus();
}

// 0 apart, 1 within tol, 2 crossing deeper than tol.
inline int bl_segs_meet(const gp_XY &a, const gp_XY &b, const gp_XY &c, const gp_XY &d, double tol) {
  double gap = std::min(std::min(bl_point_seg(a, c, d), bl_point_seg(b, c, d)),
                        std::min(bl_point_seg(c, a, b), bl_point_seg(d, a, b)));
  if (gap <= tol) return 1;
  double o1 = (b - a).Crossed(c - a), o2 = (b - a).Crossed(d - a);
  double o3 = (d - c).Crossed(a - c), o4 = (d - c).Crossed(b - c);
  bool cross = ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
  return cross ? 2 : 0;
}

// Each edge moved in by its setback, an unchamfered one a trace runs past cut away whole: 0 when every
// moved edge keeps its length clear of those it does not meet, 1 when some just touch, 2 when they cross.
inline int bl_face_fit(const BlFace &f, const std::vector<double> &off, double tol) {
  size_t n = f.segs.size();
  std::vector<gp_XY> x0(n), x1(n), dir(n);
  std::vector<std::array<int, 2>> nb(n);
  std::vector<char> gone(n, 0);
  for (size_t i = 0; i < n; ++i) {
    dir[i] = (f.segs[i].b - f.segs[i].a).Normalized();
    nb[i] = {f.segs[i].nb[0], f.segs[i].nb[1]};
  }
  for (;;) {
    for (size_t i = 0; i < n; ++i) {
      if (gone[i]) continue;
      gp_XY p = f.segs[i].a + f.segs[i].in * off[i];
      for (int k = 0; k < 2; ++k) {
        int j = nb[i][k];
        double c = dir[i].Crossed(dir[j]);
        gp_XY q = f.segs[j].a + f.segs[j].in * off[j];
        if (std::abs(c) < 1e-9 && j != f.segs[i].nb[k]) return 2;
        (k == 0 ? x0 : x1)[i] = std::abs(c) < 1e-9 ? (k == 0 ? f.segs[i].a : f.segs[i].b)
                                                   : p + dir[i] * ((q - p).Crossed(dir[j]) / c);
      }
    }
    int drop = -1;
    for (size_t i = 0; i < n && drop < 0; ++i)
      if (!gone[i] && off[i] <= 0 && (x1[i] - x0[i]).Dot(dir[i]) < -tol) drop = (int)i;
    if (drop < 0) break;
    gone[drop] = 1;
    int a = nb[drop][0], b = nb[drop][1];
    if (a == b) return 2;
    nb[a][nb[a][0] == drop ? 0 : 1] = b;
    nb[b][nb[b][0] == drop ? 0 : 1] = a;
    if (nb[a][0] == nb[a][1]) return 2;
  }
  int worst = 0;
  for (size_t i = 0; i < n; ++i) {
    if (gone[i]) continue;
    double len = (x1[i] - x0[i]).Dot(dir[i]);
    if (len < -tol) return 2;
    if (len <= tol) worst = 1;
  }
  std::vector<char> moved(n);
  for (size_t i = 0; i < n; ++i) moved[i] = !gone[i] && (off[i] > 0 || off[nb[i][0]] > 0 || off[nb[i][1]] > 0);
  for (size_t i = 0; i < n; ++i) {
    if (!moved[i]) continue;
    for (size_t k = 0; k < n; ++k) {
      if (k == i || gone[k] || (moved[k] && k < i) || (int)k == nb[i][0] || (int)k == nb[i][1]) continue;
      int got = bl_segs_meet(x0[i], x1[i], x0[k], x1[k], tol);
      if (got == 2) return 2;
      worst = std::max(worst, got);
    }
  }
  return worst;
}

// `second` puts d1 on the map's last face. Map order stays wherever it fits; only straight edged planes are judged.
// Setbacks may just meet unless a concave fill meets another chamfer, which the section build never checks.
inline BlSides bl_chamfer_sides(const TopoDS_Shape &shape, const std::vector<TopoDS_Shape> &es,
                                const std::vector<double> &d1, const std::vector<double> &d2) {
  BlSides out;
  size_t m = es.size();
  out.second.assign(m, 0);
  if (d1.size() < m || d2.size() < m) return out;
  bool uneven = false;
  for (size_t i = 0; i < m; ++i) uneven = uneven || d1[i] != d2[i];
  if (!uneven) return out;
  try {
    TopTools_IndexedDataMapOfShapeListOfShape anc;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, anc);
    TopTools_IndexedMapOfShape face_ids;
    std::vector<std::array<int, 2>> on(m), seg_at(m, std::array<int, 2>{-1, -1});
    double tol = 1e-6;
    for (size_t i = 0; i < m; ++i) {
      int idx = anc.FindIndex(es[i]);
      if (idx == 0) return out;
      const TopTools_ListOfShape &l = anc.FindFromIndex(idx);
      if (l.Size() != 2 || l.First().IsSame(l.Last())) return out;
      if (BRepAdaptor_Curve(TopoDS::Edge(es[i])).GetType() != GeomAbs_Line) return out;
      on[i] = {face_ids.Add(l.First()) - 1, face_ids.Add(l.Last()) - 1};
      tol = std::max(tol, 10 * BRep_Tool::Tolerance(TopoDS::Edge(es[i])));
    }
    std::vector<BlFace> faces(face_ids.Extent());
    std::vector<gp_Pln> plns;
    for (int fi = 0; fi < face_ids.Extent(); ++fi) {
      const TopoDS_Face &F = TopoDS::Face(face_ids(fi + 1));
      BRepAdaptor_Surface sf(F);
      if (sf.GetType() != GeomAbs_Plane) return out;
      plns.push_back(sf.Plane());
      BlFace &f = faces[fi];
      TopTools_IndexedMapOfShape seen;
      std::vector<std::array<TopoDS_Vertex, 2>> vs;
      for (TopExp_Explorer ex(F, TopAbs_EDGE); ex.More(); ex.Next()) {
        const TopoDS_Edge &E = TopoDS::Edge(ex.Current());
        if (seen.Contains(E) || BRep_Tool::Degenerated(E)) return out;
        seen.Add(E);
        if (BRepAdaptor_Curve(E).GetType() != GeomAbs_Line) return out;
        TopoDS_Vertex v0, v1;
        TopExp::Vertices(E, v0, v1);
        if (v0.IsNull() || v1.IsNull() || v0.IsSame(v1)) return out;
        BlSeg s;
        s.a = bl_on(plns.back(), BRep_Tool::Pnt(v0));
        s.b = bl_on(plns.back(), BRep_Tool::Pnt(v1));
        if ((s.b - s.a).Modulus() <= tol) return out;
        for (size_t i = 0; i < m; ++i)
          if (es[i].IsSame(E)) {
            s.edge = (int)i;
            s.first = on[i][0] == fi;
            seg_at[i][s.first ? 0 : 1] = (int)f.segs.size();
          }
        f.segs.push_back(s);
        vs.push_back({v0, v1});
      }
      size_t n = f.segs.size();
      if (n > 256) return out;
      for (size_t i = 0; i < n; ++i)
        for (int k = 0; k < 2; ++k) {
          for (size_t j = 0; j < n; ++j) {
            if (j == i || !(vs[j][0].IsSame(vs[i][k]) || vs[j][1].IsSame(vs[i][k]))) continue;
            if (f.segs[i].nb[k] >= 0) return out;
            f.segs[i].nb[k] = (int)j;
          }
          int j = f.segs[i].nb[k];
          if (j < 0) return out;
          gp_XY u = (f.segs[i].b - f.segs[i].a).Normalized(), w = (f.segs[j].b - f.segs[j].a).Normalized();
          if (std::abs(u.Crossed(w)) < 1e-9 && (f.segs[i].edge >= 0 || f.segs[j].edge >= 0)) return out;
        }
      double step = std::max(1e-4, 20 * tol);
      for (BlSeg &s : f.segs) {
        if (s.edge < 0) continue;
        f.edges.push_back(s.edge);
        gp_XY d = (s.b - s.a).Normalized(), in(-d.Y(), d.X()), mid = (s.a + s.b) * 0.5;
        auto inside = [&](const gp_XY &p) {
          return BRepClass_FaceClassifier(F, gp_Pnt2d(p), tol).State() == TopAbs_IN;
        };
        if (inside(mid + in * step)) s.in = in;
        else if (inside(mid - in * step)) s.in = -in;
        else return out;
      }
    }
    std::vector<char> concave(m, 0);
    for (size_t i = 0; i < m; ++i) {
      if (seg_at[i][0] < 0 || seg_at[i][1] < 0) return out;
      const gp_Pln &pa = plns[on[i][0]];
      const BlSeg &sa = faces[on[i][0]].segs[seg_at[i][0]];
      gp_Vec in3 = gp_Vec(pa.XAxis().Direction()) * sa.in.X() + gp_Vec(pa.YAxis().Direction()) * sa.in.Y();
      gp_XY mid = (sa.a + sa.b) * 0.5;
      gp_Pnt at = ElSLib::Value(mid.X(), mid.Y(), pa), p;
      gp_XY uv = bl_on(plns[on[i][1]], at);
      gp_Vec nb;
      BRepGProp_Face(TopoDS::Face(face_ids(on[i][1] + 1))).Normal(uv.X(), uv.Y(), p, nb);
      concave[i] = in3.Dot(nb) >= 0;
      if (concave[i]) faces[on[i][0]].convex = faces[on[i][1]].convex = false;
    }

    std::vector<double> off;
    auto fit = [&](size_t fi, const std::vector<char> &sec) {
      const BlFace &f = faces[fi];
      off.assign(f.segs.size(), 0.0);
      for (size_t k = 0; k < f.segs.size(); ++k) {
        int e = f.segs[k].edge;
        if (e >= 0) off[k] = f.segs[k].first != (sec[e] != 0) ? d1[e] : d2[e];
      }
      return bl_face_fit(f, off, tol);
    };
    auto passes = [&](size_t fi, const std::vector<char> &sec, bool touch) {
      int got = fit(fi, sec);
      return got == 0 || (got == 1 && touch && (faces[fi].convex || faces[fi].edges.size() == 1));
    };
    bool map_fits = true;
    for (size_t fi = 0; fi < faces.size() && map_fits; ++fi) map_fits = passes(fi, out.second, true);
    if (map_fits) {
      out.kind = BL_SIDES_MAP_FITS;
      return out;
    }

    // Edges that share a face are searched together, so a misfit is found
    // before the rest is enumerated again.
    std::vector<int> vars, pos(m, -1);
    for (size_t s0 = 0; s0 < m; ++s0) {
      if (pos[s0] >= 0 || d1[s0] == d2[s0]) continue;
      pos[s0] = (int)vars.size();
      vars.push_back((int)s0);
      for (size_t q = vars.size() - 1; q < vars.size(); ++q)
        for (int side : on[vars[q]])
          for (int e : faces[side].edges)
            if (pos[e] < 0 && d1[e] != d2[e]) {
              pos[e] = (int)vars.size();
              vars.push_back(e);
            }
    }
    std::vector<std::vector<int>> done_at(vars.size());
    std::vector<int> fixed;
    for (size_t fi = 0; fi < faces.size(); ++fi) {
      int last = -1;
      for (int e : faces[fi].edges) last = std::max(last, pos[e]);
      (last < 0 ? fixed : done_at[last]).push_back((int)fi);
    }
    long steps = 0;
    auto search = [&](bool touch) {
      std::vector<char> sec(m, 0);
      auto ok = [&](int fi) { return passes(fi, sec, touch); };
      for (int fi : fixed)
        if (!ok(fi)) return 0;
      std::function<int(size_t)> go = [&](size_t p) -> int {
        if (p == vars.size()) {
          out.second = sec;
          return 1;
        }
        for (char c = 0; c < 2; ++c) {
          if (++steps > 100000) return -1;
          sec[vars[p]] = c;
          bool all = true;
          for (int fi : done_at[p]) all = all && ok(fi);
          int r = all ? go(p + 1) : 0;
          if (r != 0) return r;
        }
        sec[vars[p]] = 0;
        return 0;
      };
      return go(0);
    };
    int got = search(false);
    if (got == 1) {
      out.kind = BL_SIDES_FIT;
      return out;
    }
    if (got == 0 && (got = search(true)) == 1) {
      out.kind = BL_SIDES_TOUCH;
      return out;
    }
    out.second.assign(m, 0);
    out.kind = got < 0 ? BL_SIDES_MAP : BL_SIDES_NONE;
    for (size_t fi = 0; fi < faces.size() && got == 0 && out.concave < 0; ++fi)
      if (!faces[fi].convex && !passes(fi, out.second, true))
        for (int e : faces[fi].edges)
          if (concave[e] && out.concave < 0) out.concave = e;
    return out;
  } catch (const Standard_Failure &) {
    out.second.assign(m, 0);
    out.kind = BL_SIDES_MAP;
    return out;
  }
}

// A two distance chamfer that fits no way round is not handed to the kernel:
// built one edge at a time it came back carved with no word said.
inline BlShape blend_chamfer(const TopoDS_Shape &shape, const TopoDS_Shape &edges,
                             rust::Slice<const double> d1, rust::Slice<const double> d2,
                             int32_t &status) {
  TopTools_IndexedDataMapOfShapeListOfShape map;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, map);
  BRepFilletAPI_MakeChamfer mk(shape);
  std::vector<TopoDS_Shape> es = bl_children(edges);
  size_t n = std::min(es.size(), std::min(d1.size(), d2.size()));
  es.resize(n);
  BlSides sides = bl_chamfer_sides(shape, es, std::vector<double>(d1.begin(), d1.begin() + n),
                                   std::vector<double>(d2.begin(), d2.begin() + n));
  if (sides.kind == BL_SIDES_NONE || sides.kind == BL_SIDES_TOUCH) {
    status = 1;
    return BlShape(new TopoDS_Shape());
  }
  for (size_t i = 0; i < n; ++i) {
    const TopoDS_Edge &e = TopoDS::Edge(es[i]);
    const TopTools_ListOfShape &faces = map.FindFromKey(e);
    mk.Add(d1[i], d2[i], e, TopoDS::Face(sides.second[i] ? faces.Last() : faces.First()));
  }
  mk.Build();
  if (!mk.IsDone()) {
    status = 1;
    return BlShape(new TopoDS_Shape());
  }
  TopoDS_Shape out = bl_split_false_degenerate(mk.Shape());
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
