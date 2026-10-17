//! Which bodies are traced and what has to be rebuilt when one changes. A mesh
//! is keyed like blasCache.ts keys a BLAS (owner, etag, geometry, versions), so
//! an edit arrives as a new key and rebuilds that body's BLAS only; a move or a
//! hide rebuilds the TLAS only; a colour or material change rebuilds nothing
//! and restarts the accumulation.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

use crate::material::{Group, PageMaterial};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub groups: Vec<Group>,
    /// Linear rgb per vertex, paint with the procedural bake composed in.
    pub colors: Option<Vec<[f32; 3]>>,
}

impl Mesh {
    pub fn tri_count(&self) -> usize {
        self.indices.len() / 3
    }
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BodyDesc {
    pub id: String,
    pub key: String,
    /// three.js matrixWorld.elements, column major.
    pub matrix: [f32; 16],
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub materials: Vec<PageMaterial>,
}

impl BodyDesc {
    /// Row major 3x4, the layout a TLAS instance takes.
    pub fn xf(&self) -> [f32; 12] {
        let e = &self.matrix;
        [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]]
    }
}

pub struct Instance<'a, B> {
    pub blas: &'a B,
    pub body: &'a BodyDesc,
    pub xf: [f32; 12],
}

pub trait Accel {
    type Blas;
    fn build_blas(&mut self, mesh: &Mesh) -> Self::Blas;
    fn build_tlas(&mut self, instances: &[Instance<'_, Self::Blas>]);
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Commit {
    pub blas_built: usize,
    pub tlas_built: bool,
    /// The shading buffers (geometry, colours) need uploading again.
    pub geometry: bool,
    /// The instance and material tables need uploading again.
    pub instances: bool,
    pub reset: bool,
}

struct Entry<B> {
    mesh: Mesh,
    blas: Option<B>,
}

pub struct Scene<A: Accel> {
    pub accel: A,
    meshes: BTreeMap<String, Entry<A::Blas>>,
    bodies: Vec<BodyDesc>,
    generation: u64,
    pending: Commit,
}

impl<A: Accel> Scene<A> {
    pub fn new(accel: A) -> Self {
        Scene { accel, meshes: BTreeMap::new(), bodies: Vec::new(), generation: 0, pending: Commit::default() }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// A frame traced for an older scene is stale and must not be shown.
    pub fn accepts(&self, generation: u64) -> bool {
        generation == self.generation
    }

    pub fn bodies(&self) -> &[BodyDesc] {
        &self.bodies
    }

    /// Replaces the body list and answers the mesh keys still missing.
    pub fn set_bodies(&mut self, bodies: Vec<BodyDesc>) -> Vec<String> {
        let placed = |b: &[BodyDesc]| -> Vec<(String, [f32; 16])> {
            b.iter().filter(|b| b.visible).map(|b| (b.key.clone(), b.matrix)).collect()
        };
        if placed(&self.bodies) != placed(&bodies) {
            self.pending.tlas_built = true;
            self.pending.instances = true;
        }
        let mats = |b: &[BodyDesc]| -> Vec<(String, Vec<PageMaterial>)> {
            b.iter().map(|b| (b.id.clone(), b.materials.clone())).collect()
        };
        if mats(&self.bodies) != mats(&bodies) {
            self.pending.instances = true;
        }
        if self.bodies != bodies {
            self.pending.reset = true;
        }
        self.bodies = bodies;
        let mut seen = BTreeSet::new();
        self.bodies
            .iter()
            .filter(|b| !self.meshes.contains_key(&b.key) && seen.insert(b.key.clone()))
            .map(|b| b.key.clone())
            .collect()
    }

    pub fn add_mesh(&mut self, key: &str, mesh: Mesh) {
        self.meshes.insert(key.to_string(), Entry { mesh, blas: None });
        self.pending.geometry = true;
        self.pending.reset = true;
    }

    pub fn set_colors(&mut self, key: &str, colors: Option<Vec<[f32; 3]>>) -> bool {
        let Some(e) = self.meshes.get_mut(key) else { return false };
        e.mesh.colors = colors;
        self.pending.geometry = true;
        self.pending.reset = true;
        true
    }

    /// Restarts the accumulation for a camera or look change.
    pub fn touch(&mut self) {
        self.pending.reset = true;
    }

    pub fn commit(&mut self) -> Commit {
        let used: BTreeSet<&str> = self.bodies.iter().map(|b| b.key.as_str()).collect();
        let before = self.meshes.len();
        self.meshes.retain(|k, _| used.contains(k.as_str()));
        if self.meshes.len() != before {
            self.pending.geometry = true;
        }
        let mut built = 0;
        for e in self.meshes.values_mut() {
            if e.blas.is_none() {
                e.blas = Some(self.accel.build_blas(&e.mesh));
                built += 1;
            }
        }
        let mut c = std::mem::take(&mut self.pending);
        c.blas_built = built;
        if built > 0 {
            c.tlas_built = true;
            c.instances = true;
        }
        if c.tlas_built {
            let inst = instances_of(&self.bodies, &self.meshes);
            self.accel.build_tlas(&inst);
        }
        if c.blas_built > 0 || c.tlas_built || c.geometry || c.instances || c.reset {
            c.reset = true;
            self.generation += 1;
        }
        c
    }

    /// The visible bodies whose mesh has arrived, in body order: TLAS instance
    /// i and instance table row i are the same body.
    pub fn instances(&self) -> Vec<Instance<'_, A::Blas>> {
        instances_of(&self.bodies, &self.meshes)
    }

    pub fn meshes(&self) -> impl Iterator<Item = (&str, &Mesh, Option<&A::Blas>)> {
        self.meshes.iter().map(|(k, e)| (k.as_str(), &e.mesh, e.blas.as_ref()))
    }

    pub fn mesh(&self, key: &str) -> Option<&Mesh> {
        self.meshes.get(key).map(|e| &e.mesh)
    }
}

/// The visible bodies whose mesh has arrived, in body order: TLAS instance i
/// and instance table row i are the same body.
fn instances_of<'a, B>(bodies: &'a [BodyDesc], meshes: &'a BTreeMap<String, Entry<B>>) -> Vec<Instance<'a, B>> {
    bodies
        .iter()
        .filter(|b| b.visible)
        .filter_map(|b| {
            let blas = meshes.get(&b.key)?.blas.as_ref()?;
            Some(Instance { blas, body: b, xf: b.xf() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Count {
        blas: usize,
        tlas: usize,
        last_instances: usize,
    }
    impl Accel for Count {
        type Blas = usize;
        fn build_blas(&mut self, _: &Mesh) -> usize {
            self.blas += 1;
            self.blas
        }
        fn build_tlas(&mut self, inst: &[Instance<'_, usize>]) {
            self.tlas += 1;
            self.last_instances = inst.len();
        }
    }

    const I: [f32; 16] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];

    fn body(id: &str, key: &str) -> BodyDesc {
        BodyDesc { id: id.into(), key: key.into(), matrix: I, visible: true, materials: vec![PageMaterial::default()] }
    }

    fn tri() -> Mesh {
        Mesh {
            positions: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
            normals: vec![[0., 0., 1.]; 3],
            indices: vec![0, 1, 2],
            ..Default::default()
        }
    }

    fn deltas(s: &mut Scene<Count>, f: impl FnOnce(&mut Scene<Count>)) -> (usize, usize, Commit) {
        let (b, t) = (s.accel.blas, s.accel.tlas);
        f(s);
        let c = s.commit();
        (s.accel.blas - b, s.accel.tlas - t, c)
    }

    fn fill(s: &mut Scene<Count>, bodies: Vec<BodyDesc>) {
        for k in s.set_bodies(bodies) {
            s.add_mesh(&k, tri());
        }
    }

    #[test]
    fn edits_rebuild_only_what_they_touch() {
        let mut s = Scene::new(Count::default());
        let (b, t, _) = deltas(&mut s, |s| fill(s, vec![body("A", "a1"), body("B", "b1")]));
        assert_eq!((b, t), (2, 1));
        let g = s.generation();

        let (b, t, _) = deltas(&mut s, |s| fill(s, vec![body("A", "a2"), body("B", "b1")]));
        assert_eq!((b, t), (1, 1), "a new etag on A");
        assert!(s.mesh("a1").is_none(), "A's old mesh is dropped");
        assert!(!s.accepts(g) && s.accepts(s.generation()));

        let mut moved = body("A", "a2");
        moved.matrix[12] = 5.0;
        let (b, t, c) = deltas(&mut s, |s| fill(s, vec![moved.clone(), body("B", "b1")]));
        assert_eq!((b, t, c.geometry), (0, 1, false), "a move");

        let mut red = moved.clone();
        red.materials[0].color = Some([1., 0., 0.]);
        let (b, t, c) = deltas(&mut s, |s| fill(s, vec![red.clone(), body("B", "b1")]));
        assert_eq!((b, t, c.instances, c.reset), (0, 0, true, true), "a material");
        let (b, t, c) = deltas(&mut s, |s| {
            s.set_colors("b1", Some(vec![[1., 0., 0.]; 3]));
        });
        assert_eq!((b, t, c.geometry, c.reset), (0, 0, true, true), "colours");

        let mut hidden = body("B", "b1");
        hidden.visible = false;
        let (b, t, _) = deltas(&mut s, |s| fill(s, vec![red.clone(), hidden.clone()]));
        assert_eq!((b, t, s.accel.last_instances), (0, 1, 1), "B hidden");
        assert!(s.mesh("b1").is_some(), "a hidden body keeps its BLAS");
        let (b, t, _) = deltas(&mut s, |s| fill(s, vec![red.clone(), body("B", "b1")]));
        assert_eq!((b, t, s.accel.last_instances), (0, 1, 2), "B shown again");

        let (b, t, c) = deltas(&mut s, |s| fill(s, vec![body("B", "b1")]));
        assert_eq!((b, t, c.geometry), (0, 1, true), "A removed");
        assert!(s.mesh("a2").is_none());

        let g = s.generation();
        let (b, t, c) = deltas(&mut s, |s| fill(s, vec![body("B", "b1")]));
        assert_eq!((b, t, c.reset, s.generation()), (0, 0, false, g), "nothing changed");
    }

    #[test]
    fn missing_keys_are_asked_once() {
        let mut s = Scene::new(Count::default());
        let missing = s.set_bodies(vec![body("A", "k"), body("B", "k")]);
        assert_eq!(missing, vec!["k".to_string()]);
        s.add_mesh("k", tri());
        assert!(s.set_bodies(vec![body("A", "k"), body("B", "k")]).is_empty());
        assert_eq!(s.commit().blas_built, 1);
    }

    #[test]
    fn matrices_go_row_major() {
        let mut b = body("A", "a");
        b.matrix[12] = 7.0;
        b.matrix[1] = 2.0;
        assert_eq!(b.xf(), [1., 0., 0., 7., 2., 1., 0., 0., 0., 0., 1., 0.]);
    }
}
