#pragma once
#include <TopExp.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <bindings_common.hxx>
#include <stdexcept>

// NCollection only range checks in debug builds, a release build reads past
// the end, so every indexed access checks here.

inline int TopTools_IndexedMapOfShape_find_index(const TopTools_IndexedMapOfShape &map, const TopoDS_Shape &shape) {
  return map.FindIndex(shape);
}

inline int TopTools_IndexedMapOfShape_add(TopTools_IndexedMapOfShape &map, const TopoDS_Shape &shape) {
  return map.Add(shape);
}

inline const TopoDS_Shape &TopTools_IndexedMapOfShape_key(const TopTools_IndexedMapOfShape &map, int index) {
  if (index < 1 || index > map.Extent()) {
    throw std::out_of_range("shape map index out of range");
  }
  return map.FindKey(index);
}

inline int TopTools_IndexedDataMapOfShapeListOfShape_find_index(const TopTools_IndexedDataMapOfShapeListOfShape &map,
                                                                const TopoDS_Shape &shape) {
  return map.FindIndex(shape);
}

inline const TopTools_ListOfShape &
TopTools_IndexedDataMapOfShapeListOfShape_list(const TopTools_IndexedDataMapOfShapeListOfShape &map, int index) {
  if (index < 1 || index > map.Extent()) {
    throw std::out_of_range("ancestor map index out of range");
  }
  return map.FindFromIndex(index);
}

inline const TopoDS_Shape &
TopTools_IndexedDataMapOfShapeListOfShape_key(const TopTools_IndexedDataMapOfShapeListOfShape &map, int index) {
  if (index < 1 || index > map.Extent()) {
    throw std::out_of_range("ancestor map index out of range");
  }
  return map.FindKey(index);
}

inline int TopTools_ListOfShape_extent(const TopTools_ListOfShape &list) { return list.Extent(); }

inline const TopoDS_Shape &TopTools_ListOfShape_first(const TopTools_ListOfShape &list) {
  if (list.IsEmpty()) {
    throw std::out_of_range("First on an empty shape list");
  }
  return list.First();
}

inline const TopoDS_Shape &TopTools_ListOfShape_last(const TopTools_ListOfShape &list) {
  if (list.IsEmpty()) {
    throw std::out_of_range("Last on an empty shape list");
  }
  return list.Last();
}

inline void TopTools_ListOfShape_clear(TopTools_ListOfShape &list) { list.Clear(); }

inline bool TopoDS_Shape_is_same(const TopoDS_Shape &a, const TopoDS_Shape &b) { return a.IsSame(b); }

inline std::unique_ptr<TopTools_IndexedMapOfShape> TopExp_map_shapes(const TopoDS_Shape &shape,
                                                                     TopAbs_ShapeEnum kind) {
  auto map = std::unique_ptr<TopTools_IndexedMapOfShape>(new TopTools_IndexedMapOfShape());
  TopExp::MapShapes(shape, kind, *map);
  return map;
}

inline std::unique_ptr<TopTools_IndexedDataMapOfShapeListOfShape>
TopExp_map_shapes_and_ancestors(const TopoDS_Shape &shape, TopAbs_ShapeEnum child, TopAbs_ShapeEnum parent) {
  auto map =
      std::unique_ptr<TopTools_IndexedDataMapOfShapeListOfShape>(new TopTools_IndexedDataMapOfShapeListOfShape());
  TopExp::MapShapesAndAncestors(shape, child, parent, *map);
  return map;
}
