"""What a document means when it names a plane.

Three ways to say it — a base plane id, a datum feature's id, or a baked
{origin, normal, xdir} — and one function that turns any of them into a
build123d Plane. Split out of builder.py so the sketch builder can resolve a
plane without importing the whole rebuild.
"""

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import Axis, Keep, Plane, Vector

PLANES = {"XY": Plane.XY, "XZ": Plane.XZ, "YZ": Plane.YZ}
AXES = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}
KEEP = {"top": Keep.TOP, "bottom": Keep.BOTTOM, "both": Keep.BOTH}


def _sketch_plane_ref(f):
    """A sketch's plane reference, preferring a by-id datum link over the baked
    placement. Follows the `split` precedent: a datum id lives in its OWN
    `planeId` field rather than being smuggled into `plane`, so `plane` stays a
    valid PlaneSpec for every existing reader (and stays populated as a cache, so
    the frontend can place the sketch without resolving the datum first).

    This is what makes an offset plane stay editable: edit the datum's offset and
    the sketch follows, instead of the distance being baked into `plane.origin`."""
    return f.get("planeId") or f["plane"]


def _plane_of(spec, datums=None):
    """Resolve a plane reference to a build123d Plane.

    `spec` is one of: a base plane id ("XY"/"XZ"/"YZ"); a datum-plane feature id
    (registered in `datums` by a `datumPlane` feature); or a derived plane
    descriptor {origin, normal, xdir} from a face / offset / construction tool."""
    if isinstance(spec, str):
        if datums and spec in datums:
            return _plane_of(datums[spec], datums)
        if spec in PLANES:
            return PLANES[spec]
        raise ValueError(f"unknown plane reference: {spec}")
    return Plane(
        origin=Vector(*spec["origin"]),
        x_dir=Vector(*spec["xdir"]),
        z_dir=Vector(*spec["normal"]),
    )
