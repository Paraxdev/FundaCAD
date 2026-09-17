#pragma once
#include <BOPAlgo_RemoveFeatures.hxx>
#include <Message_ProgressRange.hxx>
#include <TopTools_ListOfShape.hxx>
#include <b_rep_tools_history.hxx>
#include <bindings_common.hxx>
#include <fc_report.hxx>

inline std::unique_ptr<BOPAlgo_RemoveFeatures> BOPAlgo_RemoveFeatures_run(const TopoDS_Shape &shape,
                                                                          const TopTools_ListOfShape &faces,
                                                                          bool parallel,
                                                                          const Message_ProgressRange &progress) {
  auto algo = std::unique_ptr<BOPAlgo_RemoveFeatures>(new BOPAlgo_RemoveFeatures());
  algo->SetShape(shape);
  algo->AddFacesToRemove(faces);
  algo->SetRunParallel(parallel);
  algo->Perform(progress);
  return algo;
}

inline std::unique_ptr<TopoDS_Shape> BOPAlgo_RemoveFeatures_shape(const BOPAlgo_RemoveFeatures &algo) {
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(algo.Shape()));
}

inline rust::String BOPAlgo_RemoveFeatures_alerts(const BOPAlgo_RemoveFeatures &algo) {
  return rust::String(fc_report_alerts(algo.GetReport()));
}

inline std::unique_ptr<FcHistory> BOPAlgo_RemoveFeatures_history(BOPAlgo_RemoveFeatures &algo) {
  return fc_history(algo.History());
}
