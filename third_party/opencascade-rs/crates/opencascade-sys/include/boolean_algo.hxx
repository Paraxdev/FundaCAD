#pragma once
#include <BOPAlgo_Splitter.hxx>
#include <BRepAlgoAPI_BuilderAlgo.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <Message_Alert.hxx>
#include <Message_ProgressRange.hxx>
#include <Message_Report.hxx>
#include <TopTools_ListOfShape.hxx>
#include <bindings_common.hxx>
#include <stdexcept>
#include <vector>

struct FcBooleanRun {
  std::unique_ptr<BRepAlgoAPI_BuilderAlgo> algo;
};

inline std::unique_ptr<std::vector<TopoDS_Shape>> fc_boolean_vector(const TopTools_ListOfShape &list) {
  return std::unique_ptr<std::vector<TopoDS_Shape>>(new std::vector<TopoDS_Shape>(list.begin(), list.end()));
}

inline std::unique_ptr<FcBooleanRun> FcBooleanRun_perform(int kind, const TopTools_ListOfShape &arguments,
                                                          const TopTools_ListOfShape &tools, double fuzzy, int glue,
                                                          bool non_destructive, bool parallel, bool use_obb,
                                                          const Message_ProgressRange &progress) {
  auto run = std::unique_ptr<FcBooleanRun>(new FcBooleanRun());
  switch (kind) {
  case 0:
  case 1:
  case 2:
  case 3: {
    BRepAlgoAPI_BooleanOperation *op = nullptr;
    if (kind == 0) {
      op = new BRepAlgoAPI_Fuse();
    } else if (kind == 1) {
      op = new BRepAlgoAPI_Cut();
    } else if (kind == 2) {
      op = new BRepAlgoAPI_Common();
    } else {
      op = new BRepAlgoAPI_Section();
    }
    run->algo.reset(op);
    op->SetTools(tools);
    break;
  }
  case 4: {
    BRepAlgoAPI_Splitter *splitter = new BRepAlgoAPI_Splitter();
    run->algo.reset(splitter);
    splitter->SetTools(tools);
    break;
  }
  case 5:
    run->algo.reset(new BRepAlgoAPI_BuilderAlgo());
    break;
  default:
    throw std::invalid_argument("unknown boolean kind");
  }
  if (glue < 0 || glue > 2) {
    throw std::invalid_argument("glue is 0 off, 1 shift or 2 full");
  }
  BRepAlgoAPI_BuilderAlgo &algo = *run->algo;
  algo.SetArguments(arguments);
  algo.SetFuzzyValue(fuzzy);
  algo.SetGlue(static_cast<BOPAlgo_GlueEnum>(glue));
  algo.SetNonDestructive(non_destructive);
  algo.SetRunParallel(parallel);
  algo.SetUseOBB(use_obb);
  algo.Build(progress);
  return run;
}

inline bool FcBooleanRun_is_done(const FcBooleanRun &run) { return run.algo->IsDone(); }

inline bool FcBooleanRun_has_errors(const FcBooleanRun &run) { return run.algo->HasErrors(); }

inline bool FcBooleanRun_has_warnings(const FcBooleanRun &run) { return run.algo->HasWarnings(); }

inline rust::String FcBooleanRun_alerts(const FcBooleanRun &run) {
  std::string out;
  const Handle(Message_Report) &report = run.algo->GetReport();
  if (report.IsNull()) {
    return rust::String(out);
  }
  const Message_Gravity gravities[] = {Message_Warning, Message_Alarm, Message_Fail};
  const char tags[] = {'W', 'A', 'F'};
  for (int i = 0; i < 3; ++i) {
    for (Message_ListOfAlert::Iterator it(report->GetAlerts(gravities[i])); it.More(); it.Next()) {
      out += tags[i];
      out += ' ';
      out += it.Value()->GetMessageKey();
      out += '\n';
    }
  }
  return rust::String(out);
}

inline std::unique_ptr<TopoDS_Shape> FcBooleanRun_shape(const FcBooleanRun &run) {
  if (!run.algo->IsDone()) {
    throw std::runtime_error("the boolean did not finish");
  }
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(run.algo->Shape()));
}

inline std::unique_ptr<std::vector<TopoDS_Shape>> FcBooleanRun_modified(FcBooleanRun &run, const TopoDS_Shape &shape) {
  return fc_boolean_vector(run.algo->Modified(shape));
}

inline std::unique_ptr<std::vector<TopoDS_Shape>> FcBooleanRun_generated(FcBooleanRun &run,
                                                                          const TopoDS_Shape &shape) {
  return fc_boolean_vector(run.algo->Generated(shape));
}

inline bool FcBooleanRun_is_deleted(FcBooleanRun &run, const TopoDS_Shape &shape) {
  return run.algo->IsDeleted(shape);
}

inline std::unique_ptr<std::vector<TopoDS_Shape>> FcBooleanRun_section_edges(FcBooleanRun &run) {
  return fc_boolean_vector(run.algo->SectionEdges());
}

inline void FcBooleanRun_simplify(FcBooleanRun &run, bool unify_edges, bool unify_faces, double angular_tolerance) {
  if (!run.algo->IsDone()) {
    throw std::runtime_error("the boolean did not finish");
  }
  run.algo->SimplifyResult(unify_edges, unify_faces, angular_tolerance);
}

inline std::unique_ptr<TopoDS_Shape> BOPAlgo_Splitter_perform(const TopTools_ListOfShape &arguments,
                                                              const TopTools_ListOfShape &tools, double fuzzy,
                                                              bool non_destructive, bool parallel,
                                                              const Message_ProgressRange &progress,
                                                              bool &has_errors) {
  BOPAlgo_Splitter splitter;
  splitter.SetArguments(arguments);
  splitter.SetTools(tools);
  splitter.SetFuzzyValue(fuzzy);
  splitter.SetNonDestructive(non_destructive);
  splitter.SetRunParallel(parallel);
  splitter.Perform(progress);
  has_errors = splitter.HasErrors();
  return std::unique_ptr<TopoDS_Shape>(new TopoDS_Shape(splitter.Shape()));
}
