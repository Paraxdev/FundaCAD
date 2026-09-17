//! Indexed sub-shape maps and ancestor maps (`TopExp::MapShapes`,
//! `TopExp::MapShapesAndAncestors`), with OCCT's 1-based indices.

use crate::primitives::{Edge, Shape, ShapeType};
use cxx::UniquePtr;
use opencascade_sys as ffi;

/// Every distinct sub-shape of one type, orientation ignored.
pub struct ShapeMap {
    inner: UniquePtr<ffi::top_tools::TopTools_IndexedMapOfShape>,
}

/// Each distinct child sub-shape and the parents that hold it.
pub struct AncestorMap {
    inner: UniquePtr<ffi::top_tools::TopTools_IndexedDataMapOfShapeListOfShape>,
}

impl Shape {
    pub fn shape_map(&self, kind: ShapeType) -> ShapeMap {
        ShapeMap { inner: ffi::topo_maps::TopExp_map_shapes(&self.inner, kind.into()) }
    }

    /// `child` to `parent`, e.g. Edge to Face for face adjacency.
    pub fn ancestor_map(&self, child: ShapeType, parent: ShapeType) -> AncestorMap {
        AncestorMap {
            inner: ffi::topo_maps::TopExp_map_shapes_and_ancestors(
                &self.inner,
                child.into(),
                parent.into(),
            ),
        }
    }

    /// Same TShape and location, orientation ignored.
    pub fn is_same(&self, other: &Shape) -> bool {
        ffi::topo_maps::TopoDS_Shape_is_same(&self.inner, &other.inner)
    }

    #[must_use]
    pub fn as_edge(&self) -> Option<Edge> {
        (self.shape_type() == ShapeType::Edge)
            .then(|| Edge::from_edge(ffi::topo_ds::Edge(&self.inner)))
    }
}

impl ShapeMap {
    pub fn len(&self) -> usize {
        self.inner.Extent() as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, index: usize) -> Option<Shape> {
        ffi::topo_maps::TopTools_IndexedMapOfShape_key(&self.inner, index as i32)
            .ok()
            .map(Shape::from_shape)
    }

    /// 1-based, 0 when absent.
    pub fn index_of(&self, shape: &Shape) -> usize {
        ffi::topo_maps::TopTools_IndexedMapOfShape_find_index(&self.inner, &shape.inner) as usize
    }

    /// The index `shape` has or was given.
    pub fn insert(&mut self, shape: &Shape) -> usize {
        ffi::topo_maps::TopTools_IndexedMapOfShape_add(self.inner.pin_mut(), &shape.inner) as usize
    }

    pub fn iter(&self) -> impl Iterator<Item = Shape> + '_ {
        (1..=self.len()).filter_map(|i| self.get(i))
    }
}

impl AncestorMap {
    pub fn len(&self) -> usize {
        self.inner.Extent() as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn key(&self, index: usize) -> Option<Shape> {
        ffi::topo_maps::TopTools_IndexedDataMapOfShapeListOfShape_key(&self.inner, index as i32)
            .ok()
            .map(Shape::from_shape)
    }

    /// 1-based, 0 when absent.
    pub fn index_of(&self, child: &Shape) -> usize {
        ffi::topo_maps::TopTools_IndexedDataMapOfShapeListOfShape_find_index(
            &self.inner,
            &child.inner,
        ) as usize
    }

    /// Parents of the child at `index`. A seam edge lists its face twice.
    pub fn ancestors_at(&self, index: usize) -> Vec<Shape> {
        match ffi::topo_maps::TopTools_IndexedDataMapOfShapeListOfShape_list(
            &self.inner,
            index as i32,
        ) {
            Ok(list) => shape_list(list),
            Err(_) => Vec::new(),
        }
    }

    pub fn ancestors(&self, child: &Shape) -> Vec<Shape> {
        match self.index_of(child) {
            0 => Vec::new(),
            i => self.ancestors_at(i),
        }
    }
}

/// First and Last cover the one and two element lists without walking them,
/// which is every manifold edge.
pub(crate) fn shape_list(list: &ffi::top_tools::TopTools_ListOfShape) -> Vec<Shape> {
    use ffi::topo_maps::{TopTools_ListOfShape_extent, TopTools_ListOfShape_first, TopTools_ListOfShape_last};
    let first = || TopTools_ListOfShape_first(list).map(Shape::from_shape);
    let last = || TopTools_ListOfShape_last(list).map(Shape::from_shape);
    match TopTools_ListOfShape_extent(list) {
        0 => Vec::new(),
        1 => first().into_iter().collect(),
        2 => first().into_iter().chain(last()).collect(),
        _ => ffi::topo_ds::shape_list_to_vector(list).iter().map(Shape::from_shape).collect(),
    }
}
