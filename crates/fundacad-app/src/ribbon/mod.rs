//! The model tools by group, ui/ribbonDefs.ts's MODEL, which the rail's family tiles open. A split family is listed
//! under its own heading. Primitive was one button with a shape picker, here each shape is its own row.

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolItem {
    pub action: &'static str,
    pub label: &'static str,
    pub glyph: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Item {
    Tool(ToolItem),
    Split { label: &'static str, children: &'static [ToolItem] },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Group {
    pub label: &'static str,
    pub items: &'static [Item],
}

const fn t(action: &'static str, label: &'static str, glyph: &'static str) -> ToolItem {
    ToolItem { action, label, glyph }
}

const fn one(action: &'static str, label: &'static str, glyph: &'static str) -> Item {
    Item::Tool(t(action, label, glyph))
}

pub const MODEL: &[Group] = &[
    Group {
        label: "Create",
        items: &[
            one("sketch", "Sketch", "sketch"),
            one("extrude", "Extrude", "extrude"),
            Item::Split {
                label: "Primitive",
                children: &[
                    t("primitive-box", "Box", "box"),
                    t("primitive-cylinder", "Cylinder", "cylinder"),
                    t("primitive-sphere", "Sphere", "sphere"),
                    t("primitive-cone", "Cone", "cone"),
                    t("primitive-torus", "Torus", "torus"),
                ],
            },
            Item::Split {
                label: "Revolve",
                children: &[t("revolve", "Revolve", "revolve"), t("loft", "Loft", "loft"), t("sweep", "Sweep", "sweep")],
            },
        ],
    },
    Group {
        label: "Modify",
        items: &[
            one("presspull", "Press Pull", "presspull"),
            one("fillet", "Fillet", "fillet"),
            one("chamfer", "Chamfer", "chamfer"),
            one("hole", "Hole", "hole"),
            Item::Split {
                label: "Move",
                children: &[
                    t("move", "Move", "move"),
                    t("scale", "Scale", "scale"),
                    t("mirror", "Mirror", "mirror"),
                    t("joint", "Joint", "assembly"),
                    t("mechanism", "Mechanism", "mechanism"),
                    t("pattern-linear", "Linear Pattern", "patternLinear"),
                    t("pattern-circular", "Circular Pattern", "patternCircular"),
                    t("pattern-rect", "Rectangular Pattern", "patternRect"),
                ],
            },
            Item::Split {
                label: "Boolean",
                children: &[
                    t("boolean-union", "Union", "booleanUnion"),
                    t("boolean-subtract", "Subtract", "booleanSubtract"),
                    t("boolean-intersect", "Intersect", "booleanIntersect"),
                ],
            },
            one("split", "Split Body", "split"),
            one("separate", "Separate", "split"),
            Item::Split {
                label: "Shell",
                children: &[
                    t("shell", "Shell", "shell"),
                    t("draft", "Draft", "draft"),
                    t("thread", "Thread", "thread"),
                    t("text-on-face", "Text on Face", "text"),
                    t("offset-face", "Offset Face", "offsetFace"),
                    t("thicken", "Thicken", "thicken"),
                ],
            },
            one("parameters", "Parameters", "parameters"),
        ],
    },
    Group {
        label: "Construct",
        items: &[
            one("offset-plane", "Offset Plane", "offsetPlane"),
            Item::Split {
                label: "Plane",
                children: &[
                    t("datum-plane", "Datum Plane", "datumPlane"),
                    t("midplane", "Midplane", "midplane"),
                    t("plane-points", "Plane Through Points", "planePoints"),
                    t("plane-normal-edge", "Normal to Edge", "datumPlane"),
                    t("plane-two-edges", "Plane Through Two Edges", "datumPlane"),
                    t("plane-angle", "Plane at Angle", "datumPlane"),
                ],
            },
            Item::Split {
                label: "Datum",
                children: &[
                    t("datum-point", "Datum Point", "datumPoint"),
                    t("datum-axis", "Datum Axis", "datumAxis"),
                    t("datum-axis-edge", "Axis on Edge", "datumAxis"),
                    t("axis-cylinder", "Axis of Cylinder", "datumAxis"),
                    t("axis-planes", "Axis of Two Planes", "datumAxis"),
                ],
            },
        ],
    },
    Group {
        label: "Inspect",
        items: &[
            one("measure", "Measure", "measure"),
            one("section", "Section", "section"),
            Item::Split {
                label: "Analyze",
                children: &[
                    t("properties", "Properties", "properties"),
                    t("interference", "Interference", "interference"),
                    t("stress", "Stress", "stress"),
                    t("draft-analysis", "Overhang", "draftAnalysis"),
                    t("zebra", "Zebra", "zebra"),
                    t("curvature", "Curvature", "curvature"),
                    t("component-colors", "Body Colors", "componentColors"),
                ],
            },
            one("materials", "Materials", "material"),
        ],
    },
    Group {
        label: "Insert",
        items: &[
            one("import", "Import Mesh", "import"),
            one("insert-document", "Insert Document", "insertDocument"),
            one("simplify-mesh", "Simplify Mesh", "simplifyMesh"),
            one("clean-up", "Clean Up", "cleanUp"),
            one("compute-all", "Compute All", "computeAll"),
        ],
    },
];

pub fn group(label: &str) -> Option<&'static Group> {
    MODEL.iter().find(|g| g.label == label)
}

/// Every tool of a group, split families flattened.
#[cfg(test)]
pub fn leaves(g: &Group) -> Vec<ToolItem> {
    g.items
        .iter()
        .flat_map(|i| match i {
            Item::Tool(t) => vec![*t],
            Item::Split { children, .. } => children.to_vec(),
        })
        .collect()
}
