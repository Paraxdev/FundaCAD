"""How far apart two surfaces can be and still have been meant as one.

Everything a boolean's tool is built from reached the kernel through the
RENDERED mesh. Sketch on a face and the plane you get is fitted to that face's
triangles (features/facePlanePick.ts -> planeMath.planeFromPickedFace); a
press/pull anchor and an extrude's region point are likewise points on a
triangle. Mesh positions are float32 on the wire, because that is the right
format for something a GPU draws.

So a plane the user drew ON a face does not land on it. In the reported case a
boss end face sat at y = 24.4 and the sketch drawn on it came back at
y = 24.399999618530273 — the float32 neighbour, 3.8e-7 mm short. Cutting from
there gave OCCT two distinct planes where the user meant one: it removed the
right volume, to the microlitre, but left the hole SEALED by a disc lying in
the end face's own plane with a membrane 0.38 nanometres thick between them.
Every check calls that solid valid. On screen the hole reads as filled in and
flickers, because 0.38 nm is four orders of magnitude below what a depth
buffer resolves.

That is not a case to detect and special-case. It is the ordinary consequence
of picking geometry off a picture of it, so the tolerance below says what the
picture could not have told apart:

    a float32 carries about 7 significant digits, so at a coordinate of
    magnitude E the smallest gap it can represent is E * 2**-24. Anything
    under a few of those was one surface before it was drawn.

FLOOR_MM keeps a part sitting near the origin from getting a tolerance of
nearly zero; CEILING_MM keeps an imported assembly measured in metres from
getting one big enough to matter. Between them the value is pure geometry, and
at every size it stays orders of magnitude under any feature anyone models: at
the far end it is one micron.

Kept out of builder.py because that file cannot be imported without a geometry
kernel, and this rule is worth testing without one.
"""

import math

# The relative step of a float32: 24 bits of mantissa, so 5.96e-8.
FLOAT32_ULP = 2.0**-24

# How many of those steps still count as the same place. A plane FITTED to many
# float32 vertices lands well inside one step (the reported case was 0.2 of one),
# but a fit is not a guarantee, and the surfaces either side of this are ones no
# process could hold and no display could separate.
ULPS = 8.0

# 1 nanometre. Below this the model is close enough to the origin that its own
# size stops being the thing that limits the pick.
FLOOR_MM = 1e-6

# 1 micron. Past a part about two metres across the float32 step would keep
# growing; the tolerance stops here instead, well under any real feature.
CEILING_MM = 1e-3


def pick_fuzz(extent_mm):
    """The gap to treat as coincident for geometry picked at `extent_mm`.

    `extent_mm` is how far from the origin the geometry involved reaches — the
    magnitude the float32 step is proportional to, not the size of the feature
    being cut. A 2 mm hole drilled a metre from the origin was picked at metre
    precision and needs the metre's tolerance.
    """
    if extent_mm is None or not math.isfinite(extent_mm) or extent_mm <= 0:
        return FLOOR_MM
    return min(CEILING_MM, max(FLOOR_MM, extent_mm * FLOAT32_ULP * ULPS))
