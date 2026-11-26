//! What a feature is applied to, as src/features/selectionTargets.ts: every field holding a selection and what its
//! row says. Read only here, the picking that edits one belongs to the selection lane.

use serde_json::{Map, Value};

use super::options::field_applies;
use crate::i18n::{t, tr};

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
    /// The key of the words naming the role, not the type, so a boolean's two body targets can be told apart.
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
const ACTS_ON: TargetField =
    empty(row("targets", "selectionTarget.actsOn", TargetKind::Body), "selectionTarget.empty.everyShownBody");
const EDGES: TargetField = row("edges", "selectionTarget.edges", TargetKind::Edge);
const ONE_FACE: TargetField = row("face", "selectionTarget.face", TargetKind::Face);
const BODIES: TargetField = row("bodies", "selectionTarget.bodies", TargetKind::Body);
const BODIES_OR_ACTIVE: TargetField = empty(BODIES, "selectionTarget.empty.activeBody");
const SPLIT_BODIES: TargetField = TargetField { also_reads: Some("body"), ..BODIES_OR_ACTIVE };
const PROFILE: TargetField = TargetField {
    region: true,
    ..empty(row("regions", "selectionTarget.profile", TargetKind::Area), "selectionTarget.empty.wholeSketch")
};
const FACES: TargetField = row("faces", "selectionTarget.faces", TargetKind::Face);

/// `FEATURE_TARGETS`: declaration order is row order, what is kept before what is consumed.
fn targets_of(ty: &str) -> &'static [TargetField] {
    match ty {
        "fillet" | "chamfer" => const { &[EDGES] },
        "press-pull" => {
            const {
                &[
                    ONE_FACE,
                    empty(row("upTo", "selectionTarget.upToFace", TargetKind::Face), "selectionTarget.empty.distance"),
                    ACTS_ON,
                ]
            }
        }
        "deleteFace" | "hole" | "textOnFace" => const { &[ONE_FACE] },
        // An empty set is a sealed hollow, a legitimate and quite different part.
        "shell" => {
            const { &[empty(row("faces", "selectionTarget.facesToOpen", TargetKind::Face), "selectionTarget.empty.sealed")] }
        }
        "offsetFace" | "draft" => const { &[FACES] },
        "thicken" => const { &[empty(FACES, "selectionTarget.empty.wholeBody"), ACTS_ON] },
        "boolean" => {
            const {
                &[
                    row("target", "selectionTarget.bodyKept", TargetKind::Body),
                    row("tools", "selectionTarget.bodiesUsed", TargetKind::Body),
                ]
            }
        }
        "move" | "mirror" | "patternRect" | "patternLinear" | "patternCircular" => const { &[BODIES_OR_ACTIVE] },
        "removeBody" => const { &[BODIES] },
        "mechanism" => const { &[row("ground", "selectionTarget.ground", TargetKind::Body)] },
        "split" | "separate" => const { &[SPLIT_BODIES] },
        "extrude" => {
            const {
                &[
                    TargetField { also_reads: Some("region"), ..PROFILE },
                    row("startFace", "selectionTarget.startFace", TargetKind::Face),
                    row("upToFace", "selectionTarget.upToFace", TargetKind::Face),
                    row("upToFace2", "selectionTarget.upToFace2", TargetKind::Face),
                    ACTS_ON,
                ]
            }
        }
        "revolve" => const { &[PROFILE, ACTS_ON] },
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

/// What the row says: "4 edges", "every edge", "2 edges, 1 tangent chain", or the field's own words for empty. An entry
/// covering many edges is worded, not counted, since only the engine knows how many it reaches.
pub fn describe(field: &TargetField, entries: &[&Value]) -> String {
    if entries.is_empty() {
        return t(field.when_empty.unwrap_or("selectionTarget.empty.nothing"));
    }
    let mut spans: Vec<(String, usize)> = Vec::new();
    let mut picks = 0;
    for e in entries {
        let span = match e.get("by").and_then(Value::as_str) {
            Some("all") => return t("target.span.all"),
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
        let kind = match field.kind {
            TargetKind::Edge => "edge",
            TargetKind::Face => "face",
            TargetKind::Body => "body",
            TargetKind::Area => "area",
        };
        parts.push(tr!("selectionTarget.count", kind = kind, n = picks));
    }
    for (span, n) in spans {
        parts.push(match span.as_str() {
            "tangentChain" => tr!("target.span.chains", n = n),
            "ofFace" => tr!("target.span.faceEdges", n = n),
            axis => tr!("target.span.along", axis = axis),
        });
    }
    parts.join(", ")
}
