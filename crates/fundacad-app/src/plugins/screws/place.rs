//! Making a fastener where it was dropped, and making it again where a placed one is dragged to. The engine bakes the
//! placement into the stored solid, as FundaCAD 1's generateShape did, so the feature keeps no transform of its own.

use std::rc::Rc;

use fundacad_client::Doc;
use gpui::*;
use serde_json::{json, Map, Value};

use super::{feature, GENERATOR, ID};
use crate::i18n::{self, tr};
use crate::overlay::{self, Toast};
use crate::viewport::placing::{self, Land, Placement};
use crate::viewport::Viewport;

/// A new fastener, or the id of the one being moved.
#[derive(Clone)]
pub enum Target {
    New,
    Moved(String),
}

/// The generateShape request for `spec` at `placement`, at the origin without one.
pub fn request(spec: &Value, placement: Option<Placement>) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("generator".into(), json!(GENERATOR));
    fields.insert("params".into(), spec.clone());
    fields.insert("output".into(), json!("store"));
    if let Some(p) = placement {
        fields.insert("placement".into(), p.json());
    }
    fields
}

/// Where a fastener made without a placement stands, at the origin along +Z.
const HOME: Placement = Placement { origin: glam::Vec3::ZERO, z: glam::Vec3::Z };

/// The document with the fastener `target` names made from `reply` at `placement`: a new feature, or a moved one's
/// new solid. The placement is kept beside the spec so a drag can show the solid moving before the engine remakes it.
pub fn apply(
    doc: &mut Doc,
    target: &Target,
    spec: &Value,
    placement: Option<Placement>,
    reply: &Map<String, Value>,
) -> Result<(), String> {
    let at = placement.unwrap_or(HOME).json();
    match target {
        Target::New => {
            let mut f = feature(&crate::tools::next_id(doc), spec, reply)?;
            f["generatedBy"]["placement"] = at;
            crate::tools::insert(doc, f)
        }
        Target::Moved(id) => {
            let geom = reply.get("geom").filter(|g| !g.is_null()).ok_or("the generator made no geometry")?;
            let features = doc.get_mut("features").and_then(Value::as_array_mut).ok_or("the document has no features")?;
            let f = features
                .iter_mut()
                .find(|f| f.get("id").and_then(Value::as_str) == Some(id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| format!("{id} is no longer in the document"))?;
            f.insert("geom".into(), geom.clone());
            f.insert("solid".into(), reply.get("solid").cloned().unwrap_or(json!(true)));
            if let Some(by) = f.get_mut("generatedBy").and_then(Value::as_object_mut) {
                by.insert("placement".into(), at);
            }
            Ok(())
        }
    }
}

/// Makes `spec` at `placement` and puts it in the document as one undo step, `done` told when the engine answered.
pub fn make(
    viewport: &Entity<Viewport>,
    spec: Value,
    placement: Option<Placement>,
    target: Target,
    done: impl FnOnce(&mut App) + 'static,
    cx: &mut App,
) {
    let name = spec.get("name").and_then(Value::as_str).unwrap_or("Fastener").to_owned();
    let Some(link) = viewport.read(cx).session_link(None) else {
        done(cx);
        return overlay::toast(cx, Toast::error(i18n::t("files.openDocumentFirst")));
    };
    let fields = request(&spec, placement);
    let viewport = viewport.clone();
    cx.spawn(async move |cx| {
        let client = link.client.clone();
        let answer = cx.background_spawn(async move { client.request("generateShape", fields) }).await;
        let _ = cx.update(|cx| {
            done(cx);
            let reply = match answer {
                Ok(r) => r,
                Err(r) => {
                    let _ = viewport.update(cx, |v, cx| v.settle(cx));
                    if r.cancelled {
                        return;
                    }
                    let why = tr!("screws.insert.couldNotWhy", name = &name, why = r.message);
                    return overlay::toast(cx, Toast::error(why));
                }
            };
            let (label, said) = match &target {
                Target::New => (tr!("screws.insert.step", name = &name), tr!("screws.insert.inserted", name = &name)),
                Target::Moved(_) => (tr!("screws.move.step", name = &name), tr!("screws.move.moved", name = &name)),
            };
            let edited = viewport.update(cx, |v, cx| {
                v.edit_step(None, Some(label), move |d| apply(d, &target, &spec, placement, &reply), cx)
            });
            match edited {
                Ok(_) => overlay::toast(cx, Toast::info(said)),
                Err(e) => {
                    let _ = viewport.update(cx, |v, cx| v.settle(cx));
                    overlay::toast(cx, Toast::error(tr!("screws.place.couldNotWhy", name = &name, why = e)))
                }
            }
        });
    })
    .detach();
}

/// Where the fastener feature `id` stands, None for one made before its placement was kept.
pub fn placed(doc: &Doc, id: &str) -> Option<Placement> {
    let features = doc.get("features")?.as_array()?;
    let f = features.iter().find(|f| f.get("id").and_then(Value::as_str) == Some(id))?;
    Placement::from_json(f.get("generatedBy")?.get("placement")?)
}

/// The fastener feature a body was generated as, by the features that own its faces, with its spec.
pub fn fastener_of(doc: &Doc, owners: &[String]) -> Option<(String, Value)> {
    let features = doc.get("features")?.as_array()?;
    owners.iter().find_map(|o| {
        let f = features.iter().find(|f| f.get("id").and_then(Value::as_str) == Some(o.as_str()))?;
        let by = f.get("generatedBy").filter(|_| f.get("type").and_then(Value::as_str) == Some("import"))?;
        (by.get("plugin").and_then(Value::as_str) == Some(ID)).then(|| Some((o.clone(), by.get("spec")?.clone())))?
    })
}

/// Lets a placed fastener be dragged onto another face or hole.
pub fn add_mover(viewport: &Entity<Viewport>, cx: &mut App) {
    let viewport = viewport.downgrade();
    placing::add_mover(cx, move |doc, owners, cx| {
        if !super::super::enabled(cx, ID) {
            return None;
        }
        let (id, spec) = fastener_of(doc, owners)?;
        let from = placed(doc, &id);
        let viewport = viewport.clone();
        let land: Land = Rc::new(move |at: Option<Placement>, _: &mut Window, cx: &mut App| {
            let Some(v) = viewport.upgrade() else { return };
            let Some(at) = at else {
                return overlay::toast(cx, Toast::info(i18n::t("screws.place.dropHint")));
            };
            make(&v, spec.clone(), Some(at), Target::Moved(id.clone()), |_| {}, cx);
        });
        Some((land, from))
    });
}

#[cfg(test)]
mod tests;
