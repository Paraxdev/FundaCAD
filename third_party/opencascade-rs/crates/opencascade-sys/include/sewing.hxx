#pragma once
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepTools_ReShape.hxx>
#include <Message_ProgressRange.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <bindings_common.hxx>
#include <stdexcept>
#include <vector>

// Both tools are Standard_Transient, so each lives behind a handle.

struct FcSewing {
  Handle(BRepBuilderAPI_Sewing) sewing;
};

inline std::unique_ptr<FcSewing> BRepBuilderAPI_Sewing_run(const TopTools_ListOfShape &shapes, double tolerance,
                                                           bool cutting, bool non_manifold,
                                                           const Message_ProgressRange &progress) {
  auto out = std::unique_ptr<FcSewing>(new FcSewing());
  out->sewing = new BRepBuilderAPI_Sewing(tolerance, Standard_True, Standard_True, cutting, non_manifold);
  for (TopTools_ListOfShape::Iterator it(shapes); it.More(); it.Next()) {
    out->sewing->Add(it.Value());
  }
  out->sewing->Perform(progress);
  return out;
}

inline std::unique_ptr<TopoDS_Shape> FcSewing_sewed_shape(const FcSewing &sewing) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(sewing.sewing->SewedShape()));
}

inline void FcSewing_counts(const FcSewing &sewing, rust::Slice<int> out) {
  if (out.size() < 4) {
    throw std::invalid_argument("counts need 4 slots");
  }
  out[0] = sewing.sewing->NbFreeEdges();
  out[1] = sewing.sewing->NbMultipleEdges();
  out[2] = sewing.sewing->NbDegeneratedShapes();
  out[3] = sewing.sewing->NbDeletedFaces();
}

inline std::unique_ptr<std::vector<TopoDS_Shape>> FcSewing_free_edges(const FcSewing &sewing) {
  auto out = std::unique_ptr<std::vector<TopoDS_Shape>>(new std::vector<TopoDS_Shape>());
  for (int i = 1; i <= sewing.sewing->NbFreeEdges(); ++i) {
    out->push_back(static_cast<const TopoDS_Shape &>(sewing.sewing->FreeEdge(i)));
  }
  return out;
}

inline std::unique_ptr<TopoDS_Shape> FcSewing_modified(const FcSewing &sewing, const TopoDS_Shape &shape) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(sewing.sewing->Modified(shape)));
}

inline bool FcSewing_is_modified(const FcSewing &sewing, const TopoDS_Shape &shape) {
  return sewing.sewing->IsModified(shape);
}

struct FcReShape {
  Handle(BRepTools_ReShape) reshape;
};

inline std::unique_ptr<FcReShape> BRepTools_ReShape_new() {
  auto out = std::unique_ptr<FcReShape>(new FcReShape());
  out->reshape = new BRepTools_ReShape();
  return out;
}

inline void FcReShape_replace(const FcReShape &reshape, const TopoDS_Shape &old_shape, const TopoDS_Shape &new_shape) {
  reshape.reshape->Replace(old_shape, new_shape);
}

inline void FcReShape_remove(const FcReShape &reshape, const TopoDS_Shape &shape) { reshape.reshape->Remove(shape); }

inline bool FcReShape_is_recorded(const FcReShape &reshape, const TopoDS_Shape &shape) {
  return reshape.reshape->IsRecorded(shape);
}

inline std::unique_ptr<TopoDS_Shape> FcReShape_value(const FcReShape &reshape, const TopoDS_Shape &shape) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(reshape.reshape->Value(shape)));
}

inline std::unique_ptr<TopoDS_Shape> FcReShape_apply(const FcReShape &reshape, const TopoDS_Shape &shape) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(reshape.reshape->Apply(shape)));
}
