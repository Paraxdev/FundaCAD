#include <BRepCheck_Analyzer.hxx>
#include <bindings_common.hxx>

inline bool BRepCheck_Analyzer_is_valid(const TopoDS_Shape &shape, bool geometry_checks, bool parallel,
                                        bool exact) {
  BRepCheck_Analyzer analyzer(shape, geometry_checks, parallel, exact);
  return analyzer.IsValid();
}
