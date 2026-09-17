#pragma once
#include <BRepTools_History.hxx>
#include <TopTools_ListOfShape.hxx>
#include <bindings_common.hxx>
#include <stdexcept>
#include <vector>

struct FcHistory {
  Handle(BRepTools_History) history;
};

inline std::unique_ptr<FcHistory> fc_history(const Handle(BRepTools_History) &history) {
  auto out = std::unique_ptr<FcHistory>(new FcHistory());
  out->history = history;
  return out;
}

inline bool FcHistory_is_null(const FcHistory &history) { return history.history.IsNull(); }

inline std::unique_ptr<std::vector<TopoDS_Shape>> fc_history_list(const TopTools_ListOfShape &list) {
  return std::unique_ptr<std::vector<TopoDS_Shape>>(new std::vector<TopoDS_Shape>(list.begin(), list.end()));
}

// BRepTools_History raises on a shape type it does not track (a solid or a
// compound), so those answer empty instead.
inline bool fc_history_tracks(const TopoDS_Shape &shape) {
  return BRepTools_History::IsSupportedType(shape);
}

inline std::unique_ptr<std::vector<TopoDS_Shape>> FcHistory_modified(const FcHistory &history,
                                                                     const TopoDS_Shape &shape) {
  if (history.history.IsNull() || !fc_history_tracks(shape)) {
    return fc_history_list(TopTools_ListOfShape());
  }
  return fc_history_list(history.history->Modified(shape));
}

inline std::unique_ptr<std::vector<TopoDS_Shape>> FcHistory_generated(const FcHistory &history,
                                                                      const TopoDS_Shape &shape) {
  if (history.history.IsNull() || !fc_history_tracks(shape)) {
    return fc_history_list(TopTools_ListOfShape());
  }
  return fc_history_list(history.history->Generated(shape));
}

inline bool FcHistory_is_removed(const FcHistory &history, const TopoDS_Shape &shape) {
  if (history.history.IsNull() || !fc_history_tracks(shape)) {
    return false;
  }
  return history.history->IsRemoved(shape);
}
