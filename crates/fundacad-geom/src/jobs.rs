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

    fn cancelled(&self) -> bool {
        self.0.cancel.is_cancelled()
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
        Some(c) => JobResult::Mesh(c.mesh(&r, tolerance, known)),
        None => mesh_result(&r.bodies, tolerance, known),
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
        rebuild_result_cached(doc, tolerance, known, &EngineWatch(ctx), &mut cache)
    }

    fn run(&mut self, op: &str, req: &Map<String, Value>, ctx: &JobContext) -> JobResult {
        match op {
            "export" => crate::export::export_result(req, &EngineWatch(ctx)),
            "import" => crate::import::import_result(req),
            "migrateGeometry" => crate::import::migrate_result(req),
            other => error_result(&format!("unknown op: {other}")),
        }
    }
}
