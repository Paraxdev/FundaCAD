use fundacad_tracer::material::PageMaterial;
use fundacad_tracer::scene::{INST_EMITTERS, INST_RELIEF, NO_EMITTERS};
use fundacad_tracer::{pack_inst, Accel, BodyDesc, Commit, GpuInst, Instance, Mesh, Scene};

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

#[test]
fn the_inst_pack_is_ten_vec4_with_relief_and_emitters_off() {
    assert_eq!(std::mem::size_of::<GpuInst>(), 160);
    let xf = [2., 0., 0., 1., 0., 1., 0., 2., 0., 0., 1., 3.];
    let i = pack_inst(&xf, [10, 20, 30, 40], 5, 3);
    assert_eq!(i.o2w, xf);
    assert_eq!(i.w2o, [0.5, 0., 0., -0.5, 0., 1., 0., -2., 0., 0., 1., -3.]);
    assert_eq!(i.base, [10, 20, 5, 30]);
    assert_eq!(i.extra, [40, 3, 0, NO_EMITTERS]);
    assert_eq!(i.extra[2] & (INST_RELIEF | INST_EMITTERS), 0);
    assert_eq!((i.relief0, i.relief1), ([0.0; 4], [0.0; 4]));
}
