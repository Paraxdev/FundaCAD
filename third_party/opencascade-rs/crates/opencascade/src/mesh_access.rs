//! Safe face and edge readback for a viewport mesh: the faces and the
//! edge-to-face map of one shape, indexed the way build123d's `faces()` and
//! `TopExp::MapShapesAndAncestors` index them.

use crate::primitives::Shape;
use cxx::UniquePtr;
use opencascade_sys::mesh_access as ffi;

/// Read a BREP from its text, the `BRepTools::Write` format.
pub fn read_brep_str(text: &str) -> Option<Shape> {
    let inner = ffi::mesh_access_read_brep(text);
    if inner.is_null() {
        None
    } else {
        Some(Shape { inner })
    }
}

/// `BRepBndLib::Add` with triangulation as `[xmin, ymin, zmin, xmax, ymax, zmax]`.
pub fn bnd_box(shape: &Shape) -> Option<[f64; 6]> {
    let mut v = Vec::new();
    if ffi::mesh_access_bnd_box(&shape.inner, &mut v) && v.len() == 6 {
        Some([v[0], v[1], v[2], v[3], v[4], v[5]])
    } else {
        None
    }
}

/// One face's triangulation: world-space nodes, 0-based triangles as stored
/// (not flipped for a reversed face), and surface normals when asked for and
/// available, following the surface rather than the face orientation.
#[derive(Debug, Default, Clone)]
pub struct FaceTriangulation {
    pub nodes: Vec<f64>,
    pub triangles: Vec<i32>,
    pub normals: Vec<f64>,
}

/// Where the stored mesh of a shape does not meet along its edges.
#[derive(Debug, Default, Clone)]
pub struct EdgeSplits {
    /// Every pair of points the mesh holds apart although they are the same
    /// step of one edge on two faces, or on the two sides of a seam.
    pub pairs: Vec<[[f64; 3]; 2]>,
    /// Edges whose faces hold a different number of points for them: a face
    /// mesh kept from an earlier run beside one made at another deflection.
    pub uneven: usize,
    /// The faces the mesher left without triangles, or with fewer than can
    /// fill their outline.
    pub unfilled: Vec<UnfilledFace>,
}

#[derive(Debug, Default, Clone)]
pub struct UnfilledFace {
    /// The diagonal of the face's box.
    pub size: f64,
    /// The points the face and the faces around it hold along its edges.
    pub points: Vec<[f64; 3]>,
}

pub struct MeshAccess {
    inner: UniquePtr<ffi::MeshAccess>,
    faces: usize,
    edges: usize,
}

impl MeshAccess {
    pub fn new(shape: &Shape) -> Self {
        let inner = ffi::mesh_access_new(&shape.inner);
        let (faces, edges) = match inner.as_ref() {
            Some(m) => (
                ffi::mesh_access_face_count(m).max(0) as usize,
                ffi::mesh_access_edge_count(m).max(0) as usize,
            ),
            None => (0, 0),
        };
        Self { inner, faces, edges }
    }

    /// Run `BRepMesh_IncrementalMesh` on the shape, storing the triangulation
    /// on its faces. `clean_first` drops a stored triangulation, which is
    /// otherwise kept whenever it is finer than the request.
    pub fn mesh(&self, linear: f64, relative: bool, angular: f64, clean_first: bool) -> bool {
        self.inner
            .as_ref()
            .is_some_and(|m| ffi::mesh_access_mesh(m, linear, relative, angular, true, clean_first))
    }

    /// Whether any face holds a triangulation, one kept from an earlier run
    /// until `mesh` is called here.
    pub fn has_mesh(&self) -> bool {
        self.inner.as_ref().is_some_and(ffi::mesh_access_has_mesh)
    }

    pub fn face_count(&self) -> usize {
        self.faces
    }

    pub fn edge_count(&self) -> usize {
        self.edges
    }

    fn face_ok(&self, face: usize) -> Option<(&ffi::MeshAccess, i32)> {
        if face < self.faces {
            self.inner.as_ref().map(|m| (m, face as i32))
        } else {
            None
        }
    }

    fn edge_ok(&self, edge: usize) -> Option<(&ffi::MeshAccess, i32)> {
        if edge < self.edges {
            self.inner.as_ref().map(|m| (m, edge as i32))
        } else {
            None
        }
    }

    pub fn face_reversed(&self, face: usize) -> bool {
        self.face_ok(face).is_some_and(|(m, f)| ffi::mesh_access_face_reversed(m, f))
    }

    /// The plane's axis direction when the face is planar.
    pub fn face_plane_normal(&self, face: usize) -> Option<[f64; 3]> {
        let (m, f) = self.face_ok(face)?;
        let mut v = Vec::new();
        (ffi::mesh_access_face_plane_normal(m, f, &mut v) && v.len() == 3).then(|| [v[0], v[1], v[2]])
    }

    /// `None` for a face with no triangulation.
    pub fn face_triangulation(&self, face: usize, with_normals: bool) -> Option<FaceTriangulation> {
        let (m, f) = self.face_ok(face)?;
        let mut t = FaceTriangulation::default();
        ffi::mesh_access_face_triangulation(
            m,
            f,
            with_normals,
            &mut t.nodes,
            &mut t.triangles,
            &mut t.normals,
        )
        .then_some(t)
    }

    /// Empty when the faces agree along every edge. A polygon found off its
    /// edge has that distance recorded as its deflection on the way.
    pub fn edge_splits(&self) -> EdgeSplits {
        let mut v = Vec::new();
        let mut uneven = 0;
        let Some(m) = self.inner.as_ref() else {
            return EdgeSplits::default();
        };
        if !ffi::mesh_access_edge_splits(m, &mut v, &mut uneven) {
            return EdgeSplits::default();
        }
        let mut flat = Vec::new();
        let mut unfilled = Vec::new();
        if ffi::mesh_access_unfilled_faces(m, &mut flat) {
            let mut rest = flat.as_slice();
            while let [size, n, tail @ ..] = rest {
                let (points, after) = tail.split_at((3 * *n as usize).min(tail.len()));
                let points = points.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
                unfilled.push(UnfilledFace { size: *size, points });
                rest = after;
            }
        }
        EdgeSplits {
            pairs: v.chunks_exact(6).map(|c| [[c[0], c[1], c[2]], [c[3], c[4], c[5]]]).collect(),
            uneven: uneven.max(0) as usize,
            unfilled,
        }
    }

    /// The face index of every entry in the edge's ancestor list; a seam's
    /// face appears once per side.
    pub fn edge_faces(&self, edge: usize) -> Vec<usize> {
        let mut v = Vec::new();
        if let Some((m, e)) = self.edge_ok(edge) {
            ffi::mesh_access_edge_faces(m, e, &mut v);
        }
        v.into_iter().map(|i| i.max(0) as usize).collect()
    }

    pub fn edge_degenerated(&self, edge: usize) -> bool {
        self.edge_ok(edge).is_some_and(|(m, e)| ffi::mesh_access_edge_degenerated(m, e))
    }

    /// `BRep_Tool::IsClosed` of the edge on its `ancestor`-th listed face.
    pub fn edge_closed_on(&self, edge: usize, ancestor: usize) -> bool {
        self.edge_ok(edge)
            .is_some_and(|(m, e)| ffi::mesh_access_edge_closed_on(m, e, ancestor as i32))
    }

    /// `Ok(Some(ends))` for a straight edge, `Ok(None)` for another curve,
    /// `Err(())` when the edge has no usable curve.
    #[allow(clippy::result_unit_err)]
    pub fn edge_line(&self, edge: usize) -> Result<Option<[[f64; 3]; 2]>, ()> {
        let (m, e) = self.edge_ok(edge).ok_or(())?;
        let mut v = Vec::new();
        match ffi::mesh_access_edge_line(m, e, &mut v) {
            1 if v.len() == 6 => Ok(Some([[v[0], v[1], v[2]], [v[3], v[4], v[5]]])),
            0 => Ok(None),
            _ => Err(()),
        }
    }

    /// The curve adaptor's parameter range.
    pub fn edge_range(&self, edge: usize) -> Option<(f64, f64)> {
        let (m, e) = self.edge_ok(edge)?;
        let (mut a, mut b) = (0.0, 0.0);
        ffi::mesh_access_edge_range(m, e, &mut a, &mut b).then_some((a, b))
    }

    pub fn edge_values(&self, edge: usize, params: &[f64]) -> Option<Vec<[f64; 3]>> {
        let (m, e) = self.edge_ok(edge)?;
        let mut v = Vec::new();
        ffi::mesh_access_edge_values(m, e, params, &mut v).then(|| triples(&v))
    }

    /// `GCPnts_QuasiUniformDeflection` points with their parameters.
    pub fn edge_deflection(&self, edge: usize, deflection: f64) -> Option<(Vec<[f64; 3]>, Vec<f64>)> {
        let (m, e) = self.edge_ok(edge)?;
        let (mut pts, mut params) = (Vec::new(), Vec::new());
        ffi::mesh_access_edge_deflection(m, e, deflection, &mut pts, &mut params)
            .then(|| (triples(&pts), params))
    }

    /// `BRep_Tool::Range`.
    pub fn edge_brep_range(&self, edge: usize) -> Option<(f64, f64)> {
        let (m, e) = self.edge_ok(edge)?;
        let (mut a, mut b) = (0.0, 0.0);
        ffi::mesh_access_edge_brep_range(m, e, &mut a, &mut b).then_some((a, b))
    }

    /// Whether the edge's two ancestor faces share a tangent plane along it,
    /// within `cos_tol`. One call so the pcurve and surface adaptors are built
    /// once for all three samples, which dominates the cost on an import.
    pub fn edge_smooth(&self, edge: usize, cos_tol: f64) -> bool {
        let Some((m, e)) = self.edge_ok(edge) else {
            return false;
        };
        ffi::mesh_access_edge_smooth(m, e, cos_tol) == 1
    }

    /// The largest curvature across the edge of its faces, per mm: a fillet of radius R reaches G2 and G3 there
    /// while it times R stays below 1e-6. 1e30 for an edge it cannot read or of three or more faces.
    pub fn edge_cross_curvature(&self, edge: usize) -> f64 {
        self.edge_ok(edge).map_or(1e30, |(m, e)| ffi::mesh_access_edge_cross_curvature(m, e))
    }

    /// The unnormalised `du x dv` of the `ancestor`-th face at edge parameter `t`.
    pub fn edge_face_normal(&self, edge: usize, ancestor: usize, t: f64) -> Option<[f64; 3]> {
        let (m, e) = self.edge_ok(edge)?;
        let mut v = Vec::new();
        (ffi::mesh_access_edge_face_normal(m, e, ancestor as i32, t, &mut v) && v.len() == 3)
            .then(|| [v[0], v[1], v[2]])
    }
}

fn triples(v: &[f64]) -> Vec<[f64; 3]> {
    v.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}
