//! The rail while sketching, FundaCAD 1's ui/railDefs.ts sketchRail: the drawing tools in rail order, each family
//! behind one button whose face is the variant last used.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tool {
    pub action: &'static str,
    pub label: &'static str,
    pub glyph: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub enum Slot {
    Tool(Tool),
    Family { id: &'static str, label: &'static str, items: &'static [Tool] },
}

const fn t(action: &'static str, label: &'static str, glyph: &'static str) -> Tool {
    Tool { action, label, glyph }
}

const fn one(action: &'static str, label: &'static str, glyph: &'static str) -> Slot {
    Slot::Tool(t(action, label, glyph))
}

pub const SLOTS: &[Slot] = &[
    one("line", "tool.line", "line"),
    one("arc", "tool.arc", "arc"),
    Slot::Family {
        id: "spline",
        label: "tool.spline",
        items: &[t("spline", "tool.spline", "spline"), t("bspline", "tool.bspline", "bspline")],
    },
    Slot::Family {
        id: "rectangle",
        label: "tool.rectangle",
        items: &[
            t("rectangle", "tool.rectangle", "rectangle"),
            t("centerRectangle", "tool.centerRectangle", "centerRectangle"),
            t("rectangle3", "tool.rectangle3", "rectangle3"),
        ],
    },
    Slot::Family {
        id: "circle",
        label: "tool.circle",
        items: &[
            t("circle", "tool.circle", "circle"),
            t("circle2", "tool.circle2", "circle2"),
            t("circle3", "tool.circle3", "circle3"),
        ],
    },
    one("polygon", "tool.polygon", "polygon"),
    Slot::Family { id: "slot", label: "tool.slot", items: &[t("slot", "tool.slot", "slot"), t("point", "tool.point", "point")] },
    Slot::Family {
        id: "offset",
        label: "tool.offset",
        items: &[t("offset", "tool.offset", "offset"), t("extend", "tool.extend", "extend"), t("break", "tool.break", "break")],
    },
    Slot::Family {
        id: "corner",
        label: "tool.fillet",
        items: &[t("fillet-sketch", "tool.fillet", "fillet"), t("chamfer-sketch", "tool.chamfer", "chamfer")],
    },
    one("move-sketch", "tool.moveRotate", "move"),
    one("mirror-sketch", "tool.mirror", "mirror"),
    Slot::Family {
        id: "pattern",
        label: "tool.pattern",
        items: &[
            t("patternRect", "tool.rectPattern", "patternRect"),
            t("patternCircular", "tool.circularPat", "patternCircular"),
            t("boltCircle", "tool.boltCircle", "boltCircle"),
            t("hexHoles", "tool.hexHoles", "hexHoles"),
            t("honeycomb", "tool.honeycomb", "honeycomb"),
            t("gridHoles", "tool.gridHoles", "gridHoles"),
        ],
    },
    one("project", "tool.project", "project"),
    one("text", "tool.text", "text"),
    one("trim", "tool.trim", "trim"),
    one("dimension", "tool.dimension", "dimension"),
    Slot::Family {
        id: "constrain",
        label: "tool.constrain",
        items: &[
            t("horizontal", "tool.horizontal", "horizontal"),
            t("vertical", "tool.vertical", "vertical"),
            t("parallel", "tool.parallel", "parallel"),
            t("perpendicular", "tool.perpendicular", "perpendicular"),
            t("equal", "tool.equal", "equal"),
            t("tangent", "tool.tangent", "tangent"),
            t("coincident", "tool.coincident", "coincident"),
            t("concentric", "tool.concentric", "concentric"),
            t("midpoint", "tool.midpoint", "midpoint"),
            t("collinear", "tool.collinear", "collinear"),
            t("symmetric", "tool.symmetric", "symmetric"),
            t("fix", "tool.fix", "fix"),
        ],
    },
    one("tie-loose-ends", "tool.tieLooseEnds", "coincident"),
];

#[cfg(test)]
pub fn tools() -> impl Iterator<Item = Tool> {
    SLOTS
        .iter()
        .flat_map(|s| match s {
            Slot::Tool(t) => std::slice::from_ref(t),
            Slot::Family { items, .. } => items,
        })
        .copied()
}
