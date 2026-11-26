use std::collections::HashMap;
use std::sync::Arc;

use glam::Vec3;

pub use fundacad_client::Body;

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub face: u32,
}

impl Vertex {
    pub fn position(&self) -> Vec3 {
        Vec3::from(self.position)
    }

    pub fn normal(&self) -> Vec3 {
        Vec3::from(self.normal)
    }
}

/// A body as the viewport draws and picks it: no vertex is shared between two faces, so each vertex knows its face.
pub struct SceneBody {
    pub source: Arc<Body>,
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
}

impl SceneBody {
    pub fn new(source: Arc<Body>) -> Self {
        let b = &*source;
        let at = |v: u32| {
            let i = v as usize * 3;
            Vec3::new(b.positions[i], b.positions[i + 1], b.positions[i + 2])
        };
        let given = |v: u32| {
            b.normals.as_ref().map(|n| {
                let i = v as usize * 3;
                Vec3::new(n[i], n[i + 1], n[i + 2])
            })
        };
        let mut split: HashMap<(u32, u32), u32> = HashMap::new();
        let mut vertices = Vec::with_capacity(b.positions.len() / 3);
        let mut indices = Vec::with_capacity(b.indices.len());
        for (t, tri) in b.indices.chunks_exact(3).enumerate() {
            let face = b.face_ids.get(t).copied().unwrap_or(t as u32);
            let flat = (at(tri[1]) - at(tri[0])).cross(at(tri[2]) - at(tri[0])).normalize_or_zero();
            for &v in tri {
                let index = *split.entry((v, face)).or_insert_with(|| {
                    vertices.push(Vertex { position: at(v).into(), normal: given(v).unwrap_or(flat).into(), face });
                    vertices.len() as u32 - 1
                });
                indices.push(index);
            }
        }
        Self { source, vertices, indices }
    }

    pub fn owner(&self, face: u32) -> Option<&str> {
        self.source.face_owners.get(face as usize)?.as_deref()
    }
}

#[derive(Default)]
pub struct Scene {
    pub bodies: Vec<SceneBody>,
    /// Bumped on every change, so the renderer knows to sync.
    pub revision: u64,
}

impl Scene {
    pub fn set(&mut self, bodies: &[Arc<Body>]) {
        let mut old: Vec<Option<SceneBody>> = std::mem::take(&mut self.bodies).into_iter().map(Some).collect();
        self.bodies = bodies
            .iter()
            .map(|b| {
                let kept = old.iter_mut().find(|o| o.as_ref().is_some_and(|o| Arc::ptr_eq(&o.source, b)));
                kept.and_then(Option::take).unwrap_or_else(|| SceneBody::new(b.clone()))
            })
            .collect();
        self.revision += 1;
    }

    pub fn body_index(&self, id: &str) -> Option<usize> {
        self.bodies.iter().position(|b| b.source.id == id)
    }

    pub fn triangles(&self) -> usize {
        self.bodies.iter().map(|b| b.indices.len() / 3).sum()
    }

    /// Centre and radius of a sphere around every vertex.
    pub fn bounds(&self) -> Option<(Vec3, f32)> {
        let mut iter = self.bodies.iter().flat_map(|b| b.vertices.iter().map(Vertex::position));
        let first = iter.next()?;
        let (min, max) = iter.fold((first, first), |(lo, hi), p| (lo.min(p), hi.max(p)));
        let centre = (min + max) * 0.5;
        Some((centre, (max - centre).length()))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A box from `min` to `max` with one face per side, every face owned by `owner`. Faces: 0 -X, 1 +X, 2 -Y,
    /// 3 +Y, 4 -Z, 5 +Z.
    pub fn block(min: Vec3, max: Vec3, owner: &str) -> Body {
        let mut positions = Vec::new();
        let mut normals = Vec::new();
        let mut indices = Vec::new();
        let mut face_ids = Vec::new();
        for (face, (axis, high)) in
            [(0, false), (0, true), (1, false), (1, true), (2, false), (2, true)].into_iter().enumerate()
        {
            let n = Vec3::AXES[axis] * if high { 1.0 } else { -1.0 };
            let (u, v) = (Vec3::AXES[(axis + 1) % 3], Vec3::AXES[(axis + 2) % 3]);
            let base = positions.len() as u32 / 3;
            for (a, b) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)] {
                let mut p = min + (max - min) * (u * a + v * b);
                p[axis] = if high { max[axis] } else { min[axis] };
                positions.extend(p.to_array());
                normals.extend(n.to_array());
            }
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
            face_ids.extend([face as u32, face as u32]);
        }
        Body {
            id: "body1".into(),
            positions,
            normals: Some(normals),
            indices,
            face_ids,
            face_owners: vec![Some(owner.into()); 6],
            ..Default::default()
        }
    }

    #[test]
    fn splits_vertices_between_faces() {
        let mut positions = vec![0.0f32; 12];
        positions[3] = 1.0;
        positions[7] = 1.0;
        positions[11] = 1.0;
        let body = Body {
            positions,
            indices: vec![0, 1, 2, 0, 2, 3],
            face_ids: vec![0, 1],
            face_owners: vec![Some("ex1".into()), None],
            ..Default::default()
        };
        let b = SceneBody::new(Arc::new(body));
        assert_eq!(b.vertices.len(), 6);
        assert_eq!(b.owner(0), Some("ex1"));
        assert_eq!(b.owner(1), None);
        assert!(b.indices[..3].iter().all(|&i| b.vertices[i as usize].face == 0));
        assert!(b.indices[3..].iter().all(|&i| b.vertices[i as usize].face == 1));
    }

    #[test]
    fn keeps_unchanged_bodies() {
        let a = Arc::new(block(Vec3::ZERO, Vec3::ONE, "ex1"));
        let mut scene = Scene::default();
        scene.set(&[a.clone()]);
        let first = scene.bodies[0].vertices.as_ptr();
        scene.set(&[a]);
        assert_eq!(scene.bodies[0].vertices.as_ptr(), first);
        assert_eq!(scene.revision, 2);
    }
}
