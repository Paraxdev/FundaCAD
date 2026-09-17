//! The document the engine rebuilds from: `CadDocument` and everything in it,
//! with the JSON names of `src/types.ts` and `src/document/versions.ts`.
//!
//! Loss-free by construction. Every object keeps the keys it does not know in
//! `extra`, every object union keeps a member it does not know as `Unknown`,
//! every string union keeps a spelling it does not know as `Other`, and numbers
//! keep their integer or float spelling, so `to_value(from_value(doc)) == doc`.

pub mod feature;
pub mod selector;
pub mod sketch;
pub mod value;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub use feature::*;
pub use selector::*;
pub use sketch::{
    DimPlace, PlaceOffset, ProjectedCurve, ProjectedSource, SketchConstraint, SketchEntity,
    SketchPattern,
};
pub use value::{Extra, Invalid, Num, OneOrMany, Real, UnresolvedNum, Vec3};

use sketch::plain_struct;
use value::{nullable, open_enum, tagged_enum};

plain_struct!(
    /// Per-face colours as a palette plus `[count, paletteIndex]` runs over face
    /// order, index -1 meaning no colour of its own (sidecar/face_colors.py).
    FaceColorRuns { palette: Vec<String>, runs: Vec<[Real; 2]> }
);

open_enum! {
    /// Canonical unit of a parameter: lengths mm, angles degrees, counts raw.
    pub enum ParamUnit { Mm = "mm", Deg = "deg", Count = "count" }
}

plain_struct!(TargetFeature {
    feature: String,
    field: String
});
plain_struct!(TargetConstraint {
    sketch: String,
    constraint: String
});
plain_struct!(TargetEntity {
    sketch: String,
    entity: String,
    field: String
});
plain_struct!(TargetPattern {
    sketch: String,
    pattern: String,
    field: String
});

tagged_enum! {
    /// Where a model parameter's value is written, by stable id.
    pub enum ParamTarget, tag = "kind", first = [] {
        Feature(TargetFeature) = "feature",
        Constraint(TargetConstraint) = "constraint",
        Entity(TargetEntity) = "entity",
        Pattern(TargetPattern) = "pattern",
    }
}

plain_struct!(ControlNumber {
    #[serde(default, skip_serializing_if = "Option::is_none")] min: Option<Real>,
    #[serde(default, skip_serializing_if = "Option::is_none")] max: Option<Real>,
    #[serde(default, skip_serializing_if = "Option::is_none")] step: Option<Real>,
});
plain_struct!(ControlSlider {
    min: Real,
    max: Real,
    #[serde(default, skip_serializing_if = "Option::is_none")] step: Option<Real>,
});
plain_struct!(ControlToggle {});
plain_struct!(Choice {
    label: String,
    value: Real
});
plain_struct!(ControlChoice { choices: Vec<Choice> });

tagged_enum! {
    /// How the parameter is edited; the build and the evaluator never read it.
    pub enum ParamControl, tag = "kind", first = [] {
        Number(ControlNumber) = "number",
        Slider(ControlSlider) = "slider",
        Toggle(ControlToggle) = "toggle",
        Choice(ControlChoice) = "choice",
    }
}

plain_struct!(
    /// One row of the parameter table. `expr` is the source of truth, `value`
    /// its cached result in canonical units, always present.
    ParamDef {
        expr: String,
        value: Real,
        unit: ParamUnit,
        #[serde(default, skip_serializing_if = "Option::is_none")] comment: Option<String>,
        /// Present on a model parameter (dN), which drives one field.
        #[serde(default, skip_serializing_if = "Option::is_none")] target: Option<ParamTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")] driven: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")] control: Option<ParamControl>,
        #[serde(default, skip_serializing_if = "Option::is_none")] group: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] hidden: Option<bool>,
    }
);

plain_struct!(ParamGroup {
    id: String,
    name: String
});
plain_struct!(ParamConfiguration { id: String, name: String, values: IndexMap<String, String> });
open_enum! {
    pub enum CheckLevel { Warning = "warning", Error = "error" }
}
plain_struct!(ParamCheck {
    id: String,
    expr: String,
    message: String,
    level: CheckLevel
});
plain_struct!(ParamExtras {
    #[serde(default, skip_serializing_if = "Option::is_none")] groups: Option<Vec<ParamGroup>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] configurations: Option<Vec<ParamConfiguration>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] active_configuration: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] checks: Option<Vec<ParamCheck>>,
});

plain_struct!(ViewOverride {
    normal: Vec3,
    up: Vec3
});

plain_struct!(VersionTree {
    /// Object hash per feature, in history order.
    features: Vec<String>,
    rest: String,
});
plain_struct!(Version {
    id: String,
    parent: Option<String>,
    branch: String,
    message: String,
    /// Milliseconds since the epoch.
    time: Real,
    tree: VersionTree,
});
plain_struct!(
    /// Saved versions and branches kept inside the document; objects are JSON
    /// text by content hash.
    VersionRepo {
        objects: IndexMap<String, String>,
        versions: Vec<Version>,
        branches: IndexMap<String, String>,
        current: String,
    }
);

plain_struct!(Element {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] parent: Option<String>,
});
plain_struct!(Material {
    id: String,
    name: String,
    color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] metalness: Option<Real>,
    #[serde(default, skip_serializing_if = "Option::is_none")] roughness: Option<Real>,
    #[serde(default, skip_serializing_if = "Option::is_none")] opacity: Option<Real>,
    #[serde(default, skip_serializing_if = "Option::is_none")] emissive: Option<Real>,
});
plain_struct!(PaletteSlot {
    name: String,
    color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] material: Option<String>,
});

open_enum! {
    pub enum ImportColorSource { Bodies = "bodies", Faces = "faces" }
}

type Side<T> = Option<IndexMap<String, T>>;

plain_struct!(
    /// A FundaCAD document. Only `parameters` and `features` build; the rest is
    /// project state the engine carries and the app displays.
    CadDocument {
        /// Name to value, derived from `paramDefs` on every save. Required by
        /// the app, optional to the Python engine, so optional here.
        #[serde(default, skip_serializing_if = "Option::is_none")] parameters: Option<IndexMap<String, Real>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] param_defs: Side<ParamDef>,
        #[serde(default, skip_serializing_if = "Option::is_none")] param_extras: Option<ParamExtras>,
        features: Vec<Feature>,
        #[serde(default, skip_serializing_if = "Option::is_none")] view_overrides: Side<ViewOverride>,
        #[serde(default, skip_serializing_if = "Option::is_none")] version: Option<Real>,
        /// Feature ids skipped on rebuild.
        #[serde(default, skip_serializing_if = "Option::is_none")] suppressed: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] versions: Option<VersionRepo>,
        /// Count of active features; absent or null means all.
        #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")] rollback: Option<Option<Real>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] sketch_visibility: Side<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")] body_visibility: Side<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")] plane_visibility: Side<bool>,
        /// `"<featureId>:<n>"` to body id, so ids survive edits around them.
        #[serde(default, skip_serializing_if = "Option::is_none")] body_ids: Side<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] body_names: Side<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] elements: Option<Vec<Element>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] body_element: Side<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] materials: Option<Vec<Material>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] body_material: Side<String>,
        /// `bodyId#localFaceIndex` to material id.
        #[serde(default, skip_serializing_if = "Option::is_none")] face_materials: Side<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] import_color_source: Side<ImportColorSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")] palette: Option<Vec<PaletteSlot>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] body_colors: Side<Real>,
    }
);

impl CadDocument {
    pub fn from_json(text: &str) -> serde_json::Result<Self> {
        serde_json::from_str(text)
    }

    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }

    /// The parameter value a legacy bare name in a `Num` field resolves to.
    pub fn param(&self, name: &str) -> Option<f64> {
        self.parameters.as_ref()?.get(name).map(Real::get)
    }

    pub fn feature(&self, id: &str) -> Option<&Feature> {
        self.features.iter().find(|f| f.id() == id)
    }
}
