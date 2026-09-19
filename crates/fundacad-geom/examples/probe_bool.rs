use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, BoolKind};

fn main() {
    let path = std::env::args().nth(1).expect("doc");
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let doc: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let built = builder::rebuild(&doc, &raw, &NoWatch).ok().unwrap();
    let a = &built.bodies[0].shape;
    let t = &built.bodies[1].shape;
    let va = kernel::volume(a);
    println!("base {va} tool {} valid {} {} faces {} {}", kernel::volume(t), fundacad_geom::features::blend::ops::is_valid(a), fundacad_geom::features::blend::ops::is_valid(t), kernel::count(a, kernel::Kind::Face), kernel::count(t, kernel::Kind::Face));
    let p = kernel::boolean_op(a, &[t], BoolKind::Cut).map(|s| va - kernel::volume(&s));
    println!("parallel exact removed {p:?}");
    let s = kernel::serial_bool(a, &[t], BoolKind::Cut).map(|s| va - kernel::volume(&s));
    println!("serial picked fuzz removed {s:?}");
    for fz in [1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2] {
        let tc = kernel::compound([t]);
        let out = opencascade_sys::builder_ops::bo_boolean(a.raw(), tc.raw(), 1, false, fz, true);
        match out {
            Ok(o) if !o.is_null() => { let sh = opencascade::primitives::Shape::from_raw(o); println!("fuzz {fz} removed {}", va - kernel::volume(&sh)); }
            Ok(_) => println!("fuzz {fz} null"),
            Err(e) => println!("fuzz {fz} err {}", e.what()),
        }
    }
    let bx = kernel::translated(&kernel::make_box(30.0, 5.0, 600.0).unwrap(), [466.0, 361.5, 550.0]).unwrap();
    println!("box vol {}", kernel::volume(&bx));
    println!("common(tool, box) {:?}", kernel::boolean_op(t, &[&bx], BoolKind::Common).map(|s| kernel::volume(&s)));
    println!("common(base, box) {:?}", kernel::boolean_op(a, &[&bx], BoolKind::Common).map(|s| kernel::volume(&s)));
    println!("cut(box, tool) {:?}", kernel::boolean_op(&bx, &[t], BoolKind::Cut).map(|s| kernel::volume(&s)));
    let clip = kernel::boolean_op(a, &[&bx], BoolKind::Common).unwrap();
    println!("common(clip, tool) {:?}", kernel::boolean_op(&clip, &[t], BoolKind::Common).map(|s| kernel::volume(&s)));
    println!("cut(clip, tool) {:?}", kernel::boolean_op(&clip, &[t], BoolKind::Cut).map(|s| kernel::volume(&s)));
    let tc = kernel::clean(t).unwrap();
    let cc = kernel::clean(&clip).unwrap();
    println!("clean tool faces {} -> {}", kernel::count(t, kernel::Kind::Face), kernel::count(&tc, kernel::Kind::Face));
    println!("clean clip faces {} -> {}", kernel::count(&clip, kernel::Kind::Face), kernel::count(&cc, kernel::Kind::Face));
    println!("common(clip, clean tool) {:?}", kernel::boolean_op(&clip, &[&tc], BoolKind::Common).map(|s| kernel::volume(&s)));
    println!("common(clean clip, tool) {:?}", kernel::boolean_op(&cc, &[t], BoolKind::Common).map(|s| kernel::volume(&s)));
    println!("common(clean clip, clean tool) {:?}", kernel::boolean_op(&cc, &[&tc], BoolKind::Common).map(|s| kernel::volume(&s)));
    println!("common(tool, clip) {:?}", kernel::boolean_op(t, &[&clip], BoolKind::Common).map(|s| kernel::volume(&s)));
    let overlap = kernel::boolean_op(t, &[&clip], BoolKind::Common).unwrap();
    println!("cut(clip, overlap) {:?} expect {}", kernel::boolean_op(&clip, &[&overlap], BoolKind::Cut).map(|s| kernel::volume(&s)), kernel::volume(&clip) - kernel::volume(&overlap));
    let ov2 = kernel::boolean_op(t, &[a], BoolKind::Common).unwrap();
    println!("cut(base, overlap) {:?} expect {}", kernel::boolean_op(a, &[&ov2], BoolKind::Cut).map(|s| kernel::volume(&s)), va - kernel::volume(&ov2));
    let opts = || opencascade::shape_io::BrepWriteOptions { with_triangles: false, with_normals: false, version: 0 };
    let dir = std::env::var("DUMP").unwrap_or(".".into());
    std::fs::write(format!("{dir}/clip.bin"), clip.to_brep_bytes(opts(), &opencascade::progress::ProgressRange::detached()).unwrap()).unwrap();
    std::fs::write(format!("{dir}/tool.bin"), t.to_brep_bytes(opts(), &opencascade::progress::ProgressRange::detached()).unwrap()).unwrap();
    let c = kernel::boolean_op(a, &[t], BoolKind::Common).map(|s| kernel::volume(&s));
    println!("common {c:?}");
}
