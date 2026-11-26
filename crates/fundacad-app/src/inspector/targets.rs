//! What a feature is applied to, as src/features/selectionTargets.ts: every field holding a selection and what its
//! row says. Read only here, the picking that edits one belongs to the selection lane.

use serde_json::{Map, Value};

use super::options::field_applies;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Edge,
    Face,
    Body,
    /// A closed sketch region, the word the extrude prompts use.
    Area,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TargetField {
    pub field: &'static str,
    /// Names the role, not the type, so a boolean's two body targets can be told apart.
    pub label: &'static str,
    pub kind: TargetKind,
    /// A profile point, itself an array of numbers.
    pub region: bool,
    /// Said instead of a count, since "0 faces" and "the whole body" are opposite answers.
    pub when_empty: Option<&'static str>,
    /// The singular form some features grew beside the plural.
    pub also_reads: Option<&'static str>,
}

const fn row(field: &'static str, label: &'static str, kind: TargetKind) -> TargetField {
    TargetField { field, label, kind, region: false, when_empty: None, also_reads: None }
}

const fn empty(mut t: TargetField, words: &'static str) -> TargetField {
    t.when_empty = Some(words);
    t
}

/// Empty is the usual case and means every shown body it reaches.
const ACTS_ON: TargetField = empty(row("targets", "Bodies acted on", TargetKind::Body), "every shown body it reaches");
const EDGES: TargetField = row("edges", "Edges", TargetKind::Edge);
const ONE_FACE: TargetField = row("face", "Face", TargetKind::Face);
const BODIES: TargetField = row("bodies", "Bodies", TargetKind::Body);
const BODIES_OR_ACTIVE: TargetField = empty(BODIES, "the active body");
const SPLIT_BODIES: TargetField = TargetField { also_reads: Some("body"), ..BODIES_OR_ACTIVE };
const PROFILE: TargetField =
    TargetField { region: true, ..empty(row("regions", "Profile", TargetKind::Area), "the whole sketch") };
const FACES: TargetField = row("faces", "Faces", TargetKind::Face);

/// `FEATURE_TARGETS`: declaration order is row order, what is kept before what is consumed.
fn targets_of(ty: &str) -> &'static [TargetField] {
    match ty {
        "fillet" | "chamfer" => const { &[EDGES] },
        "press-pull" => {
            const { &[ONE_FACE, empty(row("upTo", "Up to face", TargetKind::Face), "the distance"), ACTS_ON] }
        }
        "deleteFace" | "hole" | "textOnFace" => const { &[ONE_FACE] },
        // An empty set is a sealed hollow, a legitimate and quite different part.
        "shell" => const { &[empty(row("faces", "Faces to open", TargetKind::Face), "sealed hollow")] },
        "offsetFace" | "draft" => const { &[FACES] },
        "thicken" => const { &[empty(FACES, "the whole body"), ACTS_ON] },
        "boolean" => {
            const { &[row("target", "Body kept", TargetKind::Body), row("tools", "Bodies used", TargetKind::Body)] }
        }
        "move" | "duplicate" | "mirror" | "patternRect" | "patternLinear" | "patternCircular" => const { &[BODIES_OR_ACTIVE] },
        "removeBody" => const { &[BODIES] },
        "mechanism" => const { &[row("ground", "Ground", TargetKind::Body)] },
        "split" | "separate" => const { &[SPLIT_BODIES] },
        "extrude" => {
            const {
                &[
                    TargetField { also_reads: Some("region"), ..PROFILE },
                    row("startFace", "Start face", TargetKind::Face),
                    row("upToFace", "Up to face", TargetKind::Face),
                    row("upToFace2", "Up to face 2", TargetKind::Face),
                    ACTS_ON,
                ]
            }
        }
        "revolve" => const { &[PROFILE, empty(row("axisEdge", "Axis edge", TargetKind::Edge), "none"), ACTS_ON] },
        "sweep" | "loft" => const { &[ACTS_ON] },
        _ => const { &[] },
    }
}

/// `targetsFor`: a pattern that repeats features has no bodies, and a feature that makes a body of its own acts on none.
pub fn targets_for(ty: &str, f: &Map<String, Value>) -> Vec<TargetField> {
    let s = |k: &str| f.get(k).and_then(Value::as_str);
    let repeats = f.get("features").and_then(Value::as_array).is_some_and(|r| !r.is_empty());
    let how = if ty == "press-pull" { s("mode").unwrap_or("auto") } else { s("operation").unwrap_or("new") };
    let combines = how != "auto" && how != "new";
    targets_of(ty)
        .iter()
        .filter(|t| (t.field != "bodies" || !repeats) && (**t != ACTS_ON || combines) && field_applies(ty, t.field, f))
        .copied()
        .collect()
}

/// Tolerant on the way in: `face` was once written as a one-element array, a split spells its target two ways, and a
/// single profile point is an array of numbers, not three areas.
pub fn read_target<'a>(f: &'a Map<String, Value>, t: &TargetField) -> Vec<&'a Value> {
    let blank = |v: Option<&Value>| v.is_none_or(|v| v.is_null() || v.as_array().is_some_and(Vec::is_empty));
    let raw = f.get(t.field);
    let val = if blank(raw) { t.also_reads.and_then(|k| f.get(k)) } else { raw };
    match val {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) if !(t.region && a.first().is_some_and(Value::is_number)) => {
            a.iter().filter(|v| !v.is_null()).collect()
        }
        Some(v) => vec![v],
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What the row says: "4 edges", "every edge", "2 edges, 1 tangent chain", or the field's own words for empty. An entry
/// covering many edges is worded, not counted, since only the engine knows how many it reaches.
pub fn describe(t: &TargetField, entries: &[&Value]) -> String {
    if entries.is_empty() {
        return t.when_empty.unwrap_or("nothing selected").to_string();
    }
    let mut spans: Vec<(String, usize)> = Vec::new();
    let mut picks = 0;
    for e in entries {
        let span = match e.get("by").and_then(Value::as_str) {
            Some("all") => return "every edge".into(),
            Some(by @ ("tangentChain" | "ofFace")) => Some(by.to_string()),
            Some("axis") => e.get("axis").and_then(Value::as_str).map(str::to_string),
            _ => None,
        };
        match span {
            Some(span) => match spans.iter_mut().find(|(s, _)| *s == span) {
                Some(slot) => slot.1 += 1,
                None => spans.push((span, 1)),
            },
            None => picks += 1,
        }
    }
    let mut parts = Vec::new();
    if picks > 0 {
        parts.push(match t.kind {
            TargetKind::Edge => plural(picks, "edge", "edges"),
            TargetKind::Face => plural(picks, "face", "faces"),
            TargetKind::Body => plural(picks, "body", "bodies"),
            TargetKind::Area => plural(picks, "area", "areas"),
        });
    }
    for (span, n) in spans {
        parts.push(match span.as_str() {
            "tangentChain" => plural(n, "tangent chain", "tangent chains"),
            "ofFace" if n == 1 => "the edges of 1 face".into(),
            "ofFace" => format!("the edges of {n} faces"),
            axis => format!("every edge along {axis}"),
        });
    }
    parts.join(", ")
}
