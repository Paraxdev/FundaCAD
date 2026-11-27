//! The model tools by group, ui/ribbonDefs.ts's MODEL, which the rail's family tiles open. A split family is listed
//! under its own heading. Primitive was one button with a shape picker, here each shape is its own row.

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolItem {
    pub action: &'static str,
    /// A catalog key, the tool table's own where the tool has one.
    pub label: &'static str,
    pub glyph: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Item {
    Tool(ToolItem),
    /// `label` is a catalog key.
    Split { label: &'static str, children: &'static [ToolItem] },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Group {
    /// The rail family's id, `heading` the catalog key it shows.
    pub label: &'static str,
    pub heading: &'static str,
    pub items: &'static [Item],
}

const fn tool(action: &'static str, label: &'static str, glyph: &'static str) -> ToolItem {
    ToolItem { action, label, glyph }
}

const fn one(action: &'static str, label: &'static str, glyph: &'static str) -> Item {
    Item::Tool(tool(action, label, glyph))
}

pub const MODEL: &[Group] = &[
    Group {
        label: "Create",
        heading: "tool.group.create",
        items: &[
            one("sketch", "tool.sketch", "sketch"),
            one("extrude", "tool.extrude", "extrude"),
            Item::Split {
                label: "tool.primitive",
                children: &[
                    tool("primitive-box", "feature.box", "box"),
                    tool("primitive-cylinder", "feature.cylinder", "cylinder"),
                    tool("primitive-sphere", "feature.sphere", "sphere"),
                    tool("primitive-cone", "feature.cone", "cone"),
                    tool("primitive-torus", "feature.torus", "torus"),
                ],
            },
            Item::Split {
                label: "tool.revolve",
                children: &[tool("revolve", "tool.revolve", "revolve"), tool("loft", "tool.loft", "loft"), tool("sweep", "tool.sweep", "sweep")],
            },
        ],
    },
    Group {
        label: "Modify",
        heading: "tool.group.modify",
        items: &[
            one("presspull", "tool.pressPull", "presspull"),
            one("fillet", "tool.fillet", "fillet"),
            one("chamfer", "tool.chamfer", "chamfer"),
            one("hole", "tool.hole", "hole"),
            Item::Split {
                label: "tool.move",
                children: &[
                    tool("move", "tool.move", "move"),
                    tool("scale", "tool.scale", "scale"),
                    tool("mirror", "tool.mirror", "mirror"),
                    tool("joint", "tool.joint", "assembly"),
                    tool("mechanism", "tool.mechanism", "mechanism"),
                    tool("pattern-linear", "tool.linearPattern", "patternLinear"),
                    tool("pattern-circular", "tool.circularPattern", "patternCircular"),
                    tool("pattern-rect", "tool.rectPattern", "patternRect"),
                ],
            },
            Item::Split {
                label: "tool.family.boolean",
                children: &[
                    tool("boolean-union", "tool.union", "booleanUnion"),
                    tool("boolean-subtract", "tool.subtract", "booleanSubtract"),
                    tool("boolean-intersect", "tool.intersect", "booleanIntersect"),
                ],
            },
            one("split", "tool.splitBody", "split"),
            one("separate", "tool.separate", "split"),
            Item::Split {
                label: "tool.shell",
                children: &[
                    tool("shell", "tool.shell", "shell"),
                    tool("draft", "tool.draft", "draft"),
                    tool("thread", "tool.thread", "thread"),
                    tool("text-on-face", "tool.textOnFace", "text"),
                    tool("offset-face", "tool.offsetFace", "offsetFace"),
                    tool("thicken", "tool.thicken", "thicken"),
                ],
            },
            one("parameters", "tool.parameters", "parameters"),
        ],
    },
    Group {
        label: "Construct",
        heading: "tool.group.construct",
        items: &[
            one("offset-plane", "tool.offsetPlane", "offsetPlane"),
            Item::Split {
                label: "tool.family.plane",
                children: &[
                    tool("datum-plane", "tool.datumPlane", "datumPlane"),
                    tool("midplane", "tool.midplane", "midplane"),
                    tool("plane-points", "tool.planePoints", "planePoints"),
                    tool("plane-normal-edge", "tool.normalToEdge", "datumPlane"),
                    tool("plane-two-edges", "tool.planeTwoEdges", "datumPlane"),
                    tool("plane-angle", "tool.planeAtAngle", "datumPlane"),
                ],
            },
            Item::Split {
                label: "tool.family.datum",
                children: &[
                    tool("datum-point", "tool.datumPoint", "datumPoint"),
                    tool("datum-axis", "tool.datumAxis", "datumAxis"),
                    tool("datum-axis-edge", "tool.axisOnEdge", "datumAxis"),
                    tool("axis-cylinder", "tool.axisOfCylinder", "datumAxis"),
                    tool("axis-planes", "tool.axisTwoPlanes", "datumAxis"),
                ],
            },
        ],
    },
    Group {
        label: "Inspect",
        heading: "tool.group.inspect",
        items: &[
            one("measure", "tool.measure", "measure"),
            one("section", "tool.section", "section"),
            Item::Split {
                label: "tool.family.analyze",
                children: &[
                    tool("properties", "tool.properties", "properties"),
                    tool("interference", "tool.interference", "interference"),
                    tool("stress", "tool.stress", "stress"),
                    tool("draft-analysis", "tool.overhang", "draftAnalysis"),
                    tool("printability", "inspect.printability", "check"),
                    tool("bed-fit", "inspect.bedFit", "printing/print"),
                    tool("zebra", "tool.zebra", "zebra"),
                    tool("curvature", "tool.curvature", "curvature"),
                    tool("component-colors", "tool.bodyColors", "componentColors"),
                ],
            },
            one("materials", "tool.materials", "material"),
        ],
    },
    Group {
        label: "Insert",
        heading: "tool.group.insert",
        items: &[
            one("import", "tool.importMesh", "import"),
            one("insert-document", "tool.insertDocument", "insertDocument"),
            one("simplify-mesh", "tool.simplifyMesh", "simplifyMesh"),
            one("clean-up", "tool.cleanUp", "cleanUp"),
            one("compute-all", "tool.computeAll", "computeAll"),
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
