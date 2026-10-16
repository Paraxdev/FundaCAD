#pragma once
// A STEP product that came in without a solid, sewn into the solids its faces
// close. A file whose faces share no edge reads as one open shell per face,
// even where it declares a solid, because the reader finds nothing joining
// them.

#include <step_heal.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Shell.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <Geom2d_BSplineCurve.hxx>
#include <Geom2d_Curve.hxx>
#include <Geom_Surface.hxx>
#include <Message_ProgressScope.hxx>
#include <ShapeAnalysis_Surface.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_DataMapOfShapeInteger.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <string>
#include <utility>
#include <vector>

// A file written to six decimals of a metre leaves gaps of this order.
const double STEP_LOOSE_TOLERANCE = 1e-3;

struct StepLoosePiece {
  TopoDS_Shape shape;
  bool solid = false;
  // The colour the file put on the solid this piece was declared as.
  int32_t color = -1;
  // Per face in explorer order, -1 for none.
  std::vector<int32_t> face_colors;
};

struct StepLooseRepair {
  // False when sewing joined nothing, the product then stays as the file has it.
  bool changed = false;
  std::vector<StepLoosePiece> pieces;
  // The piece a sentence is about, -1 for the product as a whole.
  std::vector<std::pair<int32_t, std::string>> notes;
  // The first note says what did not close.
  bool open = false;

  TopoDS_Shape whole() const {
    if (pieces.size() == 1) {
      return pieces[0].shape;
    }
    TopoDS_Compound all;
    BRep_Builder builder;
    builder.MakeCompound(all);
    for (const StepLoosePiece &p : pieces) {
      builder.Add(all, p.shape);
    }
    return all;
  }
};

// The shells and faces that sit side by side in one compound: what is left of
// one declared solid, or one surface model.
struct StepLooseUnit {
  TopoDS_Shape owner;
  std::vector<TopoDS_Shape> members;
};

// False when the product holds anything but shells and faces, it is then left
// alone so no wire or point of it is lost.
inline bool step_loose_units(const TopoDS_Shape &shape, std::vector<StepLooseUnit> &units) {
  if (shape.ShapeType() == TopAbs_SHELL || shape.ShapeType() == TopAbs_FACE) {
    units.push_back({shape, {shape}});
    return true;
  }
  if (shape.ShapeType() != TopAbs_COMPOUND) {
    return false;
  }
  size_t own = units.size();
  units.push_back({shape, {}});
  for (TopoDS_Iterator it(shape); it.More(); it.Next()) {
    const TopoDS_Shape &child = it.Value();
    if (child.ShapeType() == TopAbs_SHELL || child.ShapeType() == TopAbs_FACE) {
      units[own].members.push_back(child);
    } else if (child.ShapeType() != TopAbs_COMPOUND || !step_loose_units(child, units)) {
      return false;
    }
  }
  if (units[own].members.empty()) {
    units.erase(units.begin() + own);
  }
  return true;
}

inline double step_loose_area(const TopoDS_Shape &shape) {
  GProp_GProps props;
  BRepGProp::SurfaceProperties(shape, props);
  return std::abs(props.Mass());
}

inline bool step_loose_no_area(const TopoDS_Shape &face) {
  return step_loose_area(face) <= STEP_LOOSE_TOLERANCE * STEP_LOOSE_TOLERANCE;
}

// The flat face across the outline of a face that has no area, null when that
// outline is not one closed flat loop. A cylinder of no height on a circle is
// how one exporter writes the disc inside it.
inline TopoDS_Face step_loose_flat(const TopoDS_Face &face) {
  try {
    BRepBuilderAPI_MakeWire wire;
    for (TopExp_Explorer ex(face, TopAbs_EDGE); ex.More(); ex.Next()) {
      const TopoDS_Edge &edge = TopoDS::Edge(ex.Current());
      if (!BRep_Tool::Degenerated(edge)) {
        wire.Add(edge);
      }
    }
    if (!wire.IsDone() || !wire.Wire().Closed()) {
      return TopoDS_Face();
    }
    BRepBuilderAPI_MakeFace made(wire.Wire(), true);
    if (!made.IsDone() || step_loose_no_area(made.Face()) || !BRepCheck_Analyzer(made.Face()).IsValid()) {
      return TopoDS_Face();
    }
    return made.Face();
  } catch (const Standard_Failure &) {
    return TopoDS_Face();
  }
}

// How far an edge's curve is from where `on` puts it on the surface.
inline double step_loose_gap(const BRepAdaptor_Curve &curve, const Handle(Geom2d_Curve) &on, double on_first,
                             double on_last, const Handle(Geom_Surface) &surface, int steps) {
  double first = curve.FirstParameter(), last = curve.LastParameter(), gap = 0.0;
  for (int k = 0; k <= steps; ++k) {
    gp_Pnt2d uv = on->Value(on_first + (on_last - on_first) * k / steps);
    gap = std::max(gap, curve.Value(first + (last - first) * k / steps).Distance(surface->Value(uv.X(), uv.Y())));
  }
  return gap;
}

// One edge of a wire as the face runs along it, `from` to `to`.
struct StepLooseEdge {
  TopoDS_Edge in_wire;
  TopoDS_Edge edge;
  Handle(Geom2d_Curve) on;
  double on_first = 0.0, on_last = 0.0;
  gp_Pnt2d start, end;
  TopoDS_Vertex from, to;
  bool off = false;
};

// `source` with every edge the reader could not lay on it laid straight
// between its ends, null when that does not make a face the checker accepts.
// The reader projects an edge onto the face to place it, and an edge the file
// draws away from the face lands anywhere: on the far half of a cylinder,
// closed by a degenerate edge that spans a whole turn. `moved` is the widest
// gap between such an edge and the face, never more than the reader had
// already allowed the edge or its ends, and stays 0 when all that had to go
// was a degenerate edge that is not a point.
inline TopoDS_Face step_loose_reseat(const TopoDS_Face &source, double &moved) {
  try {
    TopoDS_Face face = TopoDS::Face(BRepBuilderAPI_Copy(source, false).Shape().Oriented(TopAbs_FORWARD));
    Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
    if (surface.IsNull()) {
      return TopoDS_Face();
    }
    ShapeAnalysis_Surface project(surface);
    BRep_Builder builder;
    TopoDS_Face out = TopoDS::Face(face.EmptyCopied());
    bool changed = false;
    double widest = 0.0;
    for (TopoDS_Iterator wires(face); wires.More(); wires.Next()) {
      if (wires.Value().ShapeType() != TopAbs_WIRE) {
        return TopoDS_Face();
      }
      const TopoDS_Wire &wire = TopoDS::Wire(wires.Value());
      std::vector<StepLooseEdge> edges;
      bool any_off = false;
      double mean_u = 0.0, mean_v = 0.0;
      int placed = 0;
      for (TopoDS_Iterator it(wire.Oriented(TopAbs_FORWARD)); it.More(); it.Next()) {
        StepLooseEdge e;
        e.in_wire = TopoDS::Edge(it.Value());
        e.edge = wire.Orientation() == TopAbs_REVERSED ? TopoDS::Edge(e.in_wire.Reversed()) : e.in_wire;
        bool forward = e.edge.Orientation() == TopAbs_FORWARD;
        if (!forward && e.edge.Orientation() != TopAbs_REVERSED) {
          return TopoDS_Face();
        }
        e.on = BRep_Tool::CurveOnSurface(e.edge, face, e.on_first, e.on_last);
        if (e.on.IsNull()) {
          return TopoDS_Face();
        }
        e.start = e.on->Value(forward ? e.on_first : e.on_last);
        e.end = e.on->Value(forward ? e.on_last : e.on_first);
        if (BRep_Tool::Degenerated(e.edge)) {
          gp_Pnt2d middle = e.on->Value((e.on_first + e.on_last) / 2);
          if (surface->Value(e.start.X(), e.start.Y()).Distance(surface->Value(middle.X(), middle.Y())) >
              STEP_LOOSE_TOLERANCE) {
            changed = true;
            continue;
          }
        } else {
          e.off = step_loose_gap(BRepAdaptor_Curve(e.edge), e.on, e.on_first, e.on_last, surface, 8) >
                  STEP_LOOSE_TOLERANCE;
        }
        TopExp::Vertices(e.edge, e.from, e.to, true);
        if (e.off) {
          any_off = true;
        } else {
          mean_u += e.start.X() + e.end.X();
          mean_v += e.start.Y() + e.end.Y();
          placed += 2;
        }
        edges.push_back(e);
      }
      if (any_off && placed == 0) {
        return TopoDS_Face();
      }
      // Where the wire passes `vertex`: where an edge that lies on the face
      // has it, else the point of the face nearest to it, on the turn of a
      // closed surface the rest of the wire is on.
      auto at = [&](const TopoDS_Vertex &vertex, size_t own, bool arriving) {
        for (size_t k = 0; k < edges.size(); ++k) {
          if (k != own && !edges[k].off && (arriving ? edges[k].to : edges[k].from).IsSame(vertex)) {
            return arriving ? edges[k].end : edges[k].start;
          }
        }
        gp_Pnt2d uv = project.ValueOfUV(BRep_Tool::Pnt(vertex), STEP_LOOSE_TOLERANCE);
        double u = uv.X(), v = uv.Y();
        if (surface->IsUPeriodic()) {
          u += std::round((mean_u / placed - u) / surface->UPeriod()) * surface->UPeriod();
        }
        if (surface->IsVPeriodic()) {
          v += std::round((mean_v / placed - v) / surface->VPeriod()) * surface->VPeriod();
        }
        return gp_Pnt2d(u, v);
      };
      for (size_t k = 0; any_off && k < edges.size(); ++k) {
        StepLooseEdge &e = edges[k];
        if (!e.off) {
          continue;
        }
        for (size_t other = 0; other < edges.size(); ++other) {
          if (other != k && edges[other].edge.IsSame(e.edge)) {
            return TopoDS_Face();
          }
        }
        if (e.from.IsNull() || e.to.IsNull()) {
          return TopoDS_Face();
        }
        gp_Pnt2d a = at(e.from, k, true), b = at(e.to, k, false);
        if (a.Distance(b) < 1e-9) {
          return TopoDS_Face();
        }
        if (e.edge.Orientation() == TopAbs_REVERSED) {
          std::swap(a, b);
        }
        BRepAdaptor_Curve curve(e.edge);
        TColgp_Array1OfPnt2d poles(1, 2);
        poles.SetValue(1, a);
        poles.SetValue(2, b);
        TColStd_Array1OfReal knots(1, 2);
        knots.SetValue(1, curve.FirstParameter());
        knots.SetValue(2, curve.LastParameter());
        TColStd_Array1OfInteger mults(1, 2);
        mults.Init(2);
        Handle(Geom2d_Curve) straight = new Geom2d_BSplineCurve(poles, knots, mults, 1);
        double allowed = std::max({step_loose_gap(curve, e.on, e.on_first, e.on_last, surface, 8),
                                   BRep_Tool::Tolerance(e.edge), BRep_Tool::Tolerance(e.from),
                                   BRep_Tool::Tolerance(e.to)});
        double gap = step_loose_gap(curve, straight, curve.FirstParameter(), curve.LastParameter(), surface, 32);
        if (gap > 1.05 * allowed + STEP_LOOSE_TOLERANCE) {
          return TopoDS_Face();
        }
        // A little over the widest sample, the checker measures at other points.
        builder.UpdateEdge(e.edge, straight, out, std::max(1.02 * gap, BRep_Tool::Tolerance(e.edge)));
        widest = std::max(widest, gap);
        changed = true;
      }
      TopoDS_Wire rebuilt;
      builder.MakeWire(rebuilt);
      for (const StepLooseEdge &e : edges) {
        builder.Add(rebuilt, e.in_wire);
      }
      rebuilt.Closed(BRep_Tool::IsClosed(rebuilt));
      rebuilt.Orientation(wire.Orientation());
      builder.Add(out, rebuilt);
    }
    out.Orientation(source.Orientation());
    if (!changed || !BRepCheck_Analyzer(out).IsValid()) {
      return TopoDS_Face();
    }
    moved = widest;
    return out;
  } catch (const Standard_Failure &) {
    return TopoDS_Face();
  }
}

// The solid a shell bounds, facing outward. False for a shell with a hole in
// it, one whose faces disagree about which side is out, or one that encloses
// nothing.
inline bool step_loose_solid(const TopoDS_Shell &shell, TopoDS_Solid &out) {
  try {
    if (!BRep_Tool::IsClosed(shell) || BRepCheck_Shell(shell).Orientation(false) != BRepCheck_NoError) {
      return false;
    }
    TopoDS_Shell closed = shell;
    closed.Closed(true);
    BRepBuilderAPI_MakeSolid made(closed);
    if (!made.IsDone()) {
      return false;
    }
    TopoDS_Solid solid = made.Solid();
    if (!BRepLib::OrientClosedSolid(solid)) {
      return false;
    }
    GProp_GProps props;
    BRepGProp::VolumeProperties(solid, props);
    if (!(props.Mass() > 0.0)) {
      return false;
    }
    out = solid;
    return true;
  } catch (const Standard_Failure &) {
    return false;
  }
}

inline int step_loose_open_edges(const TopoDS_Shape &shape) {
  TopTools_IndexedDataMapOfShapeListOfShape faces_of;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, faces_of);
  int open = 0;
  for (int i = 1; i <= faces_of.Extent(); ++i) {
    if (faces_of.FindFromIndex(i).Extent() == 1 && !BRep_Tool::Degenerated(TopoDS::Edge(faces_of.FindKey(i)))) {
      ++open;
    }
  }
  return open;
}

inline std::string step_loose_count(int n, const char *noun) {
  return std::to_string(n) + " " + noun + (n == 1 ? "" : "s");
}

inline std::string step_loose_open_note(int faces, const TopoDS_Shape &shape) {
  return step_loose_count(faces, "face") + " did not close into a solid and " + (faces == 1 ? "stays" : "stay") +
         " a surface, " + step_loose_count(step_loose_open_edges(shape), "open edge");
}

// `color_of` is the colour the file styled a shape with, -1 for none. Sewing
// polls `progress`, and a cancel there leaves the product as the file has it.
inline StepLooseRepair step_loose_repair(const TopoDS_Shape &product,
                                         const std::function<int32_t(const TopoDS_Shape &)> &color_of,
                                         Message_ProgressScope &progress) {
  StepLooseRepair out;
  std::vector<StepLooseUnit> units;
  if (product.IsNull() || !step_loose_units(product, units)) {
    return out;
  }
  const int32_t REST = -2;
  std::vector<TopoDS_Shape> rest;
  std::vector<int32_t> rest_colors;
  int rest_faces = 0;
  bool tried = false, joined = false;
  std::vector<std::pair<int32_t, std::string>> notes;

  for (const StepLooseUnit &unit : units) {
    int32_t unit_color = color_of(unit.owner);
    std::vector<TopoDS_Face> faces;
    std::vector<int32_t> colors;
    for (const TopoDS_Shape &member : unit.members) {
      int32_t member_color = member.ShapeType() == TopAbs_SHELL ? color_of(member) : -1;
      for (TopExp_Explorer ex(member, TopAbs_FACE); ex.More(); ex.Next()) {
        int32_t c = color_of(ex.Current());
        faces.push_back(TopoDS::Face(ex.Current()));
        colors.push_back(c >= 0 ? c : member_color);
      }
    }
    auto keep_open = [&](const TopoDS_Shape &shape, const std::function<int32_t(const TopoDS_Shape &)> &face_color) {
      rest.push_back(shape);
      for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
        int32_t c = face_color(ex.Current());
        rest_colors.push_back(c >= 0 ? c : unit_color);
        ++rest_faces;
      }
    };
    if (faces.size() < 2) {
      size_t at = 0;
      for (const TopoDS_Shape &member : unit.members) {
        keep_open(member, [&](const TopoDS_Shape &) { return colors[at++]; });
      }
      continue;
    }
    tried = true;

    int flattened = 0, left_out = 0, reseated = 0, trimmed = 0;
    double moved = 0.0;
    BRepBuilderAPI_Sewing sewing(STEP_LOOSE_TOLERANCE);
    std::vector<TopoDS_Face> sewn_in(faces.size());
    for (size_t i = 0; i < faces.size(); ++i) {
      TopoDS_Face face = faces[i];
      if (step_loose_no_area(face)) {
        face = step_loose_flat(face);
        if (face.IsNull()) {
          ++left_out;
          continue;
        }
        ++flattened;
      } else if (!BRepCheck_Analyzer(face).IsValid()) {
        double gap = 0.0;
        TopoDS_Face laid = step_loose_reseat(face, gap);
        if (!laid.IsNull()) {
          face = laid;
          ++(gap > 0.0 ? reseated : trimmed);
          moved = std::max(moved, gap);
        }
      }
      sewn_in[i] = face;
      sewing.Add(face);
    }
    sewing.Perform(progress.Next());
    if (progress.UserBreak()) {
      return StepLooseRepair();
    }
    TopoDS_Shape sewn = sewing.SewedShape();
    TopTools_DataMapOfShapeInteger origin;
    for (size_t i = 0; i < faces.size(); ++i) {
      if (sewn_in[i].IsNull()) {
        continue;
      }
      TopoDS_Shape now = sewing.IsModified(sewn_in[i]) ? sewing.Modified(sewn_in[i]) : TopoDS_Shape(sewn_in[i]);
      for (TopExp_Explorer ex(now, TopAbs_FACE); ex.More(); ex.Next()) {
        if (!origin.IsBound(ex.Current())) {
          origin.Bind(ex.Current(), static_cast<int>(i));
        }
      }
    }
    auto color_now = [&](const TopoDS_Shape &face) {
      return origin.IsBound(face) ? colors[origin.Find(face)] : -1;
    };

    // All of a unit closes or none of it is a solid: a pocket that closes on
    // its own inside a surface model is the wall of a hole more often than a
    // body.
    std::vector<StepLoosePiece> solids;
    std::vector<std::string> checks, gaps;
    bool all_healed = true;
    bool closes = !sewn.IsNull() && !TopExp_Explorer(sewn, TopAbs_FACE, TopAbs_SHELL).More();
    for (TopExp_Explorer ex(sewn, TopAbs_SHELL); closes && ex.More(); ex.Next()) {
      TopoDS_Solid solid;
      closes = step_loose_solid(TopoDS::Shell(ex.Current()), solid);
      if (!closes) {
        break;
      }
      StepLoosePiece piece;
      for (TopExp_Explorer fx(solid, TopAbs_FACE); fx.More(); fx.Next()) {
        piece.face_colors.push_back(color_now(fx.Current()));
      }
      StepHeal heal = step_heal(solid, &progress, step_heal_budget());
      if (heal.cancelled) {
        return StepLooseRepair();
      }
      if (heal.healed) {
        solid = heal.solid;
      } else {
        all_healed = false;
      }
      piece.shape = solid;
      piece.solid = true;
      piece.color = unit_color;
      int wrong = 0;
      BRepCheck_Analyzer check(solid);
      for (TopExp_Explorer fx(solid, TopAbs_FACE); fx.More(); fx.Next()) {
        wrong += check.IsValid(fx.Current()) ? 0 : 1;
      }
      solids.push_back(piece);
      if (wrong > 0) {
        checks.push_back(step_loose_count(wrong, "face") + " " + (wrong == 1 ? "has" : "have") +
                         " an outline the file describes wrongly and " +
                         (wrong == 1 ? "is kept as it is" : "are kept as they are") +
                         ", so the kernel's validity check rejects this body");
      } else if (!check.IsValid()) {
        checks.push_back("the kernel's validity check rejects this body as the file describes it");
      } else {
        checks.push_back(std::string());
      }
      gaps.push_back(step_heal_note(heal));
    }
    int32_t about = REST;
    if (closes && !solids.empty()) {
      about = solids.size() == 1 ? static_cast<int32_t>(out.pieces.size()) : -1;
      for (size_t k = 0; k < solids.size(); ++k) {
        for (const std::string &said : {checks[k], gaps[k]}) {
          if (!said.empty()) {
            notes.push_back({static_cast<int32_t>(out.pieces.size()), said});
          }
        }
        out.pieces.push_back(solids[k]);
      }
    } else if (sewn.IsNull()) {
      flattened = left_out = reseated = trimmed = 0;
      size_t at = 0;
      for (const TopoDS_Shape &member : unit.members) {
        keep_open(member, [&](const TopoDS_Shape &) { return colors[at++]; });
      }
    } else {
      for (TopExp_Explorer ex(sewn, TopAbs_SHELL); !joined && ex.More(); ex.Next()) {
        TopExp_Explorer second(ex.Current(), TopAbs_FACE);
        second.Next();
        joined = second.More();
      }
      keep_open(sewn, color_now);
    }
    if (flattened > 0) {
      notes.push_back({about, step_loose_count(flattened, "face") + " with no area became " +
                                  (flattened == 1 ? "a flat face across its outline" : "flat faces across their outline")});
    }
    if (left_out > 0) {
      notes.push_back({about, step_loose_count(left_out, "face") + " with no area " +
                                  (left_out == 1 ? "was" : "were") + " left out"});
    }
    // A healed solid redrew the edges these faces were laid on.
    if (reseated > 0 && !(closes && all_healed)) {
      char gap[32];
      std::snprintf(gap, sizeof gap, "%.2g", moved);
      notes.push_back({about, step_loose_count(reseated, "face") + " " + (reseated == 1 ? "has" : "have") +
                                  " an edge the file draws up to " + gap + " mm away from the face, " +
                                  (reseated == 1 ? "it is" : "they are") + " kept with that edge laid on the face"});
    }
    if (trimmed > 0) {
      notes.push_back({about, step_loose_count(trimmed, "face") + " had an empty edge in " +
                                  (trimmed == 1 ? "its" : "their") + " outline that is not a point, it was left out"});
    }
  }

  if (out.pieces.empty() && !joined) {
    if (tried) {
      int faces = 0;
      for (TopExp_Explorer ex(product, TopAbs_FACE); ex.More(); ex.Next()) {
        ++faces;
      }
      out.notes.push_back({-1, step_loose_open_note(faces, product)});
      out.open = true;
    }
    return out;
  }
  out.changed = true;
  int32_t rest_piece = -1;
  if (!rest.empty()) {
    StepLoosePiece piece;
    if (rest.size() == 1) {
      piece.shape = rest[0];
    } else {
      TopoDS_Compound all;
      BRep_Builder builder;
      builder.MakeCompound(all);
      for (const TopoDS_Shape &s : rest) {
        builder.Add(all, s);
      }
      piece.shape = all;
    }
    piece.face_colors = rest_colors;
    rest_piece = static_cast<int32_t>(out.pieces.size());
    out.pieces.push_back(piece);
    out.notes.push_back({rest_piece, step_loose_open_note(rest_faces, piece.shape)});
    out.open = true;
  }
  for (const auto &note : notes) {
    out.notes.push_back({note.first == REST ? rest_piece : note.first, note.second});
  }
  return out;
}
