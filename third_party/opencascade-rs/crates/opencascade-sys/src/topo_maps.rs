//! Lookups on the TopTools maps and lists that `top_tools` constructs.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/topo_maps.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;
        type TopAbs_ShapeEnum = crate::top_abs::TopAbs_ShapeEnum;
        type TopTools_ListOfShape = crate::top_tools::TopTools_ListOfShape;
        type TopTools_IndexedMapOfShape = crate::top_tools::TopTools_IndexedMapOfShape;
        type TopTools_IndexedDataMapOfShapeListOfShape =
            crate::top_tools::TopTools_IndexedDataMapOfShapeListOfShape;

        /// 0 when the shape is not in the map.
        pub fn TopTools_IndexedMapOfShape_find_index(
            map: &TopTools_IndexedMapOfShape,
            shape: &TopoDS_Shape,
        ) -> i32;
        pub fn TopTools_IndexedMapOfShape_add(
            map: Pin<&mut TopTools_IndexedMapOfShape>,
            shape: &TopoDS_Shape,
        ) -> i32;
        pub fn TopTools_IndexedMapOfShape_key(
            map: &TopTools_IndexedMapOfShape,
            index: i32,
        ) -> Result<&TopoDS_Shape>;

        /// 0 when the shape is not a key.
        pub fn TopTools_IndexedDataMapOfShapeListOfShape_find_index(
            map: &TopTools_IndexedDataMapOfShapeListOfShape,
            shape: &TopoDS_Shape,
        ) -> i32;
        pub fn TopTools_IndexedDataMapOfShapeListOfShape_list(
            map: &TopTools_IndexedDataMapOfShapeListOfShape,
            index: i32,
        ) -> Result<&TopTools_ListOfShape>;
        pub fn TopTools_IndexedDataMapOfShapeListOfShape_key(
            map: &TopTools_IndexedDataMapOfShapeListOfShape,
            index: i32,
        ) -> Result<&TopoDS_Shape>;

        pub fn TopTools_ListOfShape_extent(list: &TopTools_ListOfShape) -> i32;
        pub fn TopTools_ListOfShape_first(list: &TopTools_ListOfShape) -> Result<&TopoDS_Shape>;
        pub fn TopTools_ListOfShape_last(list: &TopTools_ListOfShape) -> Result<&TopoDS_Shape>;
        pub fn TopTools_ListOfShape_clear(list: Pin<&mut TopTools_ListOfShape>);

        /// Same TShape and location, orientation ignored.
        pub fn TopoDS_Shape_is_same(a: &TopoDS_Shape, b: &TopoDS_Shape) -> bool;

        pub fn TopExp_map_shapes(
            shape: &TopoDS_Shape,
            kind: TopAbs_ShapeEnum,
        ) -> UniquePtr<TopTools_IndexedMapOfShape>;
        pub fn TopExp_map_shapes_and_ancestors(
            shape: &TopoDS_Shape,
            child: TopAbs_ShapeEnum,
            parent: TopAbs_ShapeEnum,
        ) -> UniquePtr<TopTools_IndexedDataMapOfShapeListOfShape>;
    }
}
