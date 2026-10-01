//! `sketch_merge`: closed shapes of a sketch that overlap, replaced by the
//! lines, arcs and circles that bound their union, so the sketch has one
//! area where it had several cells and an extrude needs one seed, not one per
//! cell.
//!
//! The engine draws the union (`sketchOutline`); this is the document side,
//! what is refused before asking it and the rewrite after, kept free of the
//! engine so it can be tested on its own.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::model::{self, Doc};

/// What a merge will do, checked against the document before the engine is
/// asked.
#[derive(Debug, Clone)]
pub struct Plan {
    pub sketch: String,
    pub ids: Vec<String>,
    pub base: Option<String>,
    pub bake: bool,
}

fn entities(f: &Value) -> &[Value] {
    f.get("entities").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn id_of(e: &Value) -> Option<&str> {
    e.get("id").and_then(Value::as_str)
}

/// Whether `v` names one of `ids`, or an edge `<id>~k` of one.
fn names(v: &Value, ids: &[String]) -> bool {
    v.as_str().is_some_and(|s| {
        ids.iter().any(|id| s == id || s.strip_prefix(id.as_str()).is_some_and(|r| r.starts_with('~')))
    })
}

/// The parameters a model parameter row drives that the merge removes.
fn targeted(doc: &Doc, sketch: &str, ids: &[String], dropped: &[String]) -> Vec<String> {
    model::param_defs(doc)
        .iter()
        .filter(|(_, d)| {
            let t = &d["target"];
            t["sketch"] == json!(sketch)
                && match t["kind"].as_str() {
                    Some("entity") => names(&t["entity"], ids),
                    Some("constraint") => t["constraint"].as_str().is_some_and(|c| dropped.iter().any(|d| d == c)),
                    _ => false,
                }
        })
        .map(|(k, _)| k.clone())
        .collect()
}

/// Whether an offset's pair names one of `ids`.
fn pair_named(p: &Value, ids: &[String]) -> bool {
    names(&p["src"], ids) || names(&p["cpy"], ids)
}

/// The constraints of `f` a merge of `ids` drops: any that names one, and an
/// offset none of whose pairs is left once those naming one go, as the app
/// prunes it.
fn dropped_constraints(f: &Value, ids: &[String]) -> Vec<usize> {
    f.get("constraints")
        .and_then(Value::as_array)
        .map(|cs| {
            cs.iter()
                .enumerate()
                .filter(|(_, c)| {
                    let direct = c.as_object().is_some_and(|o| o.iter().any(|(k, v)| k != "type" && k != "id" && names(v, ids)));
                    let pairs = c["pairs"].as_array();
                    direct || pairs.is_some_and(|p| !p.is_empty() && p.iter().all(|p| pair_named(p, ids)))
                })
                .map(|(i, _)| i)
                .collect()
        })
        .unwrap_or_default()
}

fn constraint_ids(f: &Value, at: &[usize]) -> Vec<String> {
    let cs = f.get("constraints").and_then(Value::as_array);
    at.iter()
        .filter_map(|&i| cs.and_then(|c| c.get(i)).and_then(id_of).map(str::to_string))
        .collect()
}

/// Read the call and refuse, changing nothing, what a merge cannot do well.
pub fn plan(doc: &Doc, args: &Map<String, Value>) -> Result<Plan, String> {
    let Some(sid) = args.get("sketch").and_then(Value::as_str) else {
        return Err("`sketch` is the id of the sketch to merge in".into());
    };
    let Some((_, f)) = model::find_feature(doc, sid) else {
        return Err(format!("no feature '{sid}'"));
    };
    if f.get("type").and_then(Value::as_str) != Some("sketch") {
        return Err(format!("{sid} is not a sketch"));
    }
    let ids: Vec<String> = match args.get("entities").and_then(Value::as_array) {
        Some(a) if a.iter().all(Value::is_string) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => return Err("`entities` is a list of the entity ids to merge".into()),
    };
    let unique: BTreeSet<&String> = ids.iter().collect();
    if unique.len() < 2 {
        return Err("give at least two entities to merge".into());
    }
    let have: Vec<&str> = entities(f).iter().filter_map(id_of).collect();
    let missing: Vec<&str> = ids.iter().map(String::as_str).filter(|i| !have.contains(i)).collect();
    if !missing.is_empty() {
        return Err(format!(
            "{sid} has no entity {}. Its ids are in `doc_get`",
            missing.iter().map(|m| format!("'{m}'")).collect::<Vec<_>>().join(", ")
        ));
    }
    let ids: Vec<String> = unique.into_iter().cloned().collect();
    // What would lose the shape it follows or repeats.
    if let Some(ps) = f.get("patterns").and_then(Value::as_array) {
        for p in ps {
            if let Some(s) = p.get("sources").and_then(Value::as_array).and_then(|s| s.iter().find(|v| names(v, &ids))) {
                return Err(format!(
                    "pattern {} repeats {}, which the merge would remove. Remove the pattern first, or leave {} out",
                    id_of(p).unwrap_or("?"),
                    s.as_str().unwrap_or_default(),
                    s.as_str().unwrap_or_default()
                ));
            }
        }
    }
    for e in entities(f) {
        if names(&e["pathRef"], &ids) {
            return Err(format!(
                "a text in {sid} follows {}, which the merge would remove. Leave it out",
                e["pathRef"].as_str().unwrap_or_default()
            ));
        }
    }
    for other in model::features(doc) {
        for e in entities(other) {
            let s = &e["source"];
            if e["type"] == "projected" && s["kind"] == "sketchCurve" && s["sketch"] == json!(sid) && names(&s["entity"], &ids) {
                return Err(format!(
                    "{} projects {} of {sid}, which the merge would remove. Leave it out",
                    id_of(other).unwrap_or("a sketch"),
                    s["entity"].as_str().unwrap_or_default()
                ));
            }
        }
    }
    let bake = args.get("bake").and_then(Value::as_bool).unwrap_or(false);
    if !bake {
        // A field that is a parameter name follows it; the outline is numbers.
        let mut params: Vec<String> = Vec::new();
        for e in entities(f).iter().filter(|e| names(&e["id"], &ids)) {
            for (k, v) in e.as_object().into_iter().flatten() {
                if k != "id" && k != "type" {
                    if let Some(p) = v.as_str() {
                        if !params.iter().any(|q| q == p) {
                            params.push(p.to_string());
                        }
                    }
                }
            }
        }
        let gone = constraint_ids(f, &dropped_constraints(f, &ids));
        for p in targeted(doc, sid, &ids, &gone) {
            if !params.contains(&p) {
                params.push(p);
            }
        }
        if !params.is_empty() {
            return Err(format!(
                "the shapes to merge are sized by {}, and the merged outline is fixed numbers that would stop \
                 following {}. Pass bake: true to merge them at today's values",
                params.join(", "),
                if params.len() == 1 { "it" } else { "them" }
            ));
        }
    }
    let base = match args.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if model::is_id(s) => Some(s.clone()),
        Some(v) => return Err(format!("`id` is letters, digits and _, not {v}")),
    };
    Ok(Plan { sketch: sid.to_string(), ids, base, bake })
}

/// What `apply` did, for the reply.
#[derive(Debug, Default)]
pub struct Merged {
    pub lines: Vec<String>,
    pub faces: usize,
    pub holes: usize,
    pub seeds: Vec<Value>,
    pub dropped: usize,
    /// Offsets that kept some of their pairs.
    pub trimmed: usize,
    pub unbound: Vec<String>,
    /// Features that pick areas of the sketch, and ones that take all of it.
    pub readers: Vec<String>,
    pub whole: Vec<String>,
}

/// Replace the merged entities with the engine's outline, where the first of
/// them was, and drop what named them.
pub fn apply(doc: &mut Doc, plan: &Plan, outline: &Value) -> Result<Merged, String> {
    let faces = outline.get("faces").and_then(Value::as_array).cloned().unwrap_or_default();
    if faces.is_empty() {
        return Err("the merge drew no outline".into());
    }
    let Some((i, f)) = model::find_feature(doc, &plan.sketch) else {
        return Err(format!("no feature '{}'", plan.sketch));
    };
    let mut f = f.clone();
    let dropped = dropped_constraints(&f, &plan.ids);
    let gone = constraint_ids(&f, &dropped);
    let unbound = targeted(doc, &plan.sketch, &plan.ids, &gone);
    // The merged ids too: a constraint the app keeps must not find a new
    // line under an old line's id.
    let mut taken: BTreeSet<String> = entities(&f).iter().filter_map(|e| id_of(e).map(str::to_string)).collect();
    let base = plan.base.clone().unwrap_or_else(|| {
        (1..)
            .map(|n| format!("m{n}"))
            .find(|b| !taken.iter().any(|t| t == b || t.starts_with(&format!("{b}_"))))
            .unwrap_or_else(|| "m".into())
    });
    let mut k = 0;
    let mut made = Vec::new();
    let mut new = Vec::new();
    let mut merged = Merged { faces: faces.len(), dropped: dropped.len(), unbound, ..Merged::default() };
    for face in &faces {
        let loops = face.get("loops").and_then(Value::as_array).cloned().unwrap_or_default();
        merged.holes += loops.len().saturating_sub(1);
        merged.seeds.push(face.get("seed").cloned().unwrap_or(Value::Null));
        for e in loops.iter().filter_map(Value::as_array).flatten() {
            let mut e = e.as_object().cloned().unwrap_or_default();
            let id = loop {
                k += 1;
                let id = format!("{base}_{k}");
                if taken.insert(id.clone()) {
                    break id;
                }
            };
            // `type` first, then the id, as the app writes them.
            let mut out = Map::new();
            out.insert("type".into(), e.remove("type").unwrap_or(Value::Null));
            out.insert("id".into(), json!(id));
            out.extend(e);
            made.push(id);
            new.push(Value::Object(out));
        }
    }
    let ents = entities(&f).to_vec();
    let at = ents.iter().position(|e| names(&e["id"], &plan.ids)).unwrap_or(ents.len());
    let mut kept: Vec<Value> = Vec::with_capacity(ents.len() + new.len());
    for (j, e) in ents.into_iter().enumerate() {
        if j == at {
            kept.append(&mut new);
        }
        if !names(&e["id"], &plan.ids) {
            kept.push(e);
        }
    }
    kept.append(&mut new);
    let obj = f.as_object_mut().ok_or("the sketch is not an object")?;
    obj.insert("entities".into(), Value::Array(kept));
    if let Some(Value::Array(cs)) = obj.get_mut("constraints") {
        let mut j = 0;
        cs.retain(|_| {
            j += 1;
            !dropped.contains(&(j - 1))
        });
        for c in cs.iter_mut() {
            if let Some(Value::Array(pairs)) = c.get_mut("pairs") {
                let before = pairs.len();
                pairs.retain(|p| !pair_named(p, &plan.ids));
                if pairs.len() < before {
                    merged.trimmed += 1;
                }
            }
        }
    }
    let picked = |v: Option<&Value>| v.is_some_and(|r| !r.is_null());
    for g in model::features(doc) {
        let Some(gid) = id_of(g) else { continue };
        let lofted = g["profiles"].as_array().is_some_and(|ps| ps.iter().any(|p| p["sketch"] == json!(plan.sketch)));
        if lofted {
            merged.readers.push(gid.to_string());
        } else if g["sketch"] == json!(plan.sketch) {
            if picked(g.get("regions")) || picked(g.get("region")) {
                merged.readers.push(gid.to_string());
            } else if matches!(g["type"].as_str(), Some("extrude" | "revolve")) {
                merged.whole.push(gid.to_string());
            }
        }
    }
    model::replace_feature(doc, i, f);
    for p in &merged.unbound {
        model::unbind_parameter(doc, p);
    }
    merged.lines = made;
    Ok(merged)
}

/// The reply: what the sketch holds now, and the seeds an extrude takes.
pub fn reply(plan: &Plan, m: &Merged) -> String {
    let ids = &m.lines;
    // A range only when it names every entity in it and nothing else.
    let base = ids.first().and_then(|i| i.rsplit_once('_')).map_or("", |(b, _)| b);
    let run = ids.len() > 2 && ids.iter().enumerate().all(|(i, id)| *id == format!("{base}_{}", i + 1));
    let named = if run { format!("{}..{}", ids[0], ids[ids.len() - 1]) } else { ids.join(", ") };
    let mut out = format!(
        "Merged {} in {} into {} {} ({named}): {} outline{}{}.",
        plan.ids.join(", "),
        plan.sketch,
        ids.len(),
        if ids.len() == 1 { "entity" } else { "entities" },
        m.faces,
        if m.faces == 1 { "" } else { "s" },
        match m.holes {
            0 => String::new(),
            1 => " with 1 hole".into(),
            n => format!(" with {n} holes"),
        }
    );
    let seeds: Vec<String> = m.seeds.iter().filter(|s| !s.is_null()).map(crate::server::py_json).collect();
    if !seeds.is_empty() {
        out.push_str(&format!(
            " A point inside {}: {}.",
            if m.seeds.len() == 1 { "it" } else { "each" },
            seeds.join(", ")
        ));
    }
    let missing = m.seeds.iter().filter(|s| s.is_null()).count();
    if missing > 0 {
        out.push_str(&format!(
            " No point clear of the sketch's other shapes was found inside {missing} of them; pick one from `view`."
        ));
    }
    if m.holes > 0 {
        out.push_str(
            " An extrude of the whole sketch fills every closed loop, holes included; give it `regions` with \
             these points to keep the holes open.",
        );
        if !m.whole.is_empty() {
            out.push_str(&format!(
                " {} {} the whole sketch, so {} now filled.",
                m.whole.join(", "),
                if m.whole.len() == 1 { "takes" } else { "take" },
                if m.holes == 1 { "the hole is" } else { "the holes are" }
            ));
        }
    }
    if m.dropped > 0 {
        out.push_str(&format!(
            " Dropped {} constraint{} on the merged shapes.",
            m.dropped,
            if m.dropped == 1 { "" } else { "s" }
        ));
    }
    if m.trimmed > 0 {
        out.push_str(&format!(
            " {} offset{} lost the pairs on the merged shapes and kept the rest.",
            m.trimmed,
            if m.trimmed == 1 { "" } else { "s" }
        ));
    }
    if !m.unbound.is_empty() {
        out.push_str(&format!(
            " {} no longer {} a dimension of this sketch, kept as {}.",
            m.unbound.join(", "),
            if m.unbound.len() == 1 { "drives" } else { "drive" },
            if m.unbound.len() == 1 { "a plain parameter" } else { "plain parameters" }
        ));
    }
    if !m.readers.is_empty() {
        out.push_str(&format!(
            " {} {} areas of this sketch by point: a point in the merged shapes now picks all of them, so build and check.",
            m.readers.join(", "),
            if m.readers.len() == 1 { "reads" } else { "read" }
        ));
    }
    out
}
