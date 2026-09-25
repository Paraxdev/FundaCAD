//! The timeline's features: `CoreFeature` and `PluginFeature` in `src/types.ts`,
//! as the handlers of the Python engine's `builder.py` read them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::selector::{Axis3, Selector};
use super::sketch::{plain_struct, SketchConstraint, SketchEntity, SketchPattern};
use super::value::{nullable, open_enum, tagged_enum, Extra, Num, OneOrMany, Real, Vec3};
use super::FaceColorRuns;

open_enum! {
    pub enum Plane3 { XY = "XY", XZ = "XZ", YZ = "YZ" }
}

plain_struct!(
    /// An arbitrary plane in world mm; the in-plane Y axis is `normal x xdir`.
    PlaneDef { origin: Vec3, normal: Vec3, xdir: Vec3 }
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PlaneSpec {
    Named(Plane3),
    Def(PlaneDef),
}

plain_struct!(AxisLine {
    origin: Vec3,
    dir: Vec3
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AxisSpec {
    Named(Axis3),
    Line(AxisLine),
}

plain_struct!(DatumAxisRef { datum: String });

/// A circular pattern's `axis`. Every form but X, Y and Z is an object, which a
/// build from before them refuses; a bare datum id it would turn about world Z.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PatternAxis {
    Named(Axis3),
    Line(AxisLine),
    Datum(DatumAxisRef),
}

open_enum! {
    /// `new | join | cut | intersect`, the extrude family's boolean.
    pub enum Operation { New = "new", Join = "join", Cut = "cut", Intersect = "intersect" }
}
open_enum! {
    pub enum BooleanOp { Union = "union", Subtract = "subtract", Intersect = "intersect" }
}
open_enum! {
    pub enum PressPullMode { Auto = "auto", Join = "join", Cut = "cut", New = "new", Intersect = "intersect" }
}
open_enum! {
    /// `axis` moves the face along the axis its walls run along, so a hole deepens.
    pub enum PressPullDirection { Normal = "normal", Axis = "axis" }
}
open_enum! {
    pub enum JointMode { Rigid = "rigid", Revolute = "revolute", Slider = "slider" }
}
open_enum! {
    pub enum HoleType { Simple = "simple", Counterbore = "counterbore", Countersink = "countersink", Insert = "insert" }
}
open_enum! {
    pub enum HoleStandard { Clearance = "clearance", Tap = "tap", Custom = "custom" }
}
open_enum! {
    pub enum HoleFit { Close = "close", Normal = "normal", Loose = "loose" }
}
open_enum! {
    pub enum HoleExtent { Blind = "blind", Through = "through" }
}
open_enum! {
    pub enum ImportFormat { Stl = "stl", ThreeMf = "3mf", Step = "step", Obj = "obj", Brep = "brep", Glb = "glb" }
}
open_enum! {
    pub enum SplitKeep { Top = "top", Bottom = "bottom", Both = "both" }
}

/// Every feature's `id`, its type's own fields, the `activeWhen` any feature may
/// carry (the Python engine's `builder.py` `_is_inactive`), and the keys this build does not know.
macro_rules! feature_struct {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            pub id: String,
            $($(#[$fmeta])* pub $field: $ty,)*
            /// Built only while this resolves to non-zero.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub active_when: Option<Num>,
            #[serde(flatten)]
            pub extra: Extra,
        }
    };
}

feature_struct!(
    /// `planeId` (a datum) or `face` make the sketch follow; `plane` is the resolved cache.
    SketchFeature {
        plane: PlaneSpec,
        #[serde(default, skip_serializing_if = "Option::is_none")] plane_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] face: Option<Selector>,
        #[serde(default, skip_serializing_if = "Option::is_none")] at: Option<Vec3>,
        entities: Vec<SketchEntity>,
        #[serde(default, skip_serializing_if = "Option::is_none")] constraints: Option<Vec<SketchConstraint>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] patterns: Option<Vec<SketchPattern>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] name: Option<String>,
    }
);

feature_struct!(Extrude {
    sketch: String,
    distance: Num,
    operation: Operation,
    /// Interior points of the chosen profile areas.
    #[serde(default, skip_serializing_if = "Option::is_none")] regions: Option<Vec<Vec3>>,
    /// The legacy single-area form of `regions`.
    #[serde(default, skip_serializing_if = "Option::is_none")] region: Option<Vec3>,
    #[serde(default, skip_serializing_if = "Option::is_none")] hidden_bodies: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] symmetric: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")] taper: Option<Num>,
});

feature_struct!(
    /// `profile`: -1 chamfer, 0 circular, +1 sharp corner.
    Fillet {
        edges: OneOrMany<Selector>,
        radius: Num,
        #[serde(default, skip_serializing_if = "Option::is_none")] profile: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] size_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] continuity: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] tangent_edges: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")] draft: Option<bool>,
    }
);

feature_struct!(Chamfer {
    edges: OneOrMany<Selector>,
    distance: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] chamfer_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] distance2: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] tangent_edges: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")] draft: Option<bool>,
});

feature_struct!(PressPull {
    face: OneOrMany<Selector>,
    distance: Num,
    /// Absent when `mode` decides.
    #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] up_to: Option<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")] taper: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] mode: Option<PressPullMode>,
    /// Absent means `normal`.
    #[serde(default, skip_serializing_if = "Option::is_none")] direction: Option<PressPullDirection>,
});

feature_struct!(DeleteFace {
    face: OneOrMany<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
});

plain_struct!(PlaneName { name: Plane3 });

/// A mirror's `plane`, a world plane or datum plane by name. A mirror that
/// names `bodies` writes it as `{name}`, which a build from before targeted
/// mirrors refuses; a bare name it would read and reflect the active body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MirrorPlane {
    Named(Plane3),
    Ref(PlaneName),
}

impl MirrorPlane {
    pub fn name(&self) -> &str {
        match self {
            MirrorPlane::Named(n) => n.as_str(),
            MirrorPlane::Ref(r) => r.name.as_str(),
        }
    }
}

feature_struct!(Mirror {
    plane: MirrorPlane,
    #[serde(default, skip_serializing_if = "Option::is_none")] bodies: Option<Vec<String>>,
});

feature_struct!(
    /// `axisEdge` makes the axis follow a model edge, with `axis` as the cache.
    Revolve {
        sketch: String,
        axis: AxisSpec,
        #[serde(default, skip_serializing_if = "Option::is_none")] axis_edge: Option<Selector>,
        angle: Num,
        #[serde(default, skip_serializing_if = "Option::is_none")] pitch: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
        #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] regions: Option<Vec<Vec3>>,
    }
);

plain_struct!(LoftProfile {
    sketch: String,
    region: Vec3
});

feature_struct!(Loft {
    #[serde(default, skip_serializing_if = "Option::is_none")] profiles: Option<Vec<LoftProfile>>,
    /// The legacy whole-sketch form of `profiles`.
    #[serde(default, skip_serializing_if = "Option::is_none")] sketches: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
});

feature_struct!(Sweep {
    profile: String,
    path: String,
    operation: Operation,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
});

feature_struct!(
    /// The reference (`planeId`, else `face`, else `plane`), shifted by
    /// `shiftX`/`shiftY`/`offset` along its own axes, then turned about that
    /// point: `tiltX` about the reference x, `tiltY` about the y that leaves,
    /// `spin` about the normal that leaves. Angles in degrees.
    DatumPlane {
        plane: PlaneSpec,
        #[serde(default, skip_serializing_if = "Option::is_none")] offset: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] face: Option<Selector>,
        #[serde(default, skip_serializing_if = "Option::is_none")] at: Option<Vec3>,
        #[serde(default, skip_serializing_if = "Option::is_none")] plane_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] tilt_x: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] tilt_y: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] spin: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] shift_x: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] shift_y: Option<Num>,
    }
);

feature_struct!(DatumPoint {
    point: Vec3,
    #[serde(default, skip_serializing_if = "Option::is_none")] name: Option<String>,
});

feature_struct!(DatumAxis {
    origin: Vec3,
    dir: Vec3,
    #[serde(default, skip_serializing_if = "Option::is_none")] name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] axis_edge: Option<Selector>,
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportNode {
    pub name: String,
    #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")]
    #[allow(clippy::option_option)]
    pub parent: Option<Option<Real>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

plain_struct!(ImportPart {
    node: Real,
    faces: Real,
    #[serde(default, skip_serializing_if = "Option::is_none")] face_colors: Option<FaceColorRuns>,
    #[serde(default, skip_serializing_if = "Option::is_none")] color: Option<String>,
});
plain_struct!(ImportLink {
    path: String,
    stamp: String
});
plain_struct!(GeneratedBy {
    plugin: String,
    spec: Extra
});

feature_struct!(
    /// An imported body, embedded so the file rebuilds without the original.
    Import {
        /// Not read by a rebuild, which loads the stored BREP whatever it came from.
        #[serde(default, skip_serializing_if = "Option::is_none")] format: Option<ImportFormat>,
        name: String,
        /// Content hash in the container's blob store.
        #[serde(default, skip_serializing_if = "Option::is_none")] geom: Option<String>,
        /// The pre-v5 inline base64 BREP, still read, never written.
        #[serde(default, skip_serializing_if = "Option::is_none")] brep: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] solid: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")] color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] explode: Option<bool>,
        #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")] nodes: Option<Option<Vec<ImportNode>>>,
        #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")] parts: Option<Option<Vec<ImportPart>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] link: Option<ImportLink>,
        #[serde(default, skip_serializing_if = "Option::is_none")] generated_by: Option<GeneratedBy>,
    }
);

feature_struct!(Split {
    #[serde(default, skip_serializing_if = "Option::is_none")] plane: Option<PlaneSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")] plane_id: Option<String>,
    keep: SplitKeep,
    #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] bodies: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] group_sides: Option<bool>,
});

feature_struct!(Imprint {
    sketch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
});

feature_struct!(
    /// The target keeps its id; tools are consumed unless `keepOriginals`.
    BooleanFeature {
        operation: BooleanOp,
        #[serde(default, skip_serializing_if = "Option::is_none")] target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] tools: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] keep_originals: Option<bool>,
    }
);

feature_struct!(BoxFeature {
    length: Num, width: Num, height: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
});
feature_struct!(Cylinder {
    radius: Num, height: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
});
feature_struct!(Cone {
    bottom_radius: Num, top_radius: Num, height: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
});
feature_struct!(Sphere {
    radius: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
});
feature_struct!(Torus {
    major_radius: Num, minor_radius: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
});

feature_struct!(Shell {
    thickness: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] faces: Option<OneOrMany<Selector>>,
});
feature_struct!(OffsetFace {
    faces: OneOrMany<Selector>,
    distance: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
});
feature_struct!(Thicken {
    #[serde(default, skip_serializing_if = "Option::is_none")] faces: Option<OneOrMany<Selector>>,
    thickness: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] symmetric: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")] operation: Option<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")] targets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
});
feature_struct!(Draft { faces: OneOrMany<Selector>, angle: Num, axis: Axis3 });

feature_struct!(
    /// A dimension left out comes from `size` (features/holeStandards.ts).
    Hole {
        #[serde(default, skip_serializing_if = "Option::is_none")] face: Option<Selector>,
        #[serde(default, skip_serializing_if = "Option::is_none")] points: Option<Vec<Vec3>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] sketch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] hole_type: Option<HoleType>,
        #[serde(default, skip_serializing_if = "Option::is_none")] standard: Option<HoleStandard>,
        #[serde(default, skip_serializing_if = "Option::is_none")] size: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] fit: Option<HoleFit>,
        #[serde(default, skip_serializing_if = "Option::is_none")] diameter: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] extent: Option<HoleExtent>,
        #[serde(default, skip_serializing_if = "Option::is_none")] depth: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] cb_diameter: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] cb_depth: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] cs_diameter: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] cs_angle: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] lead_in: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] drill_point: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")] flip: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")] tapped: Option<bool>,
    }
);

feature_struct!(
    /// `features` repeats those features' cuts and joins instead of a body.
    PatternRect {
        count_x: Num,
        count_y: Num,
        spacing_x: Num,
        spacing_y: Num,
        #[serde(default, skip_serializing_if = "Option::is_none")] bodies: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] features: Option<Vec<String>>,
    }
);
feature_struct!(PatternLinear {
    count: Num, spacing: Num, axis: Axis3,
    #[serde(default, skip_serializing_if = "Option::is_none")] bodies: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] features: Option<Vec<String>>,
});
feature_struct!(
    /// `axis` is X, Y, Z, a line, or `{datum}` naming a datum axis above the
    /// pattern. `axisRef` makes the axis follow an edge or face, with the line
    /// in `axis` as the cache.
    PatternCircular {
        count: Num, angle: Num, axis: PatternAxis,
        #[serde(default, skip_serializing_if = "Option::is_none")] axis_ref: Option<Selector>,
        #[serde(default, skip_serializing_if = "Option::is_none")] bodies: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")] features: Option<Vec<String>>,
    }
);
feature_struct!(SimplifyMesh { tolerance: Num });
feature_struct!(
    /// `sx`/`sy`/`sz` override `factor` per axis; `about` is held still.
    Scale {
        factor: Num,
        #[serde(default, skip_serializing_if = "Option::is_none")] sx: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] sy: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] sz: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] about: Option<Vec3>,
        #[serde(default, skip_serializing_if = "Option::is_none")] bodies: Option<Vec<String>>,
    }
);
feature_struct!(
    /// Translate in mm, then rotate in degrees about the origin; an absent component is 0.
    Move {
        #[serde(default, skip_serializing_if = "Option::is_none")] dx: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] dy: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] dz: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] rx: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] ry: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] rz: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] bodies: Option<Vec<String>>,
    }
);

plain_struct!(
    /// One side of a joint: a frame on body geometry, on a datum, or given outright.
    MateConnector {
        #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] face: Option<Selector>,
        #[serde(default, skip_serializing_if = "Option::is_none")] edge: Option<Selector>,
        #[serde(default, skip_serializing_if = "Option::is_none")] datum: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] origin: Option<Vec3>,
        #[serde(default, skip_serializing_if = "Option::is_none")] zdir: Option<Vec3>,
        #[serde(default, skip_serializing_if = "Option::is_none")] xdir: Option<Vec3>,
    }
);

feature_struct!(Joint {
    moving: String,
    mate: MateConnector,
    to: MateConnector,
    #[serde(default, skip_serializing_if = "Option::is_none")] mode: Option<JointMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")] flush: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")] offset: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] angle: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] name: Option<String>,
});
feature_struct!(CleanUp {
    #[serde(default, skip_serializing_if = "Option::is_none")] body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] tolerance: Option<Num>,
});
feature_struct!(RemoveBody { bodies: Vec<String> });

tagged_enum! {
    /// A timeline entry. `Unknown` is a plugin's feature (or one from a newer
    /// build), carried and saved losslessly and never built by the core.
    pub enum Feature, tag = "type", first = ["id"] {
        Sketch(SketchFeature) = "sketch",
        Extrude(Extrude) = "extrude",
        Fillet(Fillet) = "fillet",
        Chamfer(Chamfer) = "chamfer",
        PressPull(PressPull) = "press-pull",
        DeleteFace(DeleteFace) = "deleteFace",
        Mirror(Mirror) = "mirror",
        Revolve(Revolve) = "revolve",
        Loft(Loft) = "loft",
        Sweep(Sweep) = "sweep",
        DatumPlane(DatumPlane) = "datumPlane",
        DatumPoint(DatumPoint) = "datumPoint",
        DatumAxis(DatumAxis) = "datumAxis",
        Import(Import) = "import",
        Split(Split) = "split",
        Imprint(Imprint) = "imprint",
        Boolean(BooleanFeature) = "boolean",
        Box(BoxFeature) = "box",
        Cylinder(Cylinder) = "cylinder",
        Cone(Cone) = "cone",
        Sphere(Sphere) = "sphere",
        Torus(Torus) = "torus",
        Shell(Shell) = "shell",
        OffsetFace(OffsetFace) = "offsetFace",
        Thicken(Thicken) = "thicken",
        Draft(Draft) = "draft",
        Hole(Hole) = "hole",
        PatternRect(PatternRect) = "patternRect",
        PatternLinear(PatternLinear) = "patternLinear",
        PatternCircular(PatternCircular) = "patternCircular",
        SimplifyMesh(SimplifyMesh) = "simplifyMesh",
        Scale(Scale) = "scale",
        Move(Move) = "move",
        Duplicate(Move) = "duplicate",
        Joint(Joint) = "joint",
        CleanUp(CleanUp) = "cleanUp",
        RemoveBody(RemoveBody) = "removeBody",
    }
}

macro_rules! each_known {
    ($self:ident, $f:ident => $e:expr, $unknown:ident => $u:expr) => {
        match $self {
            Feature::Sketch($f) => $e,
            Feature::Extrude($f) => $e,
            Feature::Fillet($f) => $e,
            Feature::Chamfer($f) => $e,
            Feature::PressPull($f) => $e,
            Feature::DeleteFace($f) => $e,
            Feature::Mirror($f) => $e,
            Feature::Revolve($f) => $e,
            Feature::Loft($f) => $e,
            Feature::Sweep($f) => $e,
            Feature::DatumPlane($f) => $e,
            Feature::DatumPoint($f) => $e,
            Feature::DatumAxis($f) => $e,
            Feature::Import($f) => $e,
            Feature::Split($f) => $e,
            Feature::Imprint($f) => $e,
            Feature::Boolean($f) => $e,
            Feature::Box($f) => $e,
            Feature::Cylinder($f) => $e,
            Feature::Cone($f) => $e,
            Feature::Sphere($f) => $e,
            Feature::Torus($f) => $e,
            Feature::Shell($f) => $e,
            Feature::OffsetFace($f) => $e,
            Feature::Thicken($f) => $e,
            Feature::Draft($f) => $e,
            Feature::Hole($f) => $e,
            Feature::PatternRect($f) => $e,
            Feature::PatternLinear($f) => $e,
            Feature::PatternCircular($f) => $e,
            Feature::SimplifyMesh($f) => $e,
            Feature::Scale($f) => $e,
            Feature::Move($f) => $e,
            Feature::Duplicate($f) => $e,
            Feature::Joint($f) => $e,
            Feature::CleanUp($f) => $e,
            Feature::RemoveBody($f) => $e,
            Feature::Unknown($unknown)
            | Feature::Invalid(super::value::Invalid { raw: $unknown, .. }) => $u,
        }
    };
}

impl Feature {
    /// Empty only for a malformed unknown feature with no string `id`.
    pub fn id(&self) -> &str {
        each_known!(self, f => &f.id, v => v.get("id").and_then(Value::as_str).unwrap_or(""))
    }

    /// `activeWhen`, on a known feature or a plugin's.
    pub fn active_when(&self) -> Option<Num> {
        each_known!(self, f => f.active_when.clone(), v => v.get("activeWhen").and_then(|a| serde_json::from_value(a.clone()).ok()))
    }

    pub fn is_core_type(type_name: &str) -> bool {
        Self::KNOWN.contains(&type_name)
    }
}
