#pragma once
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <Message_ProgressRange.hxx>
#include <bindings_common.hxx>
#include <stdexcept>

inline std::unique_ptr<BRepExtrema_DistShapeShape>
BRepExtrema_DistShapeShape_perform(const TopoDS_Shape &shape_1, const TopoDS_Shape &shape_2, double deflection,
                                   const Message_ProgressRange &progress) {
  auto dist = std::unique_ptr<BRepExtrema_DistShapeShape>(new BRepExtrema_DistShapeShape());
  if (deflection > 0.0) {
    dist->SetDeflection(deflection);
  }
  dist->LoadS1(shape_1);
  dist->LoadS2(shape_2);
  dist->Perform(progress);
  return dist;
}

inline void BRepExtrema_DistShapeShape_solution(const BRepExtrema_DistShapeShape &dist, int index, bool on_first,
                                                rust::Slice<double> out) {
  if (out.size() < 6) {
    throw std::invalid_argument("solution needs 6 slots");
  }
  if (!dist.IsDone() || index < 1 || index > dist.NbSolution()) {
    throw std::out_of_range("no such distance solution");
  }
  const gp_Pnt &p = on_first ? dist.PointOnShape1(index) : dist.PointOnShape2(index);
  BRepExtrema_SupportType kind = on_first ? dist.SupportTypeShape1(index) : dist.SupportTypeShape2(index);
  out[0] = p.X();
  out[1] = p.Y();
  out[2] = p.Z();
  out[3] = static_cast<double>(kind);
  out[4] = 0.0;
  out[5] = 0.0;
  if (kind == BRepExtrema_IsOnEdge) {
    Standard_Real t = 0.0;
    if (on_first) {
      dist.ParOnEdgeS1(index, t);
    } else {
      dist.ParOnEdgeS2(index, t);
    }
    out[4] = t;
  } else if (kind == BRepExtrema_IsInFace) {
    Standard_Real u = 0.0, v = 0.0;
    if (on_first) {
      dist.ParOnFaceS1(index, u, v);
    } else {
      dist.ParOnFaceS2(index, u, v);
    }
    out[4] = u;
    out[5] = v;
  }
}

inline std::unique_ptr<TopoDS_Shape> BRepExtrema_DistShapeShape_support(const BRepExtrema_DistShapeShape &dist,
                                                                        int index, bool on_first) {
  if (!dist.IsDone() || index < 1 || index > dist.NbSolution()) {
    throw std::out_of_range("no such distance solution");
  }
  return std::unique_ptr<TopoDS_Shape>(
      new TopoDS_Shape(on_first ? dist.SupportOnShape1(index) : dist.SupportOnShape2(index)));
}

inline std::unique_ptr<TopoDS_Shape> BRepExtrema_vertex(double x, double y, double z) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(BRepBuilderAPI_MakeVertex(gp_Pnt(x, y, z)).Vertex()));
}
