//! The non-numeric rows of a feature, as src/document/optionFields.ts, mechanism.ts and mirrorPlane.ts: choices and
//! switches, which rows a feature reads, and the choices whose options come from the document.

use serde_json::{Map, Value};

use super::hole::{self, HOLE_SIZES};

/// A value and the word a row shows for it.
pub type Opt = (&'static str, &'static str);

#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

impl Choice {
    fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self { value: value.into(), label: label.into() }
    }
}

fn owned(options: &[Opt]) -> Vec<Choice> {
    options.iter().map(|&(v, l)| Choice::new(v, l)).collect()
}

pub struct ChoiceField {
    pub field: &'static str,
    pub label: &'static str,
    pub options: &'static [Opt],
    /// The builder's default, shown when the feature does not carry the field.
    pub fallback: &'static str,
}

pub struct ToggleField {
    pub field: &'static str,
    pub label: &'static str,
    pub fallback: bool,
}

const fn choice(
    field: &'static str,
    label: &'static str,
    options: &'static [Opt],
    fallback: &'static str,
) -> ChoiceField {
    ChoiceField { field, label, options, fallback }
}

const fn toggle(field: &'static str, label: &'static str, fallback: bool) -> ToggleField {
    ToggleField { field, label, fallback }
}

const BOOLEAN_OPS: &[Opt] = &[("new", "New body"), ("join", "Join"), ("cut", "Cut"), ("intersect", "Intersect")];
const BOOLEAN_KINDS: &[Opt] = &[("union", "Union"), ("subtract", "Subtract"), ("intersect", "Intersect")];
const AXES: &[Opt] = &[("X", "X"), ("Y", "Y"), ("Z", "Z")];
const PLANES: &[Opt] = &[("XY", "XY"), ("XZ", "XZ"), ("YZ", "YZ")];
const EXTRUDE_STARTS: &[Opt] =
    &[("sketch", "Sketch plane"), ("offset", "Offset"), ("face", "Face"), ("plane", "Plane"), ("point", "Point")];
const EXTRUDE_ENDS: &[Opt] = &[
    ("distance", "Distance"),
    ("upToFace", "Up to face"),
    ("upToPlane", "Up to plane"),
    ("upToPoint", "Up to point"),
    ("throughAll", "Through all"),
];
const THIN_SIDES: &[Opt] =
    &[("center", "Centered"), ("inside", "Inside"), ("outside", "Outside"), ("twoSides", "Two sides")];
const HOLE_SIZE_OPTIONS: &[Opt] = &{
    let mut out = [("", ""); HOLE_SIZES.len()];
    let mut i = 0;
    while i < HOLE_SIZES.len() {
        out[i] = (HOLE_SIZES[i], HOLE_SIZES[i]);
        i += 1;
    }
    out
};

/// A joint id is never empty.
pub const NO_DRIVE: &str = "";
/// A picked vertex, which is not one of a datum row's choices.
pub const PICKED_POINT: &str = "picked";
/// An axis that is not one of the choices: a line, a picked edge or a face.
pub const PLACED_AXIS: &str = "placed";

/// `FEATURE_CHOICE_FIELDS`. No row for a sketch or datum `plane`: it is a placed plane, and three world planes would
/// silently discard it.
pub fn choice_fields(ty: &str) -> &'static [ChoiceField] {
    match ty {
        "boolean" => const { &[choice("operation", "Operation", BOOLEAN_KINDS, "union")] },
        "extrude" => {
            const {
                &[
                    choice("operation", "Operation", BOOLEAN_OPS, "new"),
                    choice("startType", "Start", EXTRUDE_STARTS, "sketch"),
                    choice("startPlane", "Start plane", PLANES, "XY"),
                    choice("startPoint", "Start point", &[], ""),
                    choice("endType", "End", EXTRUDE_ENDS, "distance"),
                    choice("upToPlane", "Up to plane", PLANES, "XY"),
                    choice("upToPoint", "Up to point", &[], ""),
                    choice("endType2", "End 2", EXTRUDE_ENDS, "distance"),
                    choice("upToPlane2", "Up to plane 2", PLANES, "XY"),
                    choice("upToPoint2", "Up to point 2", &[], ""),
                    choice("side", "Wall side", THIN_SIDES, "center"),
                ]
            }
        }
        "revolve" => {
            const { &[choice("operation", "Operation", BOOLEAN_OPS, "new"), choice("axis", "Axis", AXES, "Z")] }
        }
        "thread" => {
            const {
                &[
                    choice("hand", "Hand", &[("right", "Right"), ("left", "Left")], "right"),
                    choice("operation", "Operation", &[("join", "Join"), ("cut", "Cut")], "cut"),
                ]
            }
        }
        "textOnFace" => {
            const {
                &[
                    choice("operation", "Operation", &[("join", "Emboss"), ("cut", "Engrave")], "join"),
                    choice("align", "Align", &[("left", "Left"), ("center", "Centre"), ("right", "Right")], "center"),
                ]
            }
        }
        "loft" => const { &[choice("operation", "Operation", BOOLEAN_OPS, "new")] },
        // The builder has no sweep intersect.
        "sweep" => {
            const { &[choice("operation", "Operation", &[("new", "New body"), ("join", "Join"), ("cut", "Cut")], "new")] }
        }
        "thicken" => const { &[choice("operation", "Operation", &[("new", "New body"), ("join", "Join")], "join")] },
        "mirror" => const { &[choice("plane", "Plane", PLANES, "XY")] },
        "draft" => const { &[choice("axis", "Pull axis", AXES, "Z")] },
        "patternLinear" => const { &[choice("axis", "Direction", AXES, "X")] },
        "patternCircular" => const { &[choice("axis", "Axis", AXES, "Z")] },
        "mechanism" => const { &[choice("drive", "Drive", &[(NO_DRIVE, "None")], NO_DRIVE)] },
        // The builder reads press-pull's operation off the sign of `distance`, `mode` is the explicit choice.
        "press-pull" => {
            const {
                &[
                    choice(
                        "mode",
                        "Operation",
                        &[
                            ("auto", "Auto"),
                            ("new", "New body"),
                            ("join", "Join"),
                            ("cut", "Cut"),
                            ("intersect", "Intersect"),
                        ],
                        "auto",
                    ),
                    choice("direction", "Direction", &[("normal", "Along normal"), ("axis", "Along axis")], "normal"),
                ]
            }
        }
        "fillet" => {
            const {
                &[
                    choice("sizeType", "Size Type", &[("radius", "Radius"), ("chord", "Chord Length")], "radius"),
                    choice("continuity", "Continuity", &[("G1", "G1"), ("G2", "G2"), ("G3", "G3")], "G1"),
                ]
            }
        }
        "chamfer" => {
            const {
                &[choice(
                    "chamferType",
                    "Type",
                    &[("equal", "Equal Distance"), ("twoDistance", "Two-Distance")],
                    "equal",
                )]
            }
        }
        "hole" => {
            const {
                &[
                    choice(
                        "holeType",
                        "Hole type",
                        &[
                            ("simple", "Simple"),
                            ("counterbore", "Counterbore"),
                            ("countersink", "Countersink"),
                            ("insert", "Heat-set insert"),
                        ],
                        "simple",
                    ),
                    choice(
                        "standard",
                        "Standard",
                        &[("clearance", "Clearance"), ("tap", "Tap drill"), ("custom", "Custom")],
                        "clearance",
                    ),
                    choice("size", "Size", HOLE_SIZE_OPTIONS, "M3"),
                    choice("fit", "Fit", &[("close", "Close"), ("normal", "Normal"), ("loose", "Loose")], "normal"),
                    choice("extent", "Extent", &[("blind", "Blind"), ("through", "Through all")], "blind"),
                ]
            }
        }
        _ => const { &[] },
    }
}

/// `FEATURE_TOGGLE_FIELDS`.
pub fn toggle_fields(ty: &str) -> &'static [ToggleField] {
    match ty {
        "boolean" => const { &[toggle("keepOriginals", "Keep originals", false)] },
        "extrude" => {
            const {
                &[
                    toggle("symmetric", "Symmetric", false),
                    toggle("twoSided", "Two sided", false),
                    toggle("thin", "Thin", false),
                ]
            }
        }
        "thicken" => const { &[toggle("symmetric", "Symmetric", false)] },
        "fillet" | "chamfer" => const { &[toggle("tangentEdges", "Include Tangent Edges", true)] },
        "press-pull" | "offsetFace" => const { &[toggle("followTangent", "Tangent faces follow", true)] },
        "hole" => {
            const {
                &[
                    toggle("drillPoint", "Drill point", false),
                    toggle("flip", "Flip direction", false),
                    toggle("tapped", "Tapped", false),
                ]
            }
        }
        _ => const { &[] },
    }
}

fn text<'a>(v: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// A string field, its default when absent or empty, as `(v.x as string) || "default"` reads it.
fn or<'a>(v: &'a Map<String, Value>, key: &str, default: &'a str) -> &'a str {
    text(v, key).filter(|s| !s.is_empty()).unwrap_or(default)
}

fn is_true(v: &Map<String, Value>, key: &str) -> bool {
    v.get(key) == Some(&Value::Bool(true))
}

fn present(v: &Map<String, Value>, key: &str) -> bool {
    v.get(key).is_some_and(|x| !x.is_null())
}

fn extrude_field_applies(field: &str, v: &Map<String, Value>) -> bool {
    let start = or(v, "startType", "sketch");
    let end = or(v, "endType", "distance");
    let end2 = or(v, "endType2", "distance");
    let two = is_true(v, "twoSided");
    match field {
        "startOffset" => start != "sketch" || v.contains_key("startOffset"),
        "startFace" => start == "face",
        "startPlane" => start == "plane",
        "startPoint" => start == "point",
        "distance" => !end.starts_with("upTo"),
        "upToFace" => end == "upToFace",
        "upToPlane" => end == "upToPlane",
        "upToPoint" => end == "upToPoint",
        "endOffset" => end.starts_with("upTo"),
        "symmetric" => !two,
        "twoSided" => !is_true(v, "symmetric"),
        "distance2" => two && !end2.starts_with("upTo"),
        "taper2" | "endType2" => two,
        "upToFace2" => two && end2 == "upToFace",
        "upToPlane2" => two && end2 == "upToPlane",
        "upToPoint2" => two && end2 == "upToPoint",
        "endOffset2" => two && end2.starts_with("upTo"),
        "thickness" | "side" => is_true(v, "thin"),
        "thickness2" => is_true(v, "thin") && text(v, "side") == Some("twoSides"),
        _ => true,
    }
}

/// Whether the build reads a row, numeric ones included: a row the engine ignores is worse than none. An unnamed field
/// always applies, since hiding a row on a guess loses an editable value.
pub fn field_applies(ty: &str, field: &str, v: &Map<String, Value>) -> bool {
    match (ty, field) {
        ("chamfer", "distance2") => text(v, "chamferType") == Some("twoDistance"),
        ("hole", _) => hole::field_applies(field, v),
        ("extrude", _) => extrude_field_applies(field, v),
        ("press-pull", "upToOffset") => present(v, "upTo") || present(v, "upToPlane") || present(v, "upToPoint"),
        ("mechanism", "offset" | "angle") => drive_field(v) == Some(field),
        // The tool writes followTangent only for a round face with tangent neighbours, absent means nothing to act on.
        ("press-pull" | "offsetFace", "followTangent") => {
            v.get("followTangent").is_some_and(Value::is_boolean)
                && text(v, "mode").unwrap_or("auto") == "auto"
                && text(v, "direction") != Some("axis")
        }
        _ => true,
    }
}

/// The label of a row whose meaning changes with another field.
pub fn field_label(ty: &str, field: &str, v: &Map<String, Value>) -> Option<&'static str> {
    (ty == "fillet" && field == "radius" && text(v, "sizeType") == Some("chord")).then_some("Chord Length")
}

/// A mirror naming bodies stores its plane as `{name}`, a bare one as the name itself.
pub fn mirror_plane_name(plane: Option<&Value>) -> Option<&str> {
    match plane? {
        Value::String(s) => Some(s),
        other => other.get("name").and_then(Value::as_str),
    }
}

/// The builder's default when the feature does not carry the field or carries one the row cannot offer.
pub fn choice_value(ty: &str, f: &Map<String, Value>, c: &ChoiceField) -> String {
    let v = if ty == "mirror" && c.field == "plane" { mirror_plane_name(f.get("plane")) } else { text(f, c.field) };
    match v {
        Some(v) if c.options.iter().any(|(o, _)| *o == v) => v.to_string(),
        _ => c.fallback.to_string(),
    }
}

pub fn toggle_value(f: &Map<String, Value>, t: &ToggleField) -> bool {
    f.get(t.field).and_then(Value::as_bool).unwrap_or(t.fallback)
}

fn is_datum_field(field: &str) -> bool {
    matches!(field, "startPlane" | "startPoint" | "upToPlane" | "upToPlane2" | "upToPoint" | "upToPoint2")
}

fn named(f: &Map<String, Value>, trim: bool) -> String {
    let id = text(f, "id").unwrap_or_default();
    let name = text(f, "name").map(|n| if trim { n.trim() } else { n }).unwrap_or_default();
    if name.is_empty() { id } else { name }.to_string()
}

fn of_type<'a>(features: &'a [&'a Map<String, Value>], ty: &'a str) -> impl Iterator<Item = Choice> + 'a {
    features
        .iter()
        .filter(move |f| text(f, "type") == Some(ty))
        .map(|f| Choice::new(text(f, "id").unwrap_or(""), named(f, false)))
}

/// The features above `id`, all of them when it is not in the list.
fn above<'a>(features: &'a [&'a Map<String, Value>], id: &str) -> &'a [&'a Map<String, Value>] {
    match features.iter().position(|f| text(f, "id") == Some(id)) {
        Some(at) => &features[..at],
        None => features,
    }
}

/// `datumChoiceRow`: a start or end plane or point, or a mirror plane, offered from the datums above the feature.
/// Holds its value even when that is a picked vertex, a datum that is gone, or nothing chosen yet.
pub fn datum_choice_row(
    ty: &str,
    f: &Map<String, Value>,
    field: &str,
    features: &[&Map<String, Value>],
) -> Option<(Vec<Choice>, String)> {
    let mirror = ty == "mirror" && field == "plane";
    if !mirror && !is_datum_field(field) {
        return None;
    }
    let earlier = above(features, text(f, "id").unwrap_or_default());
    let mut options: Vec<Choice> = match if mirror { "startPlane" } else { field } {
        "startPlane" | "upToPlane" | "upToPlane2" => {
            owned(PLANES).into_iter().chain(of_type(earlier, "datumPlane")).collect()
        }
        _ => of_type(earlier, "datumPoint").collect(),
    };
    let v =
        if mirror { mirror_plane_name(f.get("plane")).map(|s| Value::String(s.into())) } else { f.get(field).cloned() };
    match v {
        Some(Value::Object(_) | Value::Array(_)) => {
            options.push(Choice::new(PICKED_POINT, "Picked point"));
            Some((options, PICKED_POINT.into()))
        }
        Some(Value::String(v)) if !v.is_empty() => {
            if !options.iter().any(|o| o.value == v) {
                options.push(Choice::new(v.clone(), format!("{v} (missing)")));
            }
            Some((options, v))
        }
        _ => {
            options.insert(0, Choice::new("", "Choose one"));
            Some((options, String::new()))
        }
    }
}

/// A datum row's "Choose one" and "Picked point" are no values to write.
pub fn datum_choice_is_no_op(field: &str, value: &Value) -> bool {
    is_datum_field(field) && matches!(value.as_str(), Some("" | PICKED_POINT))
}

fn pattern_axis_datum(axis: Option<&Value>) -> Option<&str> {
    axis?.get("datum")?.as_str()
}

/// World axes, datum axes above the pattern and its placed axis, so the row never shows Z for another axis.
pub fn pattern_axis_choice(f: &Map<String, Value>, features: &[&Map<String, Value>]) -> (Vec<Choice>, String) {
    let earlier = above(features, text(f, "id").unwrap_or_default());
    let mut options: Vec<Choice> = owned(AXES);
    options.extend(
        earlier
            .iter()
            .filter(|x| text(x, "type") == Some("datumAxis"))
            .map(|x| Choice::new(text(x, "id").unwrap_or(""), named(x, true))),
    );
    let axis = f.get("axis").filter(|a| !a.is_null());
    let datum = pattern_axis_datum(axis);
    let placed = present(f, "axisRef") || (axis.is_some_and(|a| !a.is_string()) && datum.is_none());
    if placed {
        options.push(Choice::new(PLACED_AXIS, if present(f, "axisRef") { "Picked" } else { "Line" }));
        return (options, PLACED_AXIS.into());
    }
    let name = datum.or(axis.and_then(Value::as_str)).unwrap_or("Z").to_string();
    if !options.iter().any(|o| o.value == name) {
        options.push(Choice::new(name.clone(), name.clone()));
    }
    (options, name)
}

/// A key to set, or with None to remove.
pub type Patch = Vec<(String, Option<Value>)>;

/// A datum axis is written `{datum}`, never the bare id, which older builds turn about world Z. Picking one drops the
/// placed axis.
pub fn pattern_axis_patch(value: &str) -> Option<Patch> {
    if value == PLACED_AXIS {
        return None;
    }
    let axis = if AXES.iter().any(|(a, _)| *a == value) {
        Value::String(value.into())
    } else {
        serde_json::json!({ "datum": value })
    };
    Some(vec![("axis".into(), Some(axis)), ("axisRef".into(), None)])
}

fn joints(v: &Map<String, Value>) -> impl Iterator<Item = &Map<String, Value>> {
    v.get("joints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|j| j.get("id").is_some_and(Value::is_string))
}

/// The drive value a mechanism reads: a slider's offset or a revolute's angle, neither without a drivable drive.
pub fn drive_field(v: &Map<String, Value>) -> Option<&'static str> {
    let drive = text(v, "drive").filter(|d| !d.is_empty())?;
    match text(joints(v).find(|j| text(j, "id") == Some(drive))?, "mode")? {
        "slider" => Some("offset"),
        "revolute" => Some("angle"),
        _ => None,
    }
}

/// The joints a drive can move, plus whatever the drive names when it cannot move it, so the row never lies.
pub fn mechanism_drive_choice(v: &Map<String, Value>) -> (Vec<Choice>, String) {
    let mut options = vec![Choice::new(NO_DRIVE, "None")];
    for j in joints(v) {
        if let Some(mode @ ("revolute" | "slider")) = text(j, "mode") {
            let id = text(j, "id").unwrap_or_default();
            options.push(Choice::new(id, format!("{id} ({mode})")));
        }
    }
    let drive = text(v, "drive").unwrap_or(NO_DRIVE).to_string();
    if !options.iter().any(|o| o.value == drive) {
        options.push(Choice::new(drive.clone(), drive.clone()));
    }
    (options, drive)
}

pub fn mechanism_drive_patch(value: &str) -> Patch {
    vec![("drive".into(), (value != NO_DRIVE).then(|| Value::String(value.into())))]
}

/// Turning thin on also sets the default thickness when none is set, the engine needs one to build.
pub fn thin_toggle_patch(f: &Map<String, Value>, on: bool) -> Patch {
    let mut patch: Patch = vec![("thin".into(), Some(Value::Bool(on)))];
    if on && !present(f, "thickness") {
        patch.push(("thickness".into(), Some(Value::from(2))));
    }
    patch
}

/// A mirror naming bodies keeps its plane as `{name}`: older builds read a bare one as a mirror of the active body.
pub fn canonical_mirror_plane(f: &mut Map<String, Value>) {
    let bodies = f.get("bodies").and_then(Value::as_array).is_some_and(|b| !b.is_empty());
    if text(f, "type") != Some("mirror") || !bodies {
        return;
    }
    if let Some(Value::String(name)) = f.get("plane").cloned() {
        f.insert("plane".into(), serde_json::json!({ "name": name }));
    }
}
