"""Read a STEP file's XCAF product tree: names, colours, placement.

Why this exists instead of `build123d.import_step`: that function is a fine
geometry reader but it is lossy in two ways that matter for assemblies.

1. It MANGLES names. `get_name` runs `translate(str.maketrans(" .()", "____"))`
   to appease an unrelated viewer, so a product the file calls "M3 Nut (x20)"
   comes back as "M3_Nut__x20_". Since the whole point of keeping the assembly
   tree is showing the user the names their CAD system wrote, that is the one
   thing that cannot be lossy.
2. Its `.children` are NOT world-placed. `Shape.move` mutates only the parent
   compound's TopLoc_Location, so harvesting a leaf's `.wrapped` from a
   `.children` walk yields it in its PARENT's frame. Measured on a depth-3
   fixture: the same subassembly instanced twice 50mm apart produced two leaves
   with identical bounding boxes. Composing locations while walking XCAF avoids
   ever creating that hazard, rather than guarding against it afterwards.

Reading XCAF directly also removes a structural risk. Only the XCAF layer knows
which compounds are assemblies and which are multi-solid products, both are
TopAbs_COMPOUND to OCCT, so any design that reads structure from one tree and
geometry from another has to keep two walks in lockstep. On the reference file
493 of 1,293 leaf products are compounds, i.e. exactly the nodes where such
walks diverge. One walk, one source of truth.

This module owns no geometry operations; it reads and returns shapes.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field


@dataclass
class AssemblyNode:
    """One product in the tree. `parent` indexes into the same node list, or is
    None for a root. `color` is "#rrggbb" or None, read from this label only,
    never inherited from an ancestor."""

    name: str
    parent: int | None
    color: str | None = None


@dataclass
class Assembly:
    """A STEP file's product tree plus its geometry, flattened.

    `leaves` is the ordered list of (node index, world-placed TopoDS_Shape)
    occurrences: one entry per SOLID of a leaf product, so a product holding 20
    solids contributes 20 leaves that all name the same node. A product with no
    solids at all contributes ONE leaf carrying its whole shape, which is how
    products that today vanish silently stay in the document.
    """

    nodes: list[AssemblyNode] = field(default_factory=list)
    leaves: list[tuple[int, object]] = field(default_factory=list)
    #: True when the file carries real assembly structure. When False the caller
    #: should stay on the historical single-shape import path.
    is_assembly: bool = False
    #: The file's free (top-level) shapes, placed. Kept so a non-assembly file
    #: can go down the historical path without paying for a SECOND full read,
    #: on a large single-part STEP that second read would double import time.
    roots: list[object] = field(default_factory=list)
    #: Per-face colours for the leaves that have any: leaf index -> one entry
    #: per face of that leaf, "#rrggbb" or None, in the leaf's own face order.
    #:
    #: Keyed rather than parallel because most leaves have none, and an absent
    #: key has to mean "no colours" rather than "position 7 of a list somebody
    #: forgot to grow". A mechanical CAD system colours faces, not products (see
    #: face_colors.py), so for such a file this is where nearly all the colour
    #: in the document actually is.
    face_colors: dict[int, list] = field(default_factory=dict)

    @property
    def product_count(self) -> int:
        return len(self.nodes)


def _clean(name: str) -> str:
    """Strip Unicode control characters, and nothing else.

    Control characters are removed because they can break rendering and are
    never meaningful in a product name. Spaces, dots and brackets are KEPT,
    losing them is the bug this module exists to avoid.
    """
    return "".join(ch for ch in name if unicodedata.category(ch)[0] != "C").strip()


def _label_name(label) -> str:
    from OCP.TCollection import TCollection_AsciiString
    from OCP.TDataStd import TDataStd_Name

    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        return _clean(TCollection_AsciiString(attr.Get()).ToCString())
    return ""


def _label_color(label) -> str | None:
    """The colour attached to THIS label, as '#rrggbb', or None.

    Deliberately does not fall back to an ancestor's colour: build123d's public
    `.color` getter does, and also caches the answer onto the shape, so it
    reports a parent's colour as the child's own and mutates the tree while you
    walk it.

    OCCT stores colour components linear; '#rrggbb' everywhere else in this
    codebase means sRGB, so convert rather than scaling the raw values (a
    mid-grey would otherwise come out visibly too dark).
    """
    from OCP.Quantity import Quantity_Color, Quantity_ColorRGBA
    from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType

    rgba = Quantity_ColorRGBA()
    for kind in (
        XCAFDoc_ColorType.XCAFDoc_ColorSurf,
        XCAFDoc_ColorType.XCAFDoc_ColorGen,
        XCAFDoc_ColorType.XCAFDoc_ColorCurv,
    ):
        if not XCAFDoc_ColorTool.GetColor_s(label, kind, rgba):
            continue
        linear = rgba.GetRGB()
        to_srgb = Quantity_Color.Convert_LinearRGB_To_sRGB_s  # per component
        return "#{:02x}{:02x}{:02x}".format(
            *(
                max(0, min(255, round(to_srgb(v) * 255)))
                for v in (linear.Red(), linear.Green(), linear.Blue())
            )
        )
    return None


def _shape_color(color_tool, shape) -> str | None:
    """The colour attached to one SHAPE (a face, a solid), as '#rrggbb'.

    The shape-keyed lookup, as against `_label_color`'s label-keyed one. XCAF
    resolves it back to a label internally, and that resolution is sensitive to
    the shape's Location: a face taken from a leaf this module has already
    `.Moved()` into world position does not match the label it came from and
    reads as uncoloured. So every caller here reads colours from the product's
    OWN, unmoved shape and relies on face order to carry the answer across.
    """
    from OCP.Quantity import Quantity_Color, Quantity_ColorRGBA
    from OCP.XCAFDoc import XCAFDoc_ColorType

    rgba = Quantity_ColorRGBA()
    for kind in (
        XCAFDoc_ColorType.XCAFDoc_ColorSurf,
        XCAFDoc_ColorType.XCAFDoc_ColorGen,
        XCAFDoc_ColorType.XCAFDoc_ColorCurv,
    ):
        if not color_tool.GetColor(shape, kind, rgba):
            continue
        linear = rgba.GetRGB()
        to_srgb = Quantity_Color.Convert_LinearRGB_To_sRGB_s  # per component
        return "#{:02x}{:02x}{:02x}".format(
            *(
                max(0, min(255, round(to_srgb(v) * 255)))
                for v in (linear.Red(), linear.Green(), linear.Blue())
            )
        )
    return None


def _faces_of(shape):
    """Every face of a shape, in the order OCCT explores it.

    The SAME order `Shape.faces()` yields downstream and the same order the
    per-face arrays on the wire use, which is the whole reason a colour can be
    carried as a bare positional list rather than as a map keyed by something
    that would have to survive a B-rep round trip.
    """
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def _product_face_colors(color_tool, shape):
    """Per-face colours for a product's own (unmoved) shape, grouped by solid.

    The returned list lines up with `_solids_of(shape)`, or, for a product with
    no solids, holds one entry for the whole shape: exactly the two cases
    `visit` turns into leaves, so the caller never has to re-derive the split.

    None when the product carries no face colour at all, which keeps the
    ordinary uncoloured STEP paying one map lookup per face and storing nothing.
    """
    groups = _solids_of(shape) or [shape]
    out = []
    colored = False
    for g in groups:
        row = []
        for f in _faces_of(g):
            c = _shape_color(color_tool, f)
            if c:
                colored = True
            row.append(c)
        out.append(row)
    return out if colored else None


def _solids_of(shape):
    """Every solid in a shape, each carrying its composed location."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    out = []
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def read_assembly(path: str) -> Assembly:
    """Read `path` and return its product tree with world-placed leaf geometry.

    Uses the same STEPCAFControl_Reader build123d uses, so this costs one read,
    not two, and inherits the same unit and tolerance handling.
    """
    from OCP.IFSelect import IFSelect_ReturnStatus
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TDF import TDF_Label, TDF_LabelSequence, TDF_Tool
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    doc = TDocStd_Document(TCollection_ExtendedString("XCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(True)
    if reader.ReadFile(path) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise ValueError("could not read the STEP file (it may be truncated or not STEP)")
    if not reader.Transfer(doc):
        raise ValueError("the STEP file was read but contained no transferable shape")

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    asm = Assembly()

    # Does this file style anything at all? A STEP with no presentation entities
    # is the common case, and asking it about every face would be a map lookup
    # per face, six figures of them on a large assembly, to learn nothing.
    styled = TDF_LabelSequence()
    color_tool.GetColors(styled)
    reads_faces = styled.Length() > 0
    # Per PRODUCT, not per occurrence. A fastener instanced two hundred times is
    # one walk over its faces; without this the walk is the import.
    face_color_cache: dict[str, object] = {}

    def product_face_colors(referred):
        if not reads_faces:
            return None
        entry = TCollection_AsciiString()
        TDF_Tool.Entry_s(referred, entry)
        key = entry.ToCString()
        if key not in face_color_cache:
            face_color_cache[key] = _product_face_colors(
                color_tool, shape_tool.GetShape_s(referred)
            )
        return face_color_cache[key]

    def resolve(label):
        """A component label points at the product it instances; a free shape is
        its own product. Returns the product (referred) label."""
        if shape_tool.IsReference_s(label):
            referred = TDF_Label()
            shape_tool.GetReferredShape_s(label, referred)
            return referred
        return label

    def visit(label, parent: int | None, location: TopLoc_Location):
        referred = resolve(label)
        # Name: prefer the product's own label. Fall back to the instance label,
        # then to a positional placeholder, an unnamed product must still be
        # addressable rather than collapsing into its neighbour.
        name = _label_name(referred) or _label_name(label)
        # Colour: the per-instance override wins over the product's own, which
        # is the same precedence STEP itself defines.
        color = _label_color(label) or _label_color(referred)
        index = len(asm.nodes)
        asm.nodes.append(
            AssemblyNode(name=name or f"Part {index + 1}", parent=parent, color=color)
        )

        if shape_tool.IsAssembly_s(referred):
            asm.is_assembly = True
            components = TDF_LabelSequence()
            shape_tool.GetComponents_s(referred, components)
            for i in range(components.Length()):
                component = components.Value(i + 1)
                visit(
                    component,
                    index,
                    location * shape_tool.GetLocation_s(component),
                )
            return

        shape = shape_tool.GetShape_s(referred).Moved(location)
        solids = _solids_of(shape)
        # `.Moved()` rewrites the location and nothing else, so the moved shape
        # explores its solids, and each solid its faces, in the very order the
        # product's own shape did. That is what lets a colour read from the
        # unmoved product be handed to the placed leaf by position.
        by_solid = product_face_colors(referred)
        for k, leaf in enumerate(solids or [shape]):
            row = by_solid[k] if by_solid and k < len(by_solid) else None
            if row and any(row):
                asm.face_colors[len(asm.leaves)] = row
            asm.leaves.append((index, leaf))

    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() == 0:
        raise ValueError("the STEP file contains no shapes")
    for i in range(roots.Length()):
        label = roots.Value(i + 1)
        location = TopLoc_Location()
        asm.roots.append(shape_tool.GetShape_s(resolve(label)).Moved(location))
        visit(label, None, location)

    # More products than roots means there is real structure to keep. A single
    # unnested product owning ONE solid is an ordinary part file and stays on the
    # historical flat path, unchanged. But a single product owning SEVERAL solids
    # is a part whose bodies belong together under its name, not spilled loose at
    # the top level: more leaves than nodes means at least one node carries a
    # bunch of solids, so group it too. _bind_assembly then files each solid as a
    # numbered body inside the one folder, and a lone-solid part is untouched
    # because its leaves equal its nodes.
    if len(asm.nodes) > roots.Length() or len(asm.leaves) > len(asm.nodes):
        asm.is_assembly = True
    return asm
