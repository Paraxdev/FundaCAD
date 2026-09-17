#pragma once
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopTools_ListOfShape.hxx>
#include <b_rep_tools_history.hxx>
#include <bindings_common.hxx>

inline std::unique_ptr<ShapeUpgrade_UnifySameDomain>
ShapeUpgrade_UnifySameDomain_run(const TopoDS_Shape &shape, bool unify_edges, bool unify_faces, bool concat_bsplines,
                                 bool allow_internal_edges, bool safe_input, double linear_tolerance,
                                 double angular_tolerance, const TopTools_ListOfShape &keep) {
  auto unify = std::unique_ptr<ShapeUpgrade_UnifySameDomain>(new ShapeUpgrade_UnifySameDomain());
  unify->Initialize(shape, unify_edges, unify_faces, concat_bsplines);
  unify->AllowInternalEdges(allow_internal_edges);
  unify->SetSafeInputMode(safe_input);
  if (linear_tolerance > 0.0) {
    unify->SetLinearTolerance(linear_tolerance);
  }
  if (angular_tolerance > 0.0) {
    unify->SetAngularTolerance(angular_tolerance);
  }
  for (TopTools_ListOfShape::Iterator it(keep); it.More(); it.Next()) {
    unify->KeepShape(it.Value());
  }
  unify->Build();
  return unify;
}

inline std::unique_ptr<TopoDS_Shape> ShapeUpgrade_UnifySameDomain_result(const ShapeUpgrade_UnifySameDomain &unify) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(unify.Shape()));
}

inline std::unique_ptr<FcHistory> ShapeUpgrade_UnifySameDomain_history(const ShapeUpgrade_UnifySameDomain &unify) {
  return fc_history(unify.History());
}
