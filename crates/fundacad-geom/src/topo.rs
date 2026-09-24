//! Which faces of a shape touch which, the Python engine's `topo_adj.py`.
//!
//! "Share an edge" means the same TShape through the kernel's own ancestor
//! map, so two bodies pressed face to face are not adjacent.

use std::collections::BTreeSet;

use opencascade::primitives::{Shape, ShapeType};
use opencascade::topology::{AncestorMap, ShapeMap};

/// `face_wraps`: the face closes on itself in u or v.
pub fn face_wraps(face: &Shape) -> bool {
    face.as_face().is_some_and(|f| f.wraps())
}

/// `FaceAdjacency`: OCCT's 1-based face indices, dense over `extent`.
pub struct FaceAdjacency {
    faces: ShapeMap,
    edges: AncestorMap,
}

impl FaceAdjacency {
    pub fn new(shape: &Shape) -> FaceAdjacency {
        FaceAdjacency {
            faces: shape.shape_map(ShapeType::Face),
            edges: shape.ancestor_map(ShapeType::Edge, ShapeType::Face),
        }
    }

    pub fn extent(&self) -> usize {
        self.faces.len()
    }

    pub fn indices(&self) -> std::ops::RangeInclusive<usize> {
        1..=self.extent()
    }

    /// The face at `i`, an empty shape when out of range.
    pub fn face(&self, i: usize) -> Shape {
        self.faces.get(i).unwrap_or_else(Shape::empty)
    }

    /// 0 when `face` is not a face of this shape.
    pub fn index_of(&self, face: &Shape) -> usize {
        self.faces.index_of(face)
    }

    /// (other face, shared edge) over face `i`'s edges, a neighbour once per
    /// shared edge; a seam lists its own face and is skipped.
    pub fn walk(&self, i: usize) -> Vec<(usize, Shape)> {
        let mut out = Vec::new();
        if i == 0 || i > self.extent() {
            return out;
        }
        for edge in self.face(i).subshapes(ShapeType::Edge) {
            for other in self.edges.ancestors(&edge) {
                let j = self.faces.index_of(&other);
                if j != i {
                    out.push((j, edge.clone()));
                }
            }
        }
        out
    }

    /// The face indices an edge belongs to, in map order: one for a free
    /// boundary, the same index twice for a seam.
    pub fn faces_of_edge(&self, edge: &Shape) -> Vec<usize> {
        self.edges
            .ancestors(edge)
            .iter()
            .map(|f| self.faces.index_of(f))
            .collect()
    }

    /// Both sides of the edge are one face, the line where a wrapping face
    /// closes on itself.
    pub fn is_seam(&self, edge: &Shape) -> bool {
        let faces = self.faces_of_edge(edge);
        faces.len() == 2 && faces[0] == faces[1] && faces[0] != 0
    }

    pub fn neighbors(&self, i: usize) -> BTreeSet<usize> {
        self.walk(i).into_iter().map(|(j, _)| j).collect()
    }

    /// The edge-connected groups of face indices, lowest seed first.
    pub fn components(&self) -> Vec<Vec<usize>> {
        let mut unvisited: BTreeSet<usize> = self.indices().collect();
        let mut out = Vec::new();
        while let Some(seed) = unvisited.pop_first() {
            let (mut group, mut queue) = (vec![seed], vec![seed]);
            while let Some(k) = queue.pop() {
                for (j, _) in self.walk(k) {
                    if unvisited.remove(&j) {
                        group.push(j);
                        queue.push(j);
                    }
                }
            }
            out.push(group);
        }
        out
    }
}
