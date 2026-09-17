"""Orca-project 3MF writer: one object per body, per-object extruder (= palette
slot) assignments, palette colors as filament slots.

Why hand-written: build123d's Mesher emits no color, and Orca ignores generic 3MF
color on import anyway, what survives an "open as project" round-trip is the
Bambu/Orca PROJECT layout: per-object `<metadata key="extruder">` rows in
Metadata/model_settings.config plus a filament_colour array in
Metadata/project_settings.config. Objects also carry plain m:basematerials so the
file still renders colored in generic 3MF viewers.

Indexing convention (easy to get wrong): FundaCAD palette slots and the
project_settings filament_colour array are 0-based; the model_settings "extruder"
metadata is 1-based. A body with no palette assignment goes to extruder 1.
"""

import json
import zipfile
from xml.sax.saxutils import quoteattr

from mesh_writers import CONTENT_TYPES, RELS, mesh_chunks, norm_color

# Orca/BambuStudio treat a 3MF as *their* project format when this marker
# metadata is present in the model; without it the file risks the plain-3MF
# import path, which drops extruder assignments.
_BBS_NS = "http://schemas.bambulab.com/package/2021"

# Slot cap matches the palette (≤4 U1 toolheads) with headroom; server-side
# validation, not a format limit.
MAX_SLOTS = 8
MAX_NAME = 100


def sanitize_inputs(palette, body_colors, body_names):
    """Clamp untrusted request fields to what the writer expects. Returns
    (palette, body_colors, body_names) with colors normalized, names capped and
    slot indices restricted to the palette range (out-of-range → unassigned)."""
    pal = []
    for slot in list(palette or [])[:MAX_SLOTS]:
        slot = slot if isinstance(slot, dict) else {}
        entry = {
            "name": str(slot.get("name") or f"Filament {len(pal) + 1}")[:MAX_NAME],
            "color": norm_color(slot.get("color")),
        }
        material = str(slot.get("material") or "").strip()[:MAX_NAME]
        if material:
            entry["material"] = material
        pal.append(entry)
    colors = {}
    for bid, idx in dict(body_colors or {}).items():
        try:
            idx = int(idx)
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(pal):
            colors[str(bid)] = idx
    names = {str(k): str(v)[:MAX_NAME] for k, v in dict(body_names or {}).items()}
    return pal, colors, names


def _bbox(bodies):
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for b in bodies:
        pos = b["positions"]
        for i in range(0, len(pos), 3):
            for a in range(3):
                v = pos[i + a]
                if v < lo[a]:
                    lo[a] = v
                if v > hi[a]:
                    hi[a] = v
    return lo, hi


def write_project_3mf(bodies, path, palette, body_colors, body_names, settings,
                      bed=(270.0, 270.0)):
    """Write an Orca-project 3MF. Returns `path`.

    bodies      : [{"id", "name", "positions", "indices"}], flat mm/Z-up lists
                  straight from tessellate() (face_ids unused here)
    palette     : [{"name", "color"}] 0-based slots (sanitize_inputs first)
    body_colors : {body id → slot index}; missing → slot 0 (extruder 1)
    body_names  : {body id → display name} (sidebar renames win over b["name"])
    settings    : dict merged into project_settings.config; caller-provided keys
                  win, filament_colour is derived from the palette when absent
    bed         : (x, y) mm, the assembly is centered on it, z-min dropped to 0
    """
    if not bodies:
        raise ValueError("nothing to export, no bodies")

    # One SHARED translation for all build items: relative body positions are an
    # assembly and must survive; only the group as a whole moves onto the plate.
    lo, hi = _bbox(bodies)
    tx = bed[0] / 2 - (lo[0] + hi[0]) / 2
    ty = bed[1] / 2 - (lo[1] + hi[1]) / 2
    tz = -lo[2]
    transform = f"1 0 0 0 1 0 0 0 1 {tx:.6g} {ty:.6g} {tz:.6g}"

    mats = "".join(
        f'<m:base name={quoteattr(s["name"])} displaycolor="{s["color"]}FF"/>'
        for s in palette
    )
    basematerials = f'<m:basematerials id="1">{mats}</m:basematerials>' if palette else ""

    objects_meta, items_xml, cfg_objects = [], [], []
    for n, b in enumerate(bodies):
        oid = n + 2  # id 1 = the basematerials resource
        slot = body_colors.get(str(b["id"]), 0) if palette else 0
        name = body_names.get(str(b["id"])) or b.get("name") or f"Body{n + 1}"
        name = name[:MAX_NAME]
        pid = f' pid="1" pindex="{slot}"' if palette else ""
        # Header only. The MESH is streamed later, straight into the zip, so it
        # is never held here alongside every other body's.
        objects_meta.append((b, f'<object id="{oid}" type="model" name={quoteattr(name)}{pid}>'))
        items_xml.append(f'<item objectid="{oid}" transform="{transform}" printable="1"/>')
        cfg_objects.append(
            f'  <object id="{oid}">\n'
            f"    <metadata key=\"name\" value={quoteattr(name)}/>\n"
            f'    <metadata key="extruder" value="{slot + 1}"/>\n'
            f'    <part id="1" subtype="normal_part">\n'
            f"      <metadata key=\"name\" value={quoteattr(name)}/>\n"
            f"    </part>\n"
            f"  </object>"
        )

    def _model_chunks():
        """The 3dmodel.model document, in bounded pieces."""
        yield (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<model unit="millimeter" xml:lang="en-US"'
            ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
            ' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"'
            f' xmlns:BambuStudio="{_BBS_NS}">\n'
            ' <metadata name="Application">FundaCAD</metadata>\n'
            ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
            f" <resources>{basematerials}"
        )
        for b, header in objects_meta:
            yield header
            yield from mesh_chunks(b["positions"], b["indices"])
            yield "</object>"
        yield f"</resources>\n <build>{''.join(items_xml)}</build>\n</model>"

    model_settings = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<config>\n" + "\n".join(cfg_objects) + "\n</config>"
    )

    # filament_colour length defines how many filament slots Orca shows; keep it
    # exactly the palette. Caller settings (e.g. a fully flattened profile in the
    # CLI path) override anything we derive here.
    proj = {"filament_colour": [s["color"] for s in palette]} if palette else {}
    # filament_type parallels filament_colour when the palette knows materials
    # (printer-synced slots carry them). Slots without one fall back to PLA,
    # Orca's own default for an unconfigured slot.
    if palette and any(s.get("material") for s in palette):
        proj["filament_type"] = [s.get("material") or "PLA" for s in palette]
    proj.update(settings or {})

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        # Streamed, not writestr'd: the mesh XML for a large assembly is far
        # bigger than the mesh, and writestr would need all of it in memory at
        # once on top of the meshes themselves.
        with z.open("3D/3dmodel.model", "w") as fh:
            for chunk in _model_chunks():
                fh.write(chunk.encode("utf-8"))
        z.writestr("Metadata/model_settings.config", model_settings)
        z.writestr("Metadata/project_settings.config", json.dumps(proj, indent=1))
    return path
