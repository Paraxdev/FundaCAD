//! Separate on a body that is not intact: the face colours are packed over the
//! raw solids, debris included, so each piece must read its own run.

use fundacad_core::schema::Feature;
use fundacad_geom::builder::{Ctx, ImportedMeta};
use fundacad_geom::features;
use fundacad_geom::kernel::{self, Kind};
use opencascade::primitives::Shape;
use serde_json::{json, Value};

fn box_at(x: f64, l: f64) -> Shape {
    let b = kernel::make_box(l, l, l).expect("a box");
    kernel::translated(&b, [x, 0.0, 0.0]).expect("moved")
}

fn painted(parts: &[(&str, Shape)]) -> (Shape, Value) {
    let shapes: Vec<_> = parts.iter().map(|(_, s)| s).collect();
    let mut all: Vec<Option<String>> = Vec::new();
    for (color, s) in parts {
        all.extend(vec![Some((*color).to_owned()); kernel::count(s, Kind::Face)]);
    }
    let runs = serde_json::to_value(fundacad_core::face_colors::encode(&all)).expect("encodes");
    (kernel::compound(shapes), runs)
}

fn colours_of(ctx: &Ctx, at: usize) -> Vec<Option<String>> {
    let b = &ctx.bodies[at];
    fundacad_core::face_colors::decode_value(b.face_colors.as_ref(), kernel::count(b.shape(), Kind::Face))
}

fn separated() -> Ctx {
    let (shape, runs) = painted(&[
        ("#ffff00", box_at(200.0, 1e-4)),
        ("#00ff00", box_at(50.0, 8.0)),
        ("#ff0000", box_at(0.0, 10.0)),
    ]);
    let mut ctx = Ctx::detached();
    let meta = ImportedMeta { face_colors: Some(runs), ..Default::default() };
    ctx.new_body_with(shape, Some("Part".into()), None, meta);
    let f: Feature = serde_json::from_value(json!({"id": "sep", "type": "separate"})).expect("feature");
    features::dispatch(&mut ctx, &f).expect("separates");
    ctx
}

#[test]
fn a_leading_debris_solid_does_not_shift_the_colours_of_the_pieces() {
    let ctx = separated();
    assert_eq!(ctx.bodies.len(), 2, "debris is not a piece");
    for (at, want) in [(0, "#ff0000"), (1, "#00ff00")] {
        let got = colours_of(&ctx, at);
        assert!(got.iter().all(|c| c.as_deref() == Some(want)), "body {at}: {got:?}");
    }
}

#[test]
fn the_engine_says_which_faces_each_piece_came_from() {
    let ctx = separated();
    let note = ctx
        .diagnostics
        .iter()
        .find(|d| d["kind"] == "separateFaces")
        .expect("a separateFaces diagnostic");
    assert_eq!(note["feature_id"], "sep");
    let span = |body: &str| {
        let p = note["pieces"].as_array().expect("pieces").iter().find(|p| p["body"] == body).expect("piece");
        (p["from"].as_u64().expect("from"), p["count"].as_u64().expect("count"))
    };
    assert_eq!(span(&ctx.bodies[0].id), (6, 6));
    assert_eq!(span(&ctx.bodies[1].id), (0, 6));
}
