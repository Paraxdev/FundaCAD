//! Triangle meshes made into B-rep: sewn facets, merged coplanar faces, the
//! face facts and planar rebuild of an import's facet cleanup.

use crate::primitives::Shape;
use crate::Error;
use cxx::UniquePtr;
use opencascade_sys::mesh_import as ffi;

fn own(inner: UniquePtr<opencascade_sys::topo_ds::TopoDS_Shape>) -> Result<Shape, Error> {
    if inner.is_null() {
        Err(Error::OperationFailed("the mesh import"))
    } else {
        Ok(Shape { inner })
    }
}

/// One planar face per triangle, zero area ones dropped, sewn; a watertight
/// outer shell becomes a solid with the other shells as voids, else the outer
/// shell alone comes back.
pub fn sew_triangles(positions: &[f64], indices: &[u32]) -> Result<Shape, Error> {
    own(ffi::mesh_import_sew(positions, indices)?)
}

/// `ShapeUpgrade_UnifySameDomain` merging faces and edges, the input back when
/// it leaves no face.
pub fn unify(shape: &Shape) -> Result<Shape, Error> {
    own(ffi::mesh_import_unify(&shape.inner)?)
}

/// A body per shell of every solid, then the non-solid children of a compound.
pub fn explode_solids(shape: &Shape) -> Result<Vec<Shape>, Error> {
    let v = ffi::mesh_import_explode(&shape.inner)?;
    let mut out = Vec::new();
    if let Some(list) = v.as_ref() {
        for i in 0..ffi::mesh_import_shapes_len(list) {
            out.push(own(ffi::mesh_import_shapes_get(list, i)?)?);
        }
    }
    Ok(out)
}

/// A planar face's area, centre of mass and oriented normal.
pub struct FacePlane {
    pub area: f64,
    pub centre: [f64; 3],
    pub normal: [f64; 3],
}

/// Faces of a shape in `TopExp::MapShapes` order.
pub struct FaceFacts {
    inner: UniquePtr<ffi::FaceFacts>,
}

impl FaceFacts {
    pub fn new(shape: &Shape) -> Result<Self, Error> {
        Ok(Self { inner: ffi::face_facts_new(&shape.inner)? })
    }

    fn get(&self) -> Result<&ffi::FaceFacts, Error> {
        self.inner.as_ref().ok_or(Error::OperationFailed("reading the faces"))
    }

    pub fn count(&self) -> usize {
        self.get().map_or(0, |f| ffi::face_facts_count(f).max(0) as usize)
    }

    pub fn all_planar(&self) -> Result<bool, Error> {
        Ok(ffi::face_facts_all_planar(self.get()?)?)
    }

    pub fn plane(&self, face: usize) -> Result<FacePlane, Error> {
        let v = ffi::face_facts_plane(self.get()?, face as i32)?;
        Ok(FacePlane { area: v[0], centre: [v[1], v[2], v[3]], normal: [v[4], v[5], v[6]] })
    }

    pub fn vertices(&self, face: usize) -> Result<Vec<[f64; 3]>, Error> {
        let v = ffi::face_facts_vertices(self.get()?, face as i32)?;
        Ok(v.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
    }

    pub fn neighbors(&self, face: usize) -> Result<Vec<usize>, Error> {
        let v = ffi::face_facts_neighbors(self.get()?, face as i32)?;
        Ok(v.iter().map(|&j| j as usize).collect())
    }
}

/// Planar faces rebuilt from boundary loops, then sewn into solids.
pub struct PlanarRebuild {
    inner: UniquePtr<ffi::PlanarRebuild>,
}

impl Default for PlanarRebuild {
    fn default() -> Self {
        Self { inner: ffi::planar_rebuild_new() }
    }
}

impl PlanarRebuild {
    /// `loops` largest first, each a list of points on the plane. False when
    /// the face cannot be made.
    pub fn add_region(&mut self, origin: [f64; 3], normal: [f64; 3], loops: &[Vec<[f64; 3]>]) -> Result<bool, Error> {
        let plane = [origin[0], origin[1], origin[2], normal[0], normal[1], normal[2]];
        let points: Vec<f64> = loops.iter().flatten().flatten().copied().collect();
        let lens: Vec<u32> = loops.iter().map(|l| l.len() as u32).collect();
        Ok(ffi::planar_rebuild_add(self.inner.pin_mut(), &plane, &points, &lens)?)
    }

    pub fn finish(&self, sew_tolerance: f64) -> Result<Option<Shape>, Error> {
        let r = self.inner.as_ref().ok_or(Error::OperationFailed("the planar rebuild"))?;
        let inner = ffi::planar_rebuild_finish(r, sew_tolerance)?;
        Ok((!inner.is_null()).then_some(Shape { inner }))
    }
}
