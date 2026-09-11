"""A machine-readable error vocabulary for the geometry wire protocol.

A build failure reaches the frontend as a human message plus, when the failure
falls into a category the UI can act on, a stable `code`. The frontend branches
on the code (offer a re-pick, point at the missing reference) instead of pattern
matching on prose, which changes whenever a message is reworded. The codes are
flat lowerCamel to match the ResolveDiag codes the frontend already reads (see
features/repickReference.ts), so a diagnostic and a hard failure of the same
category carry the SAME code.

`GeomError` is a `ValueError` on purpose. The rebuild loop already treats a
`ValueError` as a hand-authored, user-facing refusal that names its feature and
lets the rest of the timeline keep running (builder.py, the per-feature
try/except). A `GeomError` is caught by that exact arm and, because it also
carries `.code`, threads its category to the wire with no new except clause and
no change to how any other refusal behaves.
"""

# --- reference resolution ----------------------------------------------------
AMBIGUOUS_REFERENCE = "ambiguousReference"  # a selector matched several candidates
REFERENCE_NOT_FOUND = "referenceNotFound"   # a selector matched nothing
PLANE_TILTED = "planeTilted"                # a face is no longer parallel to its saved plane

# --- request shape -----------------------------------------------------------
BAD_REQUEST = "badRequest"                  # a feature is missing or misusing a field
EMPTY_RESULT = "emptyResult"                # the operation ran but produced no solid


class GeomError(ValueError):
    """A user-facing geometry refusal that also carries a machine `code`.

    A plain `ValueError` still works everywhere it did; `GeomError` only ADDS
    the code, which `getattr(ex, "code", None)` reads back at the wire seam.
    """

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code
