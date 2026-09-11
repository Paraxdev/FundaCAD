"""What a feature looks like, written for the thing that has to author one.

An agent cannot click. Everything it builds it builds by putting a JSON object
into the timeline, so the only thing standing between it and a working model is
knowing what the objects look like. This is that reference, and it is a
first-class part of the server rather than a README: it is served as an MCP
resource and returned by the `schema` tool, so the caller can read it without
leaving the conversation.

It is hand-written, because the authority, src/types.ts, is a TypeScript
discriminated union with the reasoning in its comments, and no generator turns
that into prose worth reading. Hand-written documentation rots, so
tests/test_schema.py holds it to the sidecar: every type documented here must
be a type the builder handles, and every type the builder handles must be
documented here. That test is the whole reason this is safe to hand-write.
"""

#: Shared vocabulary, quoted once and referenced from the entries below.
COMMON = {
    "Num": (
        "A number, or the NAME of a parameter as a string. `48` and `\"hub_d\"` "
        "are both valid; the string form is what makes the model parametric, and "
        "it is resolved against the document parameter table at build time."
    ),
    "PlaneSpec": (
        'Either "XY", "XZ" or "YZ", or an explicit plane '
        '{"origin":[x,y,z], "normal":[x,y,z], "xdir":[x,y,z]} in world mm. '
        "In-plane Y is normal x xdir. FundaCAD is Z-UP."
    ),
    "AxisSpec": (
        'Either "X", "Y" or "Z", or a line {"origin":[x,y,z], "dir":[x,y,z]}.'
    ),
    "Selector": (
        "How a feature names a face or an edge of a body that does not exist "
        "until the rebuild runs. Prefer the selector the `inspect` tool hands "
        "back for that exact face or edge, it carries a geometric fingerprint "
        "and survives small changes upstream. The forms are:\n"
        '  {"kind":"face"|"edge", "by":"match", "fp":{...}, "nth":k, "body":"body1"}\n'
        '  {"kind":"face", "by":"nearest", "point":[x,y,z], "body":"body1"}\n'
        '  {"kind":"face", "by":"normal", "dir":[0,0,1], "body":"body1"}   ALL faces facing that way\n'
        '  {"kind":"edge", "by":"nearest", "point":[x,y,z], "body":"body1"}\n'
        '  {"kind":"edge", "by":"axis", "axis":"Z", "body":"body1"}         ALL edges parallel to Z\n'
        '  {"kind":"edge", "by":"all", "body":"body1"}\n'
        '  {"kind":"edge", "by":"ofFace", "face":{...fp}, "body":"body1"}   the edges bounding a face\n'
        "ALWAYS set `body`. Without it a pick on a multi-body model can land on "
        "the wrong body silently."
    ),
    "region": (
        "A 3D point INSIDE the closed sketch area you mean, in world mm. A "
        "sketch with several closed areas (a ring, a plate with holes, two "
        "separate outlines) needs one point per area you want. Omit `regions` "
        "entirely to use the whole sketch."
    ),
    "operation": (
        'How the new material joins what is already there (default "new"): '
        '"new" makes a '
        'separate body, "join" fuses into the target, "cut" subtracts from it, '
        '"intersect" keeps only the overlap.\n'
        "Without `targets`, a join/cut/intersect acts on EVERY visible body the "
        "new shape overlaps, not just the nearest one. That is what someone "
        "dragging a face across two parts means; it is not what building a "
        "second part beside a first one means. Set `targets` whenever more than "
        "one body exists."
    ),
    "targets": (
        'Optional list of body ids ["body1", ...] that a join/cut/intersect is '
        "allowed to touch. Bodies not named are left alone even where the new "
        "shape passes straight through them. Ignored when `operation` is "
        '"new". A join that names targets and reaches none of them is an error '
        "rather than a quietly-created extra body.\n"
        "Body ids are assigned in creation order AT BUILD TIME, so read them "
        "back from `build` or `inspect` rather than assuming them, and re-read "
        "them after a join: a join merges its targets into one body, which "
        "takes a fresh id."
    ),
    "MateConnector": (
        "One side of a joint: a coordinate frame, an origin, a z axis that is the "
        "mating direction, and an optional x axis for rotational reference, named "
        "one of four ways:\n"
        '  {"body":"body2", "face": <Selector>}   the face centre, its outward normal is the axis\n'
        '  {"body":"body2", "edge": <Selector>}   the edge midpoint, its direction is the axis\n'
        '  {"datum": <datumAxis or datumPlane id>}   follows that datum\n'
        '  {"origin":[x,y,z], "zdir":[x,y,z], "xdir":[x,y,z]}   an explicit world frame\n'
        "A connector on geometry is a REFERENCE, re-resolved every rebuild, so the "
        "joint tracks the part as it changes. Set `body` whenever you use `face` "
        "or `edge`."
    ),
}

#: type -> {summary, fields, example, notes}. `fields` is ordered and the
#: required ones come first, because that is the order somebody writes them in.
FEATURES = {
    # --- primitives -----------------------------------------------------------
    "box": {
        "summary": "An axis-aligned box CENTRED ON THE ORIGIN.",
        "fields": {"length": "Num, along X", "width": "Num, along Y", "height": "Num, along Z",
                   "operation": COMMON["operation"],
                   "targets": COMMON["targets"]},
        "example": {"id": "bx1", "type": "box", "length": 40, "width": 30, "height": 10},
        "notes": "Centred, not corner-placed: a 40x30x10 box spans -20..20, -15..15, -5..5.",
    },
    "cylinder": {
        "summary": "A cylinder on the Z axis, CENTRED ON THE ORIGIN.",
        "fields": {"radius": "Num", "height": "Num, along Z",
                   "operation": COMMON["operation"],
                   "targets": COMMON["targets"]},
        "example": {"id": "cy1", "type": "cylinder", "radius": 8, "height": 60},
        "notes": "Spans -height/2 .. +height/2 in Z. Use a `move` feature to place it.",
    },
    "sphere": {
        "summary": "A sphere centred on the origin.",
        "fields": {"radius": "Num",
                   "operation": COMMON["operation"],
                   "targets": COMMON["targets"]},
        "example": {"id": "sp1", "type": "sphere", "radius": 12},
    },

    # --- sketches and what is made from them -----------------------------------
    "sketch": {
        "summary": "A 2D profile on a plane. Makes no geometry by itself; extrude, "
                   "revolve, sweep and loft consume it.",
        "fields": {
            "plane": "PlaneSpec",
            "entities": "the curves, see the `sketchEntities` section of this schema",
            "planeId": "optional; the id of a datumPlane feature, which WINS over `plane`",
            "face": "optional Selector; makes the sketch follow a body face",
            "constraints": "optional; solved by the frontend, not needed for an authored sketch",
            "name": "optional label",
        },
        "example": {
            "id": "sk1", "type": "sketch", "plane": "XZ",
            "entities": [
                {"id": "e1", "type": "line", "x1": 10, "y1": 0, "x2": 30, "y2": 0},
                {"id": "e2", "type": "line", "x1": 30, "y1": 0, "x2": 30, "y2": 4},
                {"id": "e3", "type": "line", "x1": 30, "y1": 4, "x2": 10, "y2": 4},
                {"id": "e4", "type": "line", "x1": 10, "y1": 4, "x2": 10, "y2": 0},
            ],
        },
        "notes": "Sketch coordinates are 2D IN THE PLANE. On XY they are (x, y); on "
                 "XZ they are (x, z); on YZ they are (y, z). A profile to be "
                 "extruded or revolved must CLOSE, the endpoints have to meet "
                 "exactly, so write the same numbers, do not round differently.",
    },
    "extrude": {
        "summary": "Push a sketch profile along the sketch plane normal.",
        "fields": {
            "sketch": "the id of a sketch feature",
            "distance": "Num, signed; negative goes the other way",
            "symmetric": "optional bool; sweeps `distance` BOTH ways off the "
                         "sketch plane (the sign then means nothing). What a "
                         "sketch on a datum plane inside a body wants",
            "operation": COMMON["operation"],
            "targets": COMMON["targets"],
            "taper": "optional Num, degrees. Leans every wall in as the extrude "
                     "climbs, so one feature makes an angled boss, a countersink, "
                     "or a draw-ready wall. Positive narrows the far face (the way "
                     "a part pulls out of a mould), negative widens it (an "
                     "undercut). Must be between -89 and 89. Absent or 0 is a "
                     "straight prism",
            "regions": "optional; " + COMMON["region"],
            "region": "legacy single-area form of `regions`",
        },
        "example": {"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": 12,
                    "operation": "new"},
    },
    "revolve": {
        "summary": "Spin a sketch profile around an axis. With `pitch` it climbs "
                   "as it turns, which is how a thread is made.",
        "fields": {
            "sketch": "the id of a sketch feature",
            "axis": "AxisSpec",
            "angle": "Num, degrees. 360 is a full turn",
            "operation": COMMON["operation"],
            "targets": COMMON["targets"],
            "pitch": "optional Num, mm of climb per full turn. With a pitch, an "
                     "`angle` over 360 means more than one turn: a 2mm pitch at "
                     "1080 degrees climbs 6mm over three turns. The SIGN is the "
                     "direction of climb along the axis, and a thread that cuts "
                     "nothing is usually a thread climbing away from the body: "
                     "try the other sign. A field takes a number or a parameter "
                     "NAME, so write -2 directly, or define a parameter whose "
                     "expression is -pitch and name that. \"-pitch\" in the "
                     "field itself is an expression and is refused.",
            "axisEdge": "optional Selector naming a model edge to spin about; wins over `axis`",
            "regions": "optional; " + COMMON["region"],
        },
        "example": {"id": "rev1", "type": "revolve", "sketch": "sk1", "axis": "Z",
                    "angle": 360, "operation": "new"},
        "notes": "The profile must lie entirely on ONE side of the axis and must "
                 "not cross it. For a thread, draw the tooth cross-section in a "
                 "plane THROUGH the axis (XZ for a Z axis), set `pitch`, and wind "
                 "`angle` to 360 * number_of_turns.",
    },
    "sweep": {
        "summary": "Sweep a closed profile sketch along an open path sketch.",
        "fields": {"profile": "sketch id (closed)", "path": "sketch id (open)",
                   "operation": COMMON["operation"],
                   "targets": COMMON["targets"]},
        "example": {"id": "sw1", "type": "sweep", "profile": "sk1", "path": "sk2",
                    "operation": "new"},
    },
    "loft": {
        "summary": "Blend through two or more profiles in order.",
        "fields": {
            "sketches": "list of sketch ids, in order",
            "profiles": 'alternative: [{"sketch": id, "region": [x,y,z]}, ...] to pick '
                        "one area per sketch (a ring keeps its hole -> a tube)",
            "operation": COMMON["operation"],
            "targets": COMMON["targets"],
        },
        "example": {"id": "lo1", "type": "loft", "sketches": ["sk1", "sk2"],
                    "operation": "new"},
    },

    # --- modifying an existing body -------------------------------------------
    "fillet": {
        "summary": "Round one or more edges.",
        "fields": {
            "edges": "Selector or list of Selectors",
            "radius": "Num",
            "profile": "optional Num in -1..1: 0 (or absent) is the circular "
                       "fillet, -1 flattens it to a chamfer's chord, +1 pulls it "
                       "into the corner",
        },
        "example": {"id": "fil1", "type": "fillet",
                    "edges": {"kind": "edge", "by": "axis", "axis": "Z", "body": "body1"},
                    "radius": 2},
        "notes": "A SEAM edge cannot be filleted, that is the edge where a face "
                 "that wraps 360 degrees closes on itself, and the kernel needs "
                 "two DIFFERENT faces to blend between. `inspect` marks those "
                 'edges with "seam": true. The radius must also fit: it cannot '
                 "exceed the smaller of the two faces meeting at the edge.",
    },
    "chamfer": {
        "summary": "Flatten one or more edges.",
        "fields": {"edges": "Selector or list of Selectors", "distance": "Num"},
        "example": {"id": "cha1", "type": "chamfer",
                    "edges": {"kind": "edge", "by": "all", "body": "body1"}, "distance": 1},
    },
    "press-pull": {
        "summary": "Push one or more faces along their own normals.",
        "fields": {
            "face": "Selector or list of Selectors",
            "distance": "Num, signed: positive grows the body, negative cuts in",
            "operation": '"join" or "cut", a label derived from the sign',
            "body": "optional body id",
            "upTo": "optional Selector naming a target face to stop at, instead "
                    "of using `distance`",
        },
        "example": {"id": "pp1", "type": "press-pull",
                    "face": {"kind": "face", "by": "normal", "dir": [0, 0, 1], "body": "body1"},
                    "distance": 5, "operation": "join"},
        "notes": "A planar face extrudes into a prism and booleans. A cylinder, "
                 "cone, sphere or torus is truly OFFSET, which is how a hole is "
                 "resized. A freeform face that WRAPS (a full revolve, a swept "
                 "tube) is thickened along its own surface; `inspect` marks those "
                 'faces with "wraps": true.',
    },
    "shell": {
        "summary": "Hollow a body to a wall thickness, optionally opening faces.",
        "fields": {"thickness": "Num", "faces": "optional Selector(s) to remove (the openings)"},
        "example": {"id": "sh1", "type": "shell", "thickness": 2,
                    "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1], "body": "body1"}},
    },
    "offsetFace": {
        "summary": "Move faces along their normals without changing the rest.",
        "fields": {"faces": "Selector or list", "distance": "Num", "body": "optional body id"},
        "example": {"id": "of1", "type": "offsetFace",
                    "faces": {"kind": "face", "by": "nearest", "point": [0, 0, 10], "body": "body1"},
                    "distance": 1.5},
    },
    "draft": {
        "summary": "Tilt faces by an angle about an axis (mould release).",
        "fields": {"faces": "Selector or list", "angle": "Num, degrees",
                   "axis": '"X", "Y" or "Z", the pull direction'},
        "example": {"id": "dr1", "type": "draft",
                    "faces": {"kind": "face", "by": "normal", "dir": [1, 0, 0], "body": "body1"},
                    "angle": 3, "axis": "Z"},
    },
    "thicken": {
        "summary": "Give a surface (or a set of faces) a thickness.",
        "fields": {"thickness": "Num", "faces": "optional Selector(s)",
                   "symmetric": "optional bool", "operation": '"join" or "new"',
                   "targets": COMMON["targets"],
                   "body": "optional body id"},
        "example": {"id": "th1", "type": "thicken", "thickness": 1.2, "operation": "new"},
    },
    "deleteFace": {
        "summary": "Remove faces and heal the wound (defeature: takes a blend or "
                   "a boss off).",
        "fields": {"face": "Selector or list", "body": "optional body id"},
        "example": {"id": "df1", "type": "deleteFace",
                    "face": {"kind": "face", "by": "nearest", "point": [10, 0, 5], "body": "body1"}},
    },
    "cleanUp": {
        "summary": "Merge faces that are pieces of one surface, drop slivers.",
        "fields": {"body": "optional body id", "tolerance": "optional Num"},
        "example": {"id": "cu1", "type": "cleanUp"},
    },
    "simplifyMesh": {
        "summary": "Decimate an imported mesh body.",
        "fields": {"tolerance": "Num, mm"},
        "example": {"id": "sm1", "type": "simplifyMesh", "tolerance": 0.2},
    },
    "texture": {
        "summary": "Emboss or engrave a pattern onto faces.",
        "fields": {"see": "the `texture` feature is UI-driven; author it from an "
                          "existing document rather than from scratch"},
        "example": None,
    },

    # --- placement and combination ---------------------------------------------
    "move": {
        "summary": "Translate and rotate bodies.",
        "fields": {"dx": "Num", "dy": "Num", "dz": "Num",
                   "rx": "Num, degrees", "ry": "Num, degrees", "rz": "Num, degrees",
                   "bodies": "optional list of body ids; absent = the active body"},
        "example": {"id": "mv1", "type": "move", "dx": 0, "dy": 0, "dz": 25,
                    "rx": 0, "ry": 0, "rz": 0},
        "notes": "All six fields are required. This is the ONLY way to place a "
                 "primitive, since box/cylinder/sphere are always centred on the "
                 "origin.",
    },
    "joint": {
        "summary": "Position one body against another by aligning a mate connector "
                   "on each, and re-resolve those connectors every rebuild so the "
                   "assembly follows the parts.",
        "fields": {
            "moving": "body id of the body to reposition; nothing else moves",
            "mate": "MateConnector on the MOVING body, the frame brought to meet `to`. "
                    + COMMON["MateConnector"],
            "to": "MateConnector on the body it mates against, held fixed",
            "mode": '"rigid", "revolute" or "slider": which freedom the joint leaves, '
                    "so the UI offers the matching handle. The placement is the same "
                    "for all three.",
            "flush": "optional bool. Two mating faces meet FACE TO FACE by default "
                     "(their outward normals opposed); `flush` points the connector "
                     "axes the same way instead, so the parts sit on the same side.",
            "offset": "optional Num, mm along the mate axis (a slider's freedom)",
            "angle": "optional Num, degrees about the mate axis (a revolute's freedom)",
        },
        "example": {"id": "j1", "type": "joint", "moving": "body2",
                    "mate": {"body": "body2",
                             "face": {"kind": "face", "by": "nearest",
                                      "point": [50, 0, -3], "body": "body2"}},
                    "to": {"body": "body1",
                           "face": {"kind": "face", "by": "nearest",
                                    "point": [0, 0, 10], "body": "body1"}}},
        "notes": "Body ids are body1, body2, ... in creation order at build time, so "
                 "read them from `build` or `inspect`. A mate reference that no "
                 "longer resolves (a removed datum, a face a change deleted) leaves "
                 "the moving body exactly where it is and records a diagnostic, "
                 "rather than failing the build or teleporting the part.",
    },
    "scale": {
        "summary": "Scale bodies, uniformly or per axis.",
        "fields": {"factor": "Num, uniform", "sx": "Num", "sy": "Num", "sz": "Num",
                   "about": "optional [x,y,z] centre", "bodies": "optional list of body ids"},
        "example": {"id": "sc1", "type": "scale", "factor": 1.5},
    },
    "mirror": {
        "summary": "Mirror the active body across a world plane.",
        "fields": {"plane": '"XY", "XZ" or "YZ"'},
        "example": {"id": "mir1", "type": "mirror", "plane": "YZ"},
    },
    "boolean": {
        "summary": "Combine bodies.",
        "fields": {"operation": '"union", "subtract" or "intersect"',
                   "target": "body id kept",
                   "tools": "list of body ids applied to it",
                   "keepOriginals": "optional bool"},
        "example": {"id": "bo1", "type": "boolean", "operation": "subtract",
                    "target": "body1", "tools": ["body2"]},
        "notes": "Body ids are body1, body2, ... in creation order, NOT feature "
                 "ids. Call `build` and read the body list before writing one.",
    },
    "split": {
        "summary": "Cut bodies with a plane.",
        "fields": {"plane": "PlaneSpec", "planeId": "or a datumPlane feature id",
                   "keep": '"top", "bottom" or "both"',
                   "bodies": "optional list of body ids",
                   "groupSides": "optional bool"},
        "example": {"id": "spl1", "type": "split", "plane": "XY", "keep": "both"},
    },
    "removeBody": {
        "summary": "Delete bodies.",
        "fields": {"bodies": "list of body ids"},
        "example": {"id": "rb1", "type": "removeBody", "bodies": ["body2"]},
    },
    "datumPlane": {
        "summary": "A construction plane other features can sit on.",
        "fields": {"plane": "PlaneSpec", "offset": "optional mm along its normal",
                   "name": "optional label", "face": "optional Selector to follow a body face",
                   "at": "optional [x,y,z] pick point, needed on a round face"},
        "example": {"id": "pl1", "type": "datumPlane", "plane": "XY", "offset": 25},
    },
    "datumPoint": {
        "summary": "A reference point in space, a marker with no geometry that "
                   "other features and the user can snap to.",
        "fields": {"point": "[x,y,z] in world mm", "name": "optional label"},
        "example": {"id": "dp1", "type": "datumPoint", "point": [0, 0, 25]},
    },
    "datumAxis": {
        "summary": "A reference axis, an infinite construction line other features "
                   "(revolve, circular pattern, mirror, a joint) can be aimed at by name.",
        "fields": {"origin": "[x,y,z], a point on the line",
                   "dir": "[x,y,z], its direction; need not be unit length",
                   "axisEdge": "optional Selector anchoring the axis to a straight "
                               "model EDGE; the sidecar re-resolves that edge every "
                               "rebuild so the axis FOLLOWS the part, and "
                               "origin/dir stay as the cache it falls back to",
                   "name": "optional label"},
        "example": {"id": "ax1", "type": "datumAxis", "origin": [0, 0, 0], "dir": [0, 0, 1]},
    },

    # --- patterns --------------------------------------------------------------
    "patternLinear": {
        "summary": "Repeat bodies along an axis.",
        "fields": {"count": "Num", "spacing": "Num", "axis": '"X", "Y" or "Z"',
                   "bodies": "optional list of body ids"},
        "example": {"id": "pln1", "type": "patternLinear", "count": 5, "spacing": 12, "axis": "X"},
    },
    "patternCircular": {
        "summary": "Repeat bodies around an axis.",
        "fields": {"count": "Num", "angle": "Num, total degrees covered",
                   "axis": '"X", "Y" or "Z"', "bodies": "optional list of body ids"},
        "example": {"id": "pc1", "type": "patternCircular", "count": 6, "angle": 360, "axis": "Z"},
    },
    "patternRect": {
        "summary": "Repeat bodies on a 2D grid.",
        "fields": {"countX": "Num", "countY": "Num", "spacingX": "Num", "spacingY": "Num"},
        "example": {"id": "pr1", "type": "patternRect", "countX": 3, "countY": 2,
                    "spacingX": 20, "spacingY": 15},
    },

    "import": {
        "summary": "A body read from a geometry file. Use the `doc_import` TOOL, "
                   "never feature_add: `geom` is a content hash in the blob store, "
                   "and only the import itself can put the geometry there, so a "
                   "hand-written one names a blob that does not exist.",
        "fields": {"format": '"stl" | "3mf" | "step" | "obj" | "brep" | "glb"',
                   "name": "label", "geom": "content hash in the document blob store",
                   "source": "the file it was read from, for reference",
                   "solid": "Bool, false means a surface body that cannot be cut"},
        "example": None,
        "notes": "The tool takes `path` when the file is one this machine can "
                 "open, or `content` (the file itself, base64, with `name`) when "
                 "you are holding the file and your host will not give you a "
                 "path to it. A text format can go as it is with encoding "
                 '"text". Inline, gzip it first: STEP is text and shrinks about '
                 "tenfold, which is the difference between one message and ten. "
                 "Still too big? Encode the WHOLE file once, split the text that "
                 "comes out, and send the pieces with `part` and `parts`, "
                 "quoting the `upload` id the first reply gives back. Do not "
                 "encode each piece separately, the halves of a base64 string "
                 "join back up and separately encoded pieces do not. Remember "
                 "that content is written by YOU: every piece is a message of "
                 "your own output, so past a handful of pieces the answer is to "
                 "ask for a path rather than to keep typing. "
                 "An imported body is ordinary geometry once it is in: "
                 "`inspect` gives its faces and edges with selectors, and it can be cut, "
                 "filleted and measured against like anything else. `solid: false` "
                 "means the file did not close into a watertight solid, so a "
                 "boolean against it will disappoint: say so rather than press on.",
    },
}

#: The sketch curve vocabulary. All coordinates are 2D, IN THE SKETCH PLANE.
SKETCH_ENTITIES = {
    "line": {"x1": "Num", "y1": "Num", "x2": "Num", "y2": "Num"},
    "circle": {"radius": "Num", "x": "Num (default 0)", "y": "Num (default 0)"},
    "arc": {"x1": "Num", "y1": "Num", "x2": "Num", "y2": "Num",
            "mx": "Num, a point ON the arc between the ends", "my": "Num"},
    "rectangle": {"width": "Num", "height": "Num", "x": "Num centre", "y": "Num centre",
                  "angle": "Num, degrees"},
    "polygon": {"x": "Num centre", "y": "Num centre", "radius": "Num",
                "sides": "Num", "angle": "Num, degrees"},
    "slot": {"x1": "Num", "y1": "Num", "x2": "Num", "y2": "Num", "width": "Num"},
    "spline": {"points": "[{x, y}, ...]"},
    "point": {"x": "Num", "y": "Num"},
    "text": {"text": "string", "height": "Num", "x": "Num", "y": "Num"},
}

#: Every entity type may also carry `id` (a string, unique within the sketch) and
#: `construction: true` (drawn but not part of any profile).
SKETCH_NOTES = (
    "Every entity may carry an `id` (unique within the sketch) and "
    "`construction: true`, which draws it without letting it bound a profile.\n"
    "A profile that will be extruded or revolved must be CLOSED: consecutive "
    "endpoints must be numerically identical, not merely close.\n"
    "A sketch drawn on XZ has its 2D x along world X and its 2D y along world Z."
)

HOW_TO = """\
Working order that avoids most dead ends:

1. `param_set` the driving dimensions FIRST, then write features that reference
   them by name. Retrofitting parameters means rewriting every feature.
2. `feature_add` a few features, then `build`. Build often: an error names the
   feature that caused it, and one at a time is far easier to place than six.
3. `inspect` after a build to learn the body ids, the face and edge lists, and
   the ready-made selectors. Never guess a selector.
4. `view` to look at it. Numbers say a hole is 8mm across; only the picture says
   it is in the wrong place.
5. `doc_save` to a .funda file, which the app opens directly.

Asked to fit something to a part that exists as a file (STEP, STL, 3MF, OBJ,
BREP, GLB)? `doc_import` it first, then `build` and `inspect` it: that gives the
real sizes and the selectors for its faces and edges, which is what makes the
next feature something other than a guess. Import once and keep the document, a
large STEP is minutes of reading. If the file was given to you rather than left
on this machine, send it as `content` and skip looking for a path that is not
there: gzipped, and in pieces if it is still too big for one message.

If it is too big for even that, the answer is never to model against a
simplified stand-in you made up. A part fitted to an approximation of the
reference is wrong in a way nothing downstream can detect, because every
measurement you take afterwards agrees with every other one. Ask instead. The
person you are working with is at the machine FundaCAD is running on: they can
give you the file's path there, or open it themselves with File, Import Mesh,
after which it is in the document and `inspect` measures the real thing. Saying
"I cannot reach this file, what is its path on your machine?" costs one message
and gets the actual part.

Things that are true here and not in every CAD:
 - Z is up. A sketch on XY is a floor plan; a sketch on XZ is a side elevation.
 - box, cylinder and sphere are CENTRED ON THE ORIGIN. Use `move` to place them.
 - Body ids (body1, body2, ...) are assigned in creation order at build time and
   are NOT feature ids. Read them from `build` or `inspect`.
 - A feature can only reference features ABOVE it in the timeline.
"""


def describe_feature(kind):
    """The reference entry for one type, or None."""
    return FEATURES.get(kind)


def schema_text(kind=None):
    """The whole reference, or one type's entry, as text.

    Text rather than JSON deliberately: this is read by a language model, and
    the notes are the part that saves it a failed build."""
    import json

    if kind and kind in FEATURES:
        e = FEATURES[kind]
        out = [f"## {kind}\n{e['summary']}\n", "Fields:"]
        for k, v in e["fields"].items():
            out.append(f"  {k}: {v}")
        if e.get("example"):
            out.append("\nExample:\n" + json.dumps(e["example"], indent=2))
        if e.get("notes"):
            out.append("\nNotes: " + e["notes"])
        return "\n".join(out)
    if kind:
        return f"No feature type {kind!r}. Known types: {', '.join(sorted(FEATURES))}"

    out = ["# FundaCAD document schema\n", HOW_TO, "\n## Shared types\n"]
    for k, v in COMMON.items():
        out.append(f"{k}: {v}\n")
    out.append("\n## Feature types\n")
    for k in sorted(FEATURES):
        out.append(f"- {k}: {FEATURES[k]['summary']}")
    out.append("\nCall schema(type) for the fields, an example and the notes of one type.\n")
    out.append("\n## Sketch entities\n")
    for k, v in SKETCH_ENTITIES.items():
        out.append(f"- {k}: " + ", ".join(f"{a} ({b})" for a, b in v.items()))
    out.append("\n" + SKETCH_NOTES)
    return "\n".join(out)
