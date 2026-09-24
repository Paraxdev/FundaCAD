//! Datum planes and axes, the Python engine's `builder.py` `_handle_datum_plane` and
//! `_handle_datum_axis`.
//!
//! A datum plane made on a face follows it (face_anchor.rs) and an axis made
//! on an edge re-resolves that edge. A reference that stops resolving is not an
//! error: the datum keeps the cached placement the document stored.

use fundacad_core::schema::{DatumAxis, DatumPlane, OneOrMany};
use opencascade::primitives::Shape;
use opencascade::select_access::CurveType;
use serde_json::json;

use glam::{DMat3, DQuat, DVec3};

use crate::select::{entity::EdgeEnt, Resolver};

use crate::builder::plane::{plane_of, PlaneRecord, PlaneRef};
use crate::kernel::Frame;
use super::face_anchor::face_anchor_plane;
use crate::builder::{Ctx, FResult};

pub fn datum_plane(ctx: &mut Ctx, f: &DatumPlane) -> FResult {
    let parent = f
        .plane_id
        .as_deref()
        .filter(|p| !p.is_empty() && *p != f.id)
        .and_then(|p| ctx.datums.get(p).copied());
    let spec = match parent {
        Some(rec) => PlaneRef::Record(rec),
        None => match face_anchor_plane(ctx, &f.id, f.face.as_ref(), f.at.as_ref(), &f.plane, "Plane") {
            Some(p) => PlaneRef::Record(p.record()),
            None => PlaneRef::from(&f.plane),
        },
    };
    let base = plane_of(spec, &ctx.datums)?;
    let pose = Pose {
        shift: [
            ctx.val_or(f.shift_x.as_ref(), 0.0)?,
            ctx.val_or(f.shift_y.as_ref(), 0.0)?,
            ctx.val_or(f.offset.as_ref(), 0.0)?,
        ],
        tilt_x: ctx.val_or(f.tilt_x.as_ref(), 0.0)?,
        tilt_y: ctx.val_or(f.tilt_y.as_ref(), 0.0)?,
        spin: ctx.val_or(f.spin.as_ref(), 0.0)?,
    };
    ctx.datums.insert(f.id.clone(), place(&base, &pose));
    Ok(())
}

/// Where a datum sits relative to its reference: `shift` in the reference's
/// own x, y and normal, then the turns in degrees about that point.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Pose {
    pub shift: [f64; 3],
    pub tilt_x: f64,
    pub tilt_y: f64,
    pub spin: f64,
}

/// The reference frame moved by `pose`. The turns are intrinsic X then Y then
/// Z, so each one is about an axis the later ones leave alone, which is what
/// lets a gizmo drag one angle without disturbing the others.
pub fn place(base: &Frame, pose: &Pose) -> PlaneRecord {
    let (x, y, z) = (DVec3::from(base.x), DVec3::from(base.y), DVec3::from(base.z));
    let o = DVec3::from(base.origin) + x * pose.shift[0] + y * pose.shift[1] + z * pose.shift[2];
    if pose.tilt_x == 0.0 && pose.tilt_y == 0.0 && pose.spin == 0.0 {
        return PlaneRecord { origin: o.to_array(), xdir: base.x, normal: base.z };
    }
    let local = DQuat::from_rotation_x(pose.tilt_x.to_radians())
        * DQuat::from_rotation_y(pose.tilt_y.to_radians())
        * DQuat::from_rotation_z(pose.spin.to_radians());
    let world = DMat3::from_cols(x, y, z) * DMat3::from_quat(local);
    PlaneRecord {
        origin: o.to_array(),
        xdir: clean(world.x_axis).to_array(),
        normal: clean(world.z_axis).to_array(),
    }
}

/// Snaps components within a rounding error of 0 or 1 so a 90 degree turn
/// reports an exact axis rather than 6e-17 noise.
fn clean(v: DVec3) -> DVec3 {
    let c = |a: f64| {
        let r = a.round();
        if (a - r).abs() < 1e-12 { r } else { a }
    };
    DVec3::new(c(v.x), c(v.y), c(v.z)) + DVec3::ZERO
}

/// `_handle_datum_axis`: an axis anchored to an edge re-resolves it every
/// rebuild, `origin` and `dir` being the fallback cache. Resolution is global
/// across bodies, a body id can come to name a different piece.
pub fn datum_axis(ctx: &mut Ctx, f: &DatumAxis) -> FResult {
    let Some(sel) = f.axis_edge.clone() else {
        return Ok(());
    };
    let shapes: Vec<Shape> = ctx.shapes().into_iter().cloned().collect();
    for shape in &shapes {
        let mut diag = std::mem::take(&mut ctx.diagnostics);
        let found = Resolver::new(Some(&mut diag), Some(&f.id))
            .edge_selectors(shape, &OneOrMany::One(sel.clone()));
        ctx.diagnostics = diag;
        let Ok(edges) = found else { continue };
        for e in edges {
            let Ok(ent) = EdgeEnt::new(e) else { continue };
            if ent.curve != CurveType::Line {
                continue;
            }
            ctx.datum_marks.insert(
                f.id.clone(),
                json!({"kind": "axis", "origin": ent.mid.to_array(), "dir": ent.dir().to_array()}),
            );
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::builder::{self, NoWatch};
    use crate::kernel;
    use serde_json::json;

    #[test]
    fn an_axis_on_an_edge_publishes_where_that_edge_is_now() {
        let doc = json!({"features": [
            {"id": "a", "type": "box", "length": 20, "width": 20, "height": 20},
            {"id": "ax", "type": "datumAxis", "origin": [0, 0, 0], "dir": [1, 0, 0],
             "axisEdge": {"kind": "edge", "by": "nearest", "point": [10, 0, 10], "body": "body1"}},
        ]});
        let typed = serde_json::from_value(doc.clone()).expect("the document parses");
        let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let mark = &r.datum_marks["ax"];
        assert_eq!(mark["kind"], "axis");
        let at = |k: &str, i: usize| mark[k][i].as_f64().unwrap_or(f64::NAN);
        assert!((at("origin", 0) - 10.0).abs() < 1e-9 && (at("origin", 2) - 10.0).abs() < 1e-9);
        assert!((at("dir", 1).abs() - 1.0).abs() < 1e-9, "along the edge: {mark}");
    }

    fn build(doc: serde_json::Value) -> builder::Rebuild {
        let typed = serde_json::from_value(doc.clone()).expect("the document parses");
        let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
        assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
        r
    }

    fn near(a: [f64; 3], b: [f64; 3]) -> bool {
        (0..3).all(|i| (a[i] - b[i]).abs() < 1e-9)
    }

    #[test]
    fn a_tilted_plane_turns_about_its_reference_x_through_the_offset_point() {
        let r = build(json!({"features": [
            {"id": "p", "type": "datumPlane", "plane": "XY", "offset": 20, "tiltX": 30},
        ]}));
        let p = r.datum_planes["p"];
        let (s, c) = (30f64.to_radians().sin(), 30f64.to_radians().cos());
        assert!(near(p.origin, [0.0, 0.0, 20.0]), "{p:?}");
        assert!(near(p.normal, [0.0, -s, c]), "{p:?}");
        assert!(near(p.xdir, [1.0, 0.0, 0.0]), "{p:?}");
    }

    #[test]
    fn tilts_and_spin_compose_in_one_fixed_order() {
        let r = build(json!({"features": [
            {"id": "p", "type": "datumPlane", "plane": "XY", "tiltX": 90, "spin": 90},
            {"id": "q", "type": "datumPlane", "plane": "XY", "tiltY": 90, "shiftX": 5, "shiftY": -3},
        ]}));
        let p = r.datum_planes["p"];
        // tiltX 90 lays the normal on -Y, the spin then turns x onto the new y, +Z
        assert!(near(p.normal, [0.0, -1.0, 0.0]) && near(p.xdir, [0.0, 0.0, 1.0]), "{p:?}");
        let q = r.datum_planes["q"];
        assert!(near(q.origin, [5.0, -3.0, 0.0]), "{q:?}");
        assert!(near(q.normal, [1.0, 0.0, 0.0]) && near(q.xdir, [0.0, 0.0, -1.0]), "{q:?}");
    }

    #[test]
    fn an_untilted_plane_is_the_old_offset_plane_exactly() {
        let r = build(json!({"features": [
            {"id": "p", "type": "datumPlane", "plane": "XZ", "offset": 7},
        ]}));
        let p = r.datum_planes["p"];
        assert_eq!(p.origin, [0.0, -7.0, 0.0]);
        assert_eq!(p.xdir, [1.0, 0.0, 0.0]);
    }

    #[test]
    fn a_child_plane_follows_its_parent_datum() {
        let doc = |parent_off: f64| json!({"features": [
            {"id": "a", "type": "datumPlane", "plane": "XY", "offset": parent_off},
            {"id": "b", "type": "datumPlane", "plane": "XY", "planeId": "a", "offset": 5, "tiltX": 90},
        ]});
        let before = build(doc(10.0)).datum_planes["b"];
        let after = build(doc(30.0)).datum_planes["b"];
        assert!(near(before.origin, [0.0, 0.0, 15.0]), "{before:?}");
        assert!(near(after.origin, [0.0, 0.0, 35.0]), "{after:?}");
        assert!(near(after.normal, [0.0, -1.0, 0.0]), "{after:?}");
    }

    #[test]
    fn a_missing_parent_falls_back_to_the_cached_plane() {
        let r = build(json!({"features": [
            {"id": "b", "type": "datumPlane", "plane": "XY", "planeId": "gone", "offset": 5},
        ]}));
        assert!(near(r.datum_planes["b"].origin, [0.0, 0.0, 5.0]));
    }

    #[test]
    fn a_sketch_on_a_tilted_plane_extrudes_along_the_tilted_normal() {
        let r = build(json!({"features": [
            {"id": "p", "type": "datumPlane", "plane": "XY", "offset": 20, "tiltX": 90},
            {"id": "sk", "type": "sketch", "plane": "XY", "planeId": "p",
             "entities": [{"type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 4}]},
            {"id": "e", "type": "extrude", "sketch": "sk", "distance": 6},
        ]}));
        let body = &r.bodies[0].shape;
        assert!((kernel::volume(body) - 240.0).abs() < 1e-6);
        // the sketch's y runs up world Z and the extrude runs along -Y
        let b = kernel::bbox(body).expect("a box");
        let want = [-5.0, -6.0, 18.0, 5.0, 0.0, 22.0];
        assert!((0..6).all(|i| (b[i] - want[i]).abs() < 1e-6), "{b:?}");
    }

    #[test]
    fn a_parameter_bound_tilt_rebuilds_with_the_parameter() {
        let doc = |t: f64| json!({"parameters": {"lean": t}, "features": [
            {"id": "p", "type": "datumPlane", "plane": "XY", "offset": 20, "tiltX": "lean"},
            {"id": "sk", "type": "sketch", "plane": "XY", "planeId": "p",
             "entities": [{"type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10}]},
            {"id": "e", "type": "extrude", "sketch": "sk", "distance": 2},
        ]});
        let r = build(json!({"parameters": {"up": 12}, "features": [
            {"id": "p", "type": "datumPlane", "plane": "XY", "offset": "up"},
        ]}));
        assert!(near(r.datum_planes["p"].origin, [0.0, 0.0, 12.0]));
        for t in [30.0, 45.0] {
            let r = build(doc(t));
            let n = r.datum_planes["p"].normal;
            let want = [0.0, -f64::to_radians(t).sin(), f64::to_radians(t).cos()];
            assert!(near(n, want), "{t}: {n:?}");
            let b = kernel::bbox(&r.bodies[0].shape).expect("a box");
            let dz = b[5] - b[2];
            let tall = 10.0 * f64::to_radians(t).sin() + 2.0 * f64::to_radians(t).cos();
            assert!((dz - tall).abs() < 1e-6, "{t}: {dz} vs {tall}");
        }
    }

    #[test]
    fn an_axis_with_no_edge_reference_reports_nothing() {
        let doc = json!({"features": [
            {"id": "ax", "type": "datumAxis", "origin": [0, 0, 0], "dir": [1, 0, 0]},
        ]});
        let typed = serde_json::from_value(doc.clone()).expect("the document parses");
        let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
        assert!(r.datum_marks.is_empty());
    }
}
