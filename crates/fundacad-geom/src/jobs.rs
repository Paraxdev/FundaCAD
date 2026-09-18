//! The geometry engine's jobs, what `fundacad --engine` runs.

use fundacad_core::CadDocument;
use fundacad_engine::{error_result, JobContext, Jobs};
use fundacad_protocol::JobResult;
use serde_json::{Map, Value};

use crate::builder::{self, Watch};
use crate::cache::{self, RebuildCache};
use crate::reply::mesh_result;

#[derive(Default)]
pub struct GeomJobs;

struct EngineWatch<'a>(&'a JobContext);

impl Watch for EngineWatch<'_> {
    fn feature(&self, index: usize) {
        self.0
            .progress
            .feature(i64::try_from(index).unwrap_or(i64::MAX));
    }

    fn meshing(&self, done: usize, total: usize) {
        self.0.progress.meshing(
            i64::try_from(done).unwrap_or(i64::MAX),
            i64::try_from(total).unwrap_or(i64::MAX),
        );
    }

    fn cancelled(&self) -> bool {
        self.0.cancel.is_cancelled()
    }

    fn cancel_token(&self) -> Option<fundacad_protocol::CancelToken> {
        Some(self.0.cancel.clone())
    }

    fn heartbeat(&self) -> Option<crate::heartbeat::Beat> {
        let progress = self.0.progress.clone();
        Some(std::sync::Arc::new(move || progress.tick()))
    }
}

/// server.py `_rebuild_job`, without the caches.
pub fn rebuild_result(
    doc: &Value,
    tolerance: f64,
    known: &Map<String, Value>,
    watch: &dyn Watch,
) -> JobResult {
    rebuild_with(doc, tolerance, known, watch, None)
}

/// server.py `_rebuild_job` over `rebuild_cached`.
pub fn rebuild_result_cached(
    doc: &Value,
    tolerance: f64,
    known: &Map<String, Value>,
    watch: &dyn Watch,
    cache: &mut RebuildCache,
) -> JobResult {
    rebuild_with(doc, tolerance, known, watch, Some(cache))
}

fn rebuild_with(
    doc: &Value,
    tolerance: f64,
    known: &Map<String, Value>,
    watch: &dyn Watch,
    mut cache: Option<&mut RebuildCache>,
) -> JobResult {
    let _beat = crate::heartbeat::install(watch.heartbeat());
    let typed: CadDocument = match serde_json::from_value(doc.clone()) {
        Ok(d) => d,
        Err(e) => return error_result(&format!("the document does not parse: {e}")),
    };
    let built = match cache.as_deref_mut() {
        Some(c) => c.rebuild(&typed, doc, watch),
        None => builder::rebuild(&typed, doc, watch),
    };
    let Ok(r) = built else {
        return error_result("cancelled");
    };
    if r.bodies.is_empty() {
        if let Some(first) = r.errors.first() {
            let mut m = Map::new();
            m.insert("error".into(), first.wire());
            return JobResult::Json(m);
        }
        return JobResult::Json(builder::result_fields(&typed, &r));
    }
    let fields = builder::result_fields(&typed, &r);
    let meshed = match cache {
        Some(c) => JobResult::Mesh(c.mesh(&r, tolerance, known, &mut |done, total| {
            watch.meshing(done, total)
        })),
        None => mesh_result(&r.bodies, tolerance, known, watch),
    };
    match meshed {
        JobResult::Mesh(mut mesh) => {
            let bbox = mesh.fields.get("bbox").cloned().unwrap_or(Value::Null);
            let mut merged = fields;
            merged.insert("bbox".into(), bbox);
            for (k, v) in mesh.fields {
                if !merged.contains_key(&k) {
                    merged.insert(k, v);
                }
            }
            mesh.fields = merged;
            JobResult::Mesh(mesh)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::NoWatch;
    use serde_json::json;

    fn run(doc: Value) -> JobResult {
        rebuild_result(&doc, 0.1, &Map::new(), &NoWatch)
    }

    #[test]
    fn a_built_body_comes_back_meshed_with_the_result_keys() {
        let JobResult::Mesh(m) = run(json!({"features": [
            {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
            {"id": "p", "type": "datumPlane", "plane": "XY", "offset": 3},
            {"id": "x", "type": "shell", "thickness": 0},
        ]})) else {
            panic!("expected a mesh result");
        };
        let keys: Vec<&str> = m.fields.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "protocol",
                "bodies",
                "bbox",
                "bodyIds",
                "datumPlanes",
                "featureError",
                "featureErrors"
            ]
        );
        assert_eq!(m.fields["bodyIds"], json!({"a:0": "body1"}));
        assert_eq!(
            m.fields["featureError"],
            json!({"message": "Shell: thickness must not be 0", "feature_id": "x"})
        );
        assert_eq!(m.bodies.len(), 1);
        let bbox = &m.fields["bbox"];
        assert!(
            (bbox["min"][0].as_f64().unwrap() + 5.0).abs() < 1e-6,
            "{bbox}"
        );
    }

    #[test]
    fn every_meshed_body_beats_the_stall_watchdog() {
        let ctx = JobContext {
            cancel: Default::default(),
            progress: Default::default(),
        };
        let doc = json!({"features": [
            {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
            {"id": "b", "type": "box", "length": 4, "width": 4, "height": 4},
            {"id": "c", "type": "box", "length": 2, "width": 2, "height": 2},
        ]});
        let JobResult::Mesh(m) = rebuild_result(&doc, 0.1, &Map::new(), &EngineWatch(&ctx)) else {
            panic!("expected a mesh result");
        };
        assert_eq!(m.bodies.len(), 3);
        assert_eq!(ctx.progress.beats(), 6, "one beat per feature and one per meshed body");
    }

    #[test]
    fn nothing_built_with_an_error_is_the_fatal_reply() {
        let JobResult::Json(m) = run(json!({"features": [
            {"id": "b", "type": "box", "length": 0, "width": 1, "height": 1},
        ]})) else {
            panic!("expected a json result");
        };
        assert_eq!(
            Value::Object(m),
            json!({"error": {"message": "Box: length must be greater than 0 (got 0)", "feature_id": "b"}})
        );
    }

    #[test]
    fn a_document_of_sketches_is_not_an_error() {
        let JobResult::Json(m) = run(json!({"bodyIds": {}, "features": [
            {"id": "s", "type": "sketch", "plane": "XY", "entities": []},
        ]})) else {
            panic!("expected a json result");
        };
        assert_eq!(
            Value::Object(m),
            json!({"protocol": 2, "bodies": [], "bbox": null})
        );
    }

    #[test]
    fn an_edited_move_rebuilds_where_its_new_values_put_the_body() {
        let doc = |dx: f64, rz: f64| {
            json!({"features": [
                {"id": "a", "type": "box", "length": 20, "width": 20, "height": 20},
                {"id": "m", "type": "move", "dx": dx, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": rz, "bodies": ["body1"]},
            ]})
        };
        let mut cache = cache::RebuildCache::new(None);
        let mut known = Map::new();
        let mut bbox_x = |d: Value, known: &mut Map<String, Value>| {
            let JobResult::Mesh(m) = rebuild_result_cached(&d, 0.1, known, &NoWatch, &mut cache) else {
                panic!("expected a mesh result");
            };
            let fundacad_protocol::WireBody::Full(body) = &m.bodies[0] else {
                panic!("an edited move must resend its body, not a stub");
            };
            known.insert("body1".into(), body.fields["etag"].clone());
            let b = &m.fields["bbox"];
            (b["min"][0].as_f64().unwrap(), b["max"][0].as_f64().unwrap())
        };
        let (lo, hi) = bbox_x(doc(10.0, 0.0), &mut known);
        assert!((lo - 0.0).abs() < 1e-6 && (hi - 20.0).abs() < 1e-6, "{lo} {hi}");
        let (lo, hi) = bbox_x(doc(40.0, 0.0), &mut known);
        assert!((lo - 30.0).abs() < 1e-6 && (hi - 50.0).abs() < 1e-6, "{lo} {hi}");
        let half_diag = 10.0 * std::f64::consts::SQRT_2;
        let (lo, hi) = bbox_x(doc(40.0, 45.0), &mut known);
        assert!((lo - (40.0 - half_diag)).abs() < 1e-3, "{lo}");
        assert!((hi - (40.0 + half_diag)).abs() < 1e-3, "{hi}");
    }

    #[test]
    fn an_unchanged_etag_is_answered_with_a_stub() {
        let doc = json!({"features": [{"id": "a", "type": "sphere", "radius": 3}]});
        let JobResult::Mesh(first) = run(doc.clone()) else {
            panic!("mesh")
        };
        let fundacad_protocol::WireBody::Full(body) = &first.bodies[0] else {
            panic!("full")
        };
        let mut known = Map::new();
        known.insert("body1".into(), body.fields["etag"].clone());
        let JobResult::Mesh(second) = rebuild_result(&doc, 0.1, &known, &NoWatch) else {
            panic!("mesh")
        };
        assert!(matches!(
            second.bodies[0],
            fundacad_protocol::WireBody::Stub(_)
        ));
    }
}

impl Jobs for GeomJobs {
    fn rebuild(
        &mut self,
        doc: &Value,
        tolerance: f64,
        known: &Map<String, Value>,
        fresh: bool,
        ctx: &JobContext,
    ) -> JobResult {
        let mut cache = cache::global().lock().unwrap_or_else(|p| p.into_inner());
        if fresh {
            cache.purge(doc);
        }
        // server.py `_compute_all_job` rebuilds with no known etags, every body full.
        let none = Map::new();
        let known = if fresh { &none } else { known };
        rebuild_result_cached(doc, tolerance, known, &EngineWatch(ctx), &mut cache)
    }

    fn run(&mut self, op: &str, req: &Map<String, Value>, ctx: &JobContext) -> JobResult {
        match op {
            "export" => crate::export::export_result(req, &EngineWatch(ctx)),
            "import" => crate::import::import_result(req),
            "listFonts" => crate::text::list_fonts_result(),
            "tessellateText" => crate::text::tessellate_result(req),
            "migrateGeometry" => crate::import::migrate_result(req),
            "inspect" => crate::inspect::inspect_result(req, &EngineWatch(ctx)),
            "interference" => crate::inspect::interference_result(req, &EngineWatch(ctx)),
            "projectGeometry" => crate::projection::project_geometry_result(req, &EngineWatch(ctx)),
            #[cfg(feature = "plugins")]
            "generateShape" => {
                crate::plugins::generate_shape_result(req, Some(ctx.cancel.clone()))
            }
            #[cfg(feature = "plugins")]
            "exportWith" => crate::plugins::export_with_result(
                req,
                &EngineWatch(ctx),
                Some(ctx.cancel.clone()),
            ),
            other => error_result(&format!("unknown op: {other}")),
        }
    }
}
