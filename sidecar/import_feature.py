"""The import feature: embedded geometry blobs and the assembly tree bound to them."""

import sys
import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py
from booleans import _skip_feature
from progress import progress_tick
from shape_util import _brep_b64_to_shape, _explode_solids, _wrap_topods


def _blob_top_children(shape):
    """The blob's top-level children, in stored order. Deliberately NOT
    `.solids()`: the manifest binds row i to child i, and a leaf product with no
    solid (the ones dropped silently today) has to keep its slot."""
    from OCP.TopoDS import TopoDS_Iterator

    out = []
    it = TopoDS_Iterator(shape.wrapped)
    while it.More():
        out.append(it.Value())
        it.Next()
    return out


def _bind_assembly(f, ctx, shape, nodes, parts):
    """Name the blob's children from the assembly manifest. Returns False, having
    recorded WHY, if the manifest and the geometry disagree, the caller then
    falls back to the historical unnamed explode. A wrong tree is worse than no
    tree: every body would still build, just labelled as the wrong part."""
    children = _blob_top_children(shape)
    if len(children) != len(parts):
        _skip_feature(
            ctx.diagnostics, f, "import",
            f"assembly manifest lists {len(parts)} parts but the stored geometry "
            f"has {len(children)} top-level shapes, falling back to unnamed bodies",
        )
        return False

    wrapped = []
    for i, (child, part) in enumerate(zip(children, parts)):
        # One tick per leaf. A single import feature rebuilding a large assembly
        # was the longest SILENT phase left in the product: measured 90 s
        # emitting one tick, against a 60 s stall budget. Wave 1.1 ticked export,
        # the interference sweep and checkpoint writes and missed this one.
        progress_tick()
        w = _wrap_topods(child)
        node_index = part.get("node") if isinstance(part, dict) else None
        if w is None or not isinstance(node_index, int) or not 0 <= node_index < len(nodes):
            _skip_feature(
                ctx.diagnostics, f, "import",
                f"assembly manifest entry {i} does not refer to a known part "
                f", falling back to unnamed bodies",
            )
            return False
        # Face count is the checksum that turns an ordinal reference into a
        # CHECKED one. Without it a reordered or re-generated blob would bind
        # silently, and the only symptom would be parts wearing each other's names.
        expected_faces = part.get("faces")
        if expected_faces is not None and len(w.faces()) != expected_faces:
            _skip_feature(
                ctx.diagnostics, f, "import",
                f"assembly part {i} expected {expected_faces} faces but the stored "
                f"geometry has {len(w.faces())}, falling back to unnamed bodies",
            )
            return False
        wrapped.append((w, node_index, part.get("faceColors"), part.get("color")))

    # A product owning several solids numbers them; one owning a single solid
    # keeps its bare name. Same convention the anonymous path already used.
    owned = {}
    for _w, node_index, _colors, _color in wrapped:
        owned[node_index] = owned.get(node_index, 0) + 1

    base = f.get("name") or "Imported"
    feature_id = f.get("id")
    seen = {}
    for w, node_index, colors, color in wrapped:
        label = (nodes[node_index] or {}).get("name") or base
        if owned[node_index] > 1:
            seen[node_index] = seen.get(node_index, 0) + 1
            label = f"{label} {seen[node_index]}"
        ctx.new_body(w, label, node_ref=f"{feature_id}/{node_index}",
                     face_colors=colors, part_color=color)
    return True


_BINTOOLS_MAGIC = b"Open CASCADE Topology V"


def _blob_to_shape(data):
    """A stored binary BREP blob back to a build123d Shape.

    The magic check is NOT redundant with the blob store's hash verification.
    That hash proves the bytes are the ones the container declared, it does not
    prove they are benign, because whoever crafted a hostile `.funda` chose both
    the bytes and the declared hash. So the same reasoning as
    `_brep_b64_to_shape` applies: refuse to aim a parser fuzz at OCCT.

    There is deliberately NO size cap here, unlike the 64 MiB `MAX_BREP_BYTES` on
    the legacy embedded path. That cap is exactly what makes a large assembly
    unopenable, and it is the thing this whole change exists to remove. The bound
    that replaces it is upstream: the container reader refuses an archive that
    declares more than 8 GiB before inflating a byte."""
    import geomstore

    if not data[: len(_BINTOOLS_MAGIC) + 2].lstrip(b"\n\r ").startswith(_BINTOOLS_MAGIC):
        raise ValueError("stored geometry is not a valid binary BREP (bad header)")
    # _wrap_topods, not Shape.cast: BinTools hands back a raw TopoDS, and for an
    # assembly that is a COMPOUND, which Shape.cast() turns into None (see its
    # docstring). Same trap the XCAF reader hit.
    shape = _wrap_topods(geomstore.deserialize_shape(data))
    if shape is None:
        raise ValueError("stored geometry decoded to an empty shape")
    return shape


def _import_shape(f):
    """The geometry for an import feature.

    Prefers the content hash (`geom`) and falls back to the legacy embedded
    base64 (`brep`). Both fields are present during the transition, so a blob
    that has gone missing, a wiped app-data directory, a document copied
    without its container, still rebuilds from the embedded copy rather than
    failing. Once `brep` is gone that fallback disappears and the missing-blob
    error below becomes the live path."""
    import blobstore

    digest = f.get("geom")
    b64 = f.get("brep")
    if digest:
        data = blobstore.default_store().get_bytes(digest)
        if data is not None:
            return _blob_to_shape(data)
        if not b64:
            raise ValueError(
                "the geometry for this imported body is missing from local storage. "
                "Open the .funda file it was saved in, or re-import the original file."
            )
        # Fall through to the embedded copy, loudly: a miss here means either a
        # wiped store or a document that travelled without its container, and
        # both are worth seeing in the log rather than silently absorbing.
        print(f"[blobstore] blob {digest} missing; falling back to the embedded BREP",
              file=sys.stderr, flush=True)
    if not b64:
        raise ValueError("this imported body has no geometry attached")
    return _brep_b64_to_shape(b64)


def _assembly_root_index(nodes):
    """Index of the assembly's root product (the node with no parent), or None.
    First one wins: a well-formed tree has exactly one."""
    if not nodes:
        return None
    for i, n in enumerate(nodes):
        if isinstance(n, dict) and n.get("parent") is None:
            return i
    return None


def _handle_import(f, ctx):
    base = f.get("name") or "Imported"
    shape = _import_shape(f)
    nodes, parts = f.get("nodes"), f.get("parts")
    # explode:false keeps a multi-solid payload as ONE body. For imported
    # assemblies with hundreds of import features this divides body count
    # (browser tree entries, per-body payloads, draw calls) by the average
    # solids-per-import. Default (absent/true) keeps the historical
    # one-body-per-solid behavior. It is checked FIRST because it is an explicit
    # instruction to collapse, which a manifest cannot override.
    if f.get("explode") is False:
        # ...but collapsing the GEOMETRY must not throw away the TREE. This used
        # to return here with a body named "Imported" and no node_ref at all, so
        # the whole assembly hierarchy, product names, structure, colours,
        # was discarded by the one flag a user would reach for on exactly the
        # documents where that hierarchy matters most.
        #
        # One body can only honestly claim one node, so it claims the ROOT: the
        # body carries the assembly's own name and sits under it in the Browser,
        # instead of appearing as an anonymous loose body.
        root = _assembly_root_index(nodes)
        if root is not None:
            label = (nodes[root] or {}).get("name") or base
            body = ctx.new_body(shape, label, node_ref=f"{f.get('id')}/{root}")
        else:
            body = ctx.new_body(shape, base)
        # Exempt from _drop_debris. That pass deletes any solid under 0.1% of
        # the biggest one that does not touch it, on the theory that it is
        # residue from the booleans that carved the body. An explicitly
        # collapsed import is the opposite case: every solid in it is a part
        # the user's file declared, and small ones that float clear of the
        # largest are the NORM in an assembly, not debris.
        #
        # Measured on asm_nested: main body 3200 mm3, and four legitimate parts
        # at 3.0 mm3 each, 0.094%, just under the threshold, were silently
        # deleted, taking 4 of 7 parts and 24 of 42 faces with them. It never
        # showed up before because the exploded path gives each body ONE solid,
        # and the pass returns early below two.
        body["_intact"] = True
        return
    # Assembly manifest, when the import recorded one. Absent for every import
    # made before this existed and for every non-assembly file, which is what
    # keeps those documents rebuilding exactly as they did.
    if nodes and parts and _bind_assembly(f, ctx, shape, nodes, parts):
        return
    parts = _explode_solids(shape)
    if len(parts) == 1:
        ctx.new_body(parts[0], base)
    else:
        for part_no, p in enumerate(parts, 1):
            ctx.new_body(p, f"{base} {part_no}")
