"""Write tools/corpus_texture.json and the heightmap images it reads.

The surface texture plugin's documents for diff_engines.py (volume, bbox, errors)
and diff_meshes.py (triangles, vertices, surface, normals, etags, the export),
drawn from plugins/FundaCAD.Texture/geometry/tests: every kind on a plane, the
lattice kinds on cylinders and cones where the seam matters, freeform faces under
each projection, every spec control, downstream edits, several bodies, and the
refusals. Image paths are relative to sidecar/, which both engines run in.

Run from sidecar/ with the sidecar venv: python tools/gen_texture_corpus.py
"""

import json
import math
import os

from PIL import Image

TOOLS = os.path.dirname(os.path.abspath(__file__))
IMAGES = os.path.join(TOOLS, "corpus", "texture")

KINDS = ["knurl", "hex", "waves", "ribs", "voronoi", "noise", "stripes", "grid", "dots", "brick",
         "basket", "carbon", "isogrid", "grip", "leather"]
TOP = {"kind": "face", "by": "normal", "dir": [0, 0, 1]}


def images():
    os.makedirs(IMAGES, exist_ok=True)
    w, h = 48, 32
    grey = Image.new("L", (w, h))
    rgb = Image.new("RGB", (w, h))
    for y in range(h):
        for x in range(w):
            r = math.hypot(x - 20, y - 14)
            v = int(127 + 120 * math.cos(r / 3.0))
            grey.putpixel((x, y), v)
            rgb.putpixel((x, y), (v, (x * 5) % 256, (y * 7) % 256))
    grey.save(os.path.join(IMAGES, "rings_l.png"))
    rgb.save(os.path.join(IMAGES, "rings_rgb.png"))
    rgb.convert("RGBA").save(os.path.join(IMAGES, "rings_rgba.png"))
    rgb.save(os.path.join(IMAGES, "rings.bmp"))
    rgb.quantize(16).save(os.path.join(IMAGES, "rings_palette.png"))


def plate(w=20, d=20, h=5, x=0, y=0, idx=1, op="new"):
    return [
        {"id": f"s{idx}", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": w, "height": d, "x": x, "y": y}]},
        {"id": f"e{idx}", "type": "extrude", "sketch": f"s{idx}", "distance": h, "operation": op},
    ]


def tex(**kw):
    return dict({"id": "t", "type": "texture"}, **kw)


def doc(name, features, **extra):
    return dict({"name": name, "document": {"parameters": {}, "features": features}}, **extra)


def corpus():
    out = []
    out.append(doc("knurl_plate_all", plate() + [tex(kind="knurl", faces={"by": "all"}, depth=0.4, scale=2.0)]))
    out.append(doc("ribs_plate_top", plate() + [tex(kind="ribs", faces=TOP, depth=0.3, scale=2.0)]))
    out.append(doc("noise_dense_all", plate(10, 10, 5) + [
        tex(kind="noise", faces={"by": "all"}, depth=0.2, scale=0.3, seed=1)]))
    box = {"id": "b", "type": "box", "length": 20, "width": 20, "height": 10}
    for kind in KINDS:
        out.append(doc(f"{kind}_facet_top", [box, tex(kind=kind, faces=TOP, depth=0.3, scale=2.0, seed=3)]))
    for kind in ("knurl", "hex", "waves", "ribs", "noise", "dots", "grid", "voronoi", "brick"):
        out.append(doc(f"{kind}_round_top", [box, tex(kind=kind, faces=TOP, depth=0.3, scale=2.0, seed=3,
                                                     profile="round", sharpness=0.7)]))
    out.append(doc("knurl_45_split_creases", [{"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
                                              tex(kind="knurl", faces=TOP, depth=0.4, scale=2.0, angle=45)]))
    out.append(doc("knurl_30_long_ring", [{"id": "b", "type": "box", "length": 40, "width": 40, "height": 10},
                                          tex(kind="knurl", faces=TOP, depth=0.4, scale=2.0, angle=30)]))
    out.append(doc("ribs_17deg", [box, tex(kind="ribs", faces=TOP, depth=0.3, scale=1.5, angle=17)]))
    out.append(doc("waves_60deg_offset", [box, tex(kind="waves", faces=TOP, depth=0.3, scale=2.5, angle=60,
                                                    offset=0.317)]))
    out.append(doc("ribs_in", [box, tex(kind="ribs", faces=TOP, depth=0.3, scale=2.0, direction="in")]))
    out.append(doc("knurl_both_inverted", [box, tex(kind="knurl", faces=TOP, depth=0.3, scale=2.0,
                                                     direction="both", invert=True)]))
    out.append(doc("knurl_inset", [box, tex(kind="knurl", faces=TOP, depth=0.4, scale=2.0, boundaryInset=1.5)]))
    out.append(doc("knurl_sharp_0", [box, tex(kind="knurl", faces=TOP, depth=0.4, scale=2.0, sharpness=0.0)]))
    out.append(doc("knurl_sharp_095", [box, tex(kind="knurl", faces=TOP, depth=0.4, scale=2.0, sharpness=0.95)]))
    out.append(doc("hex_sharp_1", [box, tex(kind="hex", faces=TOP, depth=0.4, scale=3.0, sharpness=1.0)]))
    grime_box = {"id": "b", "type": "box", "length": 40, "width": 40, "height": 20}
    out.append(doc("knurl_grime", [grime_box, tex(kind="knurl", faces=TOP, depth=0.7, scale=3.0, grime=0.6)]))
    out.append(doc("knurl_grime_zero", [grime_box, tex(kind="knurl", faces=TOP, depth=0.7, scale=3.0, grime=0)]))
    out.append(doc("ribs_smooth", [{"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
                                   tex(kind="ribs", faces=TOP, depth=0.5, scale=2.0, smooth=1.0)]))
    out.append(doc("hex_smooth_half", [box, tex(kind="hex", faces=TOP, depth=0.4, scale=3.0, smooth=0.5)]))
    out.append(doc("ribs_amplitude", [{"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
                                      tex(kind="ribs", faces=TOP, depth=0.6, scale=2.0, amplitude=0.5)]))
    out.append(doc("knurl_slope_masked_top", [box, tex(kind="knurl", faces=TOP, depth=0.4, scale=2.0,
                                                        slopeMin=60.0, slopeMax=120.0)]))
    out.append(doc("knurl_slope_walls", [box, tex(kind="knurl", faces={"by": "all"}, depth=0.4, scale=2.0,
                                                   slopeMin=45.0, slopeMax=135.0)]))
    out.append(doc("noise_target_edge", [{"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
                                         tex(kind="noise", faces=TOP, depth=0.4, scale=2.0, seed=3, targetEdge=0.9)]))
    out.append(doc("noise_tri_budget", [{"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
                                        tex(kind="noise", faces=TOP, depth=0.4, scale=2.0, seed=3, triBudget=3000)]))
    out.append(doc("knurl_color_slot", [box, tex(kind="knurl", faces=TOP, depth=0.4, scale=2.0, colorSlot=2)]))
    out.append(doc("knurl_then_fillet", plate(20, 20, 10) + [
        tex(kind="knurl", faces=TOP, depth=0.3, scale=2.0),
        {"id": "fl", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 1}]))
    holed = plate(30, 30, 6) + [
        {"id": "sh", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "radius": 5, "x": 4, "y": -3}]},
        {"id": "eh", "type": "extrude", "sketch": "sh", "distance": 20, "symmetric": True, "operation": "cut"}]
    out.append(doc("knurl_top_with_hole", holed + [tex(kind="knurl", faces=TOP, depth=0.3, scale=2.0, angle=20)]))
    out.append(doc("hex_top_with_hole", holed + [tex(kind="hex", faces=TOP, depth=0.3, scale=2.5)]))
    two = plate(20, 20, 5, x=0, idx=1) + plate(20, 20, 5, x=100, idx=2)
    out.append(doc("two_bodies_bound", two + [tex(kind="knurl", depth=0.4, scale=2.0, body="body1",
                                                    faces={"kind": "face", "by": "nearest", "point": [0, 0, 5]})]))
    out.append(doc("two_bodies_ambiguous", two + [tex(kind="knurl", depth=0.4, scale=2.0,
                                                        faces={"kind": "face", "by": "nearest", "point": [0, 0, 5]})],
                   expectError=True))
    cyl = {"id": "c", "type": "cylinder", "radius": 10, "height": 20}
    side = {"kind": "face", "by": "nearest", "point": [10, 0, 0]}
    out.append(doc("knurl_cylinder_all", [cyl, tex(kind="knurl", faces={"by": "all"}, depth=0.4, scale=2.0)]))
    out.append(doc("ribs_cylinder_side", [cyl, tex(kind="ribs", faces=side, depth=0.4, scale=2.0)]))
    out.append(doc("ribs_cylinder_90", [cyl, tex(kind="ribs", faces=side, depth=0.4, scale=2.0, angle=90)]))
    out.append(doc("waves_cylinder_30", [cyl, tex(kind="waves", faces=side, depth=0.4, scale=2.0, angle=30)]))
    out.append(doc("hex_cylinder_side", [cyl, tex(kind="hex", faces=side, depth=0.4, scale=2.0)]))
    out.append(doc("voronoi_cylinder_side", [cyl, tex(kind="voronoi", faces=side, depth=0.4, scale=2.0, seed=5)]))
    out.append(doc("hex_cylinder_small", [{"id": "c", "type": "cylinder", "radius": 4, "height": 12},
                                          tex(kind="hex", faces={"kind": "face", "by": "nearest", "point": [4, 0, 0]},
                                              depth=0.3, scale=1.5, sharpness=0.2)]))
    cone = {"id": "k", "type": "cone", "bottomRadius": 15, "topRadius": 10, "height": 18}
    cside = {"kind": "face", "by": "nearest", "point": [12.5, 0, 0]}
    out.append(doc("knurl_cone_side", [cone, tex(kind="knurl", faces=cside, depth=0.4, scale=2.0)]))
    out.append(doc("hex_cone_side", [cone, tex(kind="hex", faces=cside, depth=0.4, scale=2.5)]))
    out.append(doc("ribs_cone_side", [cone, tex(kind="ribs", faces=cside, depth=0.3, scale=2.0, angle=10)]))
    sphere = {"id": "s", "type": "sphere", "radius": 10}
    out.append(doc("noise_sphere", [sphere, tex(kind="noise", faces={"by": "all"}, depth=0.3, scale=2.0, seed=2)]))
    out.append(doc("knurl_sphere_auto", [sphere, tex(kind="knurl", faces={"by": "all"}, depth=0.3, scale=2.0,
                                                      projection="auto")]))
    corner = [{"id": "b", "type": "box", "length": 40, "width": 40, "height": 40},
              {"id": "fx", "type": "fillet", "radius": 10, "edges": [
                  {"kind": "edge", "by": "nearest", "point": [0, 20, 20]},
                  {"kind": "edge", "by": "nearest", "point": [20, 0, 20]},
                  {"kind": "edge", "by": "nearest", "point": [20, 20, 0]}]}]
    cpick = {"by": "nearest", "point": [15, 15, 15]}
    out.append(doc("knurl_corner_auto", corner + [tex(kind="knurl", depth=0.8, scale=3.0, projection="auto",
                                                       faces=cpick)]))
    out.append(doc("knurl_corner_triplanar", corner + [tex(kind="knurl", depth=0.6, scale=3.0, faces=cpick)]))
    out.append(doc("knurl_corner_box", corner + [tex(kind="knurl", depth=0.6, scale=3.0, faces=cpick,
                                                      projection="box", seamBand=0.2)]))
    out.append(doc("hex_corner_blend", corner + [tex(kind="hex", depth=0.6, scale=3.0, faces=cpick, seamBlend=0.8)]))
    out.append(doc("grid_fillet_edge", corner + [tex(kind="grid", depth=0.5, scale=3.0,
                                                      faces={"by": "nearest", "point": [18, 0, 18]})]))
    for name in ("rings_l.png", "rings_rgb.png", "rings_rgba.png", "rings.bmp", "rings_palette.png"):
        out.append(doc("image_" + name.replace(".", "_"), [box, tex(
            kind="image", faces=TOP, depth=0.5, scale=2.0, imagePath=f"tools/corpus/texture/{name}")]))
    out.append(doc("image_round_on_cylinder", [cyl, tex(kind="image", faces=side, depth=0.5, scale=2.0,
                                                          profile="round", imagePath="tools/corpus/texture/rings_l.png")]))
    out.append(doc("image_missing", plate(10, 10, 5) + [tex(kind="image", faces={"by": "all"}, depth=0.3, scale=2.0,
                                                             imagePath="/nonexistent/path/does-not-exist.png")],
                   expectError=True))
    out.append(doc("image_not_an_image", plate(10, 10, 5) + [tex(kind="image", faces={"by": "all"}, depth=0.3,
                                                                  scale=2.0, imagePath="tools/gen_texture_corpus.py")],
                   expectError=True))
    out.append(doc("refused_kind", [box, tex(kind="glitter", faces=TOP)], expectError=True))
    out.append(doc("refused_depth", [box, tex(kind="knurl", faces=TOP, depth=-1)], expectError=True))
    out.append(doc("refused_direction", [box, tex(kind="waves", faces=TOP, direction="sideways")], expectError=True))
    out.append(doc("refused_projection", [box, tex(kind="knurl", faces=TOP, projection="cubic")], expectError=True))
    out.append(doc("refused_grime_bool", [box, tex(kind="knurl", faces=TOP, grime=True)], expectError=True))
    out.append(doc("refused_angle_text", [box, tex(kind="knurl", faces=TOP, angle="steep")], expectError=True))
    out.append(doc("no_face_found", [box, tex(kind="knurl", faces={"kind": "face", "by": "normal",
                                                                   "dir": [0.577, 0.577, 0.577]})], expectError=True))
    return out


def main():
    images()
    docs = corpus()
    with open(os.path.join(TOOLS, "corpus_texture.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump({"about": __doc__.split("\n\n")[0] + " Written by tools/gen_texture_corpus.py.",
                   "documents": docs}, fh, indent=1)
    print(len(docs), "documents")


if __name__ == "__main__":
    main()
