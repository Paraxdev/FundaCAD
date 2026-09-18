//! Datum planes and axes, the Python engine's `builder.py` `_handle_datum_plane` and
//! `_handle_datum_axis`.
//!
//! A datum plane made on a face follows it (face_anchor.rs) and an axis made
//! on an edge re-resolves that edge. A reference that stops resolving is not an
//! error: the datum keeps the cached placement the document stored.

use fundacad_core::schema::{DatumAxis, DatumPlane, Num, OneOrMany};
use opencascade::primitives::Shape;
use opencascade::select_access::CurveType;
use serde_json::json;

use crate::select::{entity::EdgeEnt, Resolver};

use crate::builder::plane::{plane_of, PlaneRecord, PlaneRef};
use super::face_anchor::face_anchor_plane;
use crate::builder::{Ctx, FResult, Fail};

pub fn datum_plane(ctx: &mut Ctx, f: &DatumPlane) -> FResult {
    let followed = face_anchor_plane(ctx, &f.id, f.face.as_ref(), f.at.as_ref(), &f.plane, "Plane");
    let spec = match followed {
        Some(p) => PlaneRef::Record(p.record()),
        None => PlaneRef::from(&f.plane),
    };
    let base = plane_of(spec, &ctx.datums)?;
    // Python reads `offset` raw, so a parameter name there is a TypeError.
    let off = match &f.offset {
        None => 0.0,
        Some(Num::Number(r)) => r.get(),
        Some(Num::Expr(_)) => return Err(Fail::Internal("TypeError".into())),
    };
    let o = base.origin;
    let z = base.z;
    ctx.datums.insert(
        f.id.clone(),
        PlaneRecord {
            origin: [o[0] + z[0] * off, o[1] + z[1] * off, o[2] + z[2] * off],
            xdir: base.x,
            normal: base.z,
        },
    );
    Ok(())
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
