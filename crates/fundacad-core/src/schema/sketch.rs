//! Sketch entities, constraints, patterns and projected curves: `SketchEntity`,
//! `SketchConstraint`, `SketchPattern`, `ProjectedCurve` and `ProjectedSource` in
//! `src/types.ts` (built by sidecar/sketch_build.py).

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::selector::Selector;
use super::value::{open_enum, tagged_enum, Extra, Num, Real};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceOffset {
    pub ox: Real,
    pub oy: Real,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Badge label placements keyed by the dimension they place
/// (`width`, `height`, `diameter`, `length`, `radius`).
pub type DimPlace = IndexMap<String, PlaceOffset>;

macro_rules! entity_struct {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub id: Option<String>,
            $($(#[$fmeta])* pub $field: $ty,)*
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub construction: Option<bool>,
            #[serde(flatten)]
            pub extra: Extra,
        }
    };
}

entity_struct!(
    /// `angle` is degrees about the rectangle's own centre, absent meaning 0.
    Rectangle {
        width: Num,
        height: Num,
        #[serde(default, skip_serializing_if = "Option::is_none")] x: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] y: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] angle: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] dim_place: Option<DimPlace>,
    }
);
entity_struct!(Circle {
    radius: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] x: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] y: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] dim_place: Option<DimPlace>,
});
entity_struct!(Line {
    x1: Num, y1: Num, x2: Num, y2: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] dim_place: Option<DimPlace>,
});
entity_struct!(
    /// Start, end and a point the arc passes through.
    Arc { x1: Num, y1: Num, x2: Num, y2: Num, mx: Num, my: Num }
);
entity_struct!(
    /// Built by the Python engine (sidecar/sketch_build.py); `angle` in degrees.
    Ellipse {
        rx: Num,
        ry: Num,
        #[serde(default, skip_serializing_if = "Option::is_none")] x: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] y: Option<Num>,
        #[serde(default, skip_serializing_if = "Option::is_none")] angle: Option<Num>,
    }
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SplinePoint {
    pub x: Num,
    pub y: Num,
    #[serde(flatten)]
    pub extra: Extra,
}

entity_struct!(Spline { points: Vec<SplinePoint> });
entity_struct!(Point { x: Num, y: Num });
entity_struct!(
    /// `angle` in degrees (radians before format v2).
    Polygon {
        x: Num, y: Num, radius: Num, sides: Num, angle: Num,
        #[serde(default, skip_serializing_if = "Option::is_none")] dim_place: Option<DimPlace>,
    }
);
entity_struct!(Slot {
    x1: Num, y1: Num, x2: Num, y2: Num, width: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] dim_place: Option<DimPlace>,
});

open_enum! {
    pub enum TextStyle { Regular = "regular", Bold = "bold", Italic = "italic", BoldItalic = "bolditalic" }
}
open_enum! {
    pub enum TextAlign { Left = "left", Center = "center", Right = "right" }
}

entity_struct!(Text {
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] x: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] y: Option<Num>,
    height: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] style: Option<TextStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")] align: Option<TextAlign>,
    #[serde(default, skip_serializing_if = "Option::is_none")] angle: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] path_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] position_on_path: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")] box_width: Option<Num>,
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CurveLine {
    pub x1: Real,
    pub y1: Real,
    pub x2: Real,
    pub y2: Real,
    #[serde(flatten)]
    pub extra: Extra,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CurveCircle {
    pub x: Real,
    pub y: Real,
    pub r: Real,
    #[serde(flatten)]
    pub extra: Extra,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CurveArc {
    pub x1: Real,
    pub y1: Real,
    pub x2: Real,
    pub y2: Real,
    pub mx: Real,
    pub my: Real,
    #[serde(flatten)]
    pub extra: Extra,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CurvePoly {
    pub pts: Vec<[Real; 2]>,
    #[serde(flatten)]
    pub extra: Extra,
}

tagged_enum! {
    /// A projected entity's cached 2D shape, authored by the engine.
    pub enum ProjectedCurve, tag = "kind", first = [] {
        Line(CurveLine) = "line",
        Circle(CurveCircle) = "circle",
        Arc(CurveArc) = "arc",
        Poly(CurvePoly) = "poly",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceEdge {
    pub body: String,
    pub sel: Selector,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceSketchCurve {
    pub sketch: String,
    pub entity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// This sibling's edge index in the source entity's edge list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<Real>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceSilhouette {
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

tagged_enum! {
    pub enum ProjectedSource, tag = "kind", first = [] {
        Edge(SourceEdge) = "edge",
        FaceBoundary(SourceEdge) = "faceBoundary",
        SketchCurve(SourceSketchCurve) = "sketchCurve",
        Silhouette(SourceSilhouette) = "silhouette",
    }
}

entity_struct!(Projected {
    source: ProjectedSource,
    curve: ProjectedCurve,
    #[serde(default, skip_serializing_if = "Option::is_none")] stale: Option<bool>,
});

tagged_enum! {
    pub enum SketchEntity, tag = "type", first = [] {
        Rectangle(Rectangle) = "rectangle",
        Circle(Circle) = "circle",
        Line(Line) = "line",
        Arc(Arc) = "arc",
        Ellipse(Ellipse) = "ellipse",
        Spline(Spline) = "spline",
        Point(Point) = "point",
        Polygon(Polygon) = "polygon",
        Slot(Slot) = "slot",
        Text(Text) = "text",
        Projected(Projected) = "projected",
    }
}

impl SketchEntity {
    pub fn id(&self) -> Option<&str> {
        match self {
            SketchEntity::Rectangle(e) => e.id.as_deref(),
            SketchEntity::Circle(e) => e.id.as_deref(),
            SketchEntity::Line(e) => e.id.as_deref(),
            SketchEntity::Arc(e) => e.id.as_deref(),
            SketchEntity::Ellipse(e) => e.id.as_deref(),
            SketchEntity::Spline(e) => e.id.as_deref(),
            SketchEntity::Point(e) => e.id.as_deref(),
            SketchEntity::Polygon(e) => e.id.as_deref(),
            SketchEntity::Slot(e) => e.id.as_deref(),
            SketchEntity::Text(e) => e.id.as_deref(),
            SketchEntity::Projected(e) => e.id.as_deref(),
            SketchEntity::Unknown(_) | SketchEntity::Invalid(_) => self
                .raw()
                .and_then(|v| v.get("id"))
                .and_then(serde_json::Value::as_str),
        }
    }
}

macro_rules! plain_struct {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            $($(#[$fmeta])* pub $field: $ty,)*
            #[serde(flatten)]
            pub extra: Extra,
        }
    };
}
pub(crate) use plain_struct;

plain_struct!(OneLine { line: String });
plain_struct!(TwoLines {
    l1: String,
    l2: String
});
plain_struct!(Distance {
    #[serde(default, skip_serializing_if = "Option::is_none")] id: Option<String>,
    line: String,
    value: Real,
});
plain_struct!(Diameter {
    #[serde(default, skip_serializing_if = "Option::is_none")] id: Option<String>,
    circle: String,
    value: Real,
});

/// A dimension's `id`, `value`, `driven` and `place`, shared by every placed dim.
macro_rules! dim_struct {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        plain_struct!($(#[$meta])* $name {
            #[serde(default, skip_serializing_if = "Option::is_none")] id: Option<String>,
            $($(#[$fmeta])* $field: $ty,)*
            value: Real,
            #[serde(default, skip_serializing_if = "Option::is_none")] driven: Option<bool>,
            #[serde(default, skip_serializing_if = "Option::is_none")] place: Option<PlaceOffset>,
        });
    };
}

dim_struct!(
    /// `p*`: 0/1 start/end, 0..3 rectangle corner, 2 arc centre.
    P2pDistance { e1: String, p1: Real, e2: String, p2: Real }
);
dim_struct!(P2lDistance {
    e: String,
    p: Real,
    line: String
});
dim_struct!(RadialGap {
    inner: String,
    outer: String
});
dim_struct!(C2cDistance {
    c1: String,
    c2: String
});
dim_struct!(C2lDistance {
    circle: String,
    line: String
});
dim_struct!(P2cDistance {
    e: String,
    p: Real,
    circle: String
});
dim_struct!(AngleDim {
    l1: String,
    l2: String
});
dim_struct!(RadiusDim { e: String });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OffsetPair {
    pub src: String,
    pub cpy: String,
    #[serde(flatten)]
    pub extra: Extra,
}
dim_struct!(Offset { pairs: Vec<OffsetPair> });

plain_struct!(Tangent {
    line: String,
    circle: String
});
plain_struct!(Coincident {
    e1: String,
    p1: Real,
    e2: String,
    p2: Real
});
plain_struct!(TwoRounds {
    c1: String,
    c2: String
});
plain_struct!(Midpoint {
    e: String,
    p: Real,
    line: String
});
plain_struct!(Symmetric {
    e1: String,
    p1: Real,
    e2: String,
    p2: Real,
    line: String
});
plain_struct!(Fix { e: String, p: Real });
plain_struct!(Pair {
    a: String,
    b: String
});

tagged_enum! {
    /// Solved by planegcs in the app; the engine only reads the entities.
    pub enum SketchConstraint, tag = "type", first = [] {
        Horizontal(OneLine) = "horizontal",
        Vertical(OneLine) = "vertical",
        Parallel(TwoLines) = "parallel",
        Perpendicular(TwoLines) = "perpendicular",
        Equal(TwoLines) = "equal",
        Distance(Distance) = "distance",
        Diameter(Diameter) = "diameter",
        P2pDistance(P2pDistance) = "p2pDistance",
        P2lDistance(P2lDistance) = "p2lDistance",
        RadialGap(RadialGap) = "radialGap",
        C2cDistance(C2cDistance) = "c2cDistance",
        C2lDistance(C2lDistance) = "c2lDistance",
        P2cDistance(P2cDistance) = "p2cDistance",
        Tangent(Tangent) = "tangent",
        Coincident(Coincident) = "coincident",
        Concentric(TwoRounds) = "concentric",
        Midpoint(Midpoint) = "midpoint",
        Symmetric(Symmetric) = "symmetric",
        Angle(AngleDim) = "angle",
        Radius(RadiusDim) = "radius",
        Fix(Fix) = "fix",
        Collinear(TwoLines) = "collinear",
        EqualRadius(Pair) = "equalRadius",
        Tangent2(Pair) = "tangent2",
        Offset(Offset) = "offset",
    }
}

plain_struct!(PatternRect {
    id: String, sources: Vec<String>, count_x: Num, count_y: Num, spacing_x: Num, spacing_y: Num,
    #[serde(default, skip_serializing_if = "Option::is_none")] angle: Option<Num>,
});
plain_struct!(PatternCircular { id: String, sources: Vec<String>, cx: Num, cy: Num, count: Num, angle: Num });
plain_struct!(HexHoles {
    id: String,
    cx: Num,
    cy: Num,
    diameter: Num,
    spacing: Num,
    rings: Num
});
plain_struct!(BoltCircle {
    id: String,
    cx: Num,
    cy: Num,
    bcd: Num,
    count: Num,
    diameter: Num
});
plain_struct!(GridHoles {
    id: String,
    cx: Num,
    cy: Num,
    diameter: Num,
    count_x: Num,
    count_y: Num,
    spacing_x: Num,
    spacing_y: Num,
});

tagged_enum! {
    /// Derived copies get ids `<pattern.id>#<n>`.
    pub enum SketchPattern, tag = "type", first = ["id"] {
        PatternRect(PatternRect) = "patternRect",
        PatternCircular(PatternCircular) = "patternCircular",
        HexHoles(HexHoles) = "hexHoles",
        Honeycomb(HexHoles) = "honeycomb",
        BoltCircle(BoltCircle) = "boltCircle",
        GridHoles(GridHoles) = "gridHoles",
    }
}
