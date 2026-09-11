"""What this plugin adds to the geometry engine.

The sidecar imports this file when the plugin is installed (see
sidecar/plugin_geometry.py) and calls `register`. Nothing in the application
names a texture; everything that knows what one is, is in this directory.

TWO REGISTRATIONS, because a texture happens at two different times.

The FEATURE HANDLER runs during the rebuild, in timeline order, and it
deliberately does almost nothing: it validates the values so that a bad kind or
an unreadable image turns the row red immediately, and it stashes the spec on
the body. It does NOT displace anything. Displacement against the shape as it
stands mid-timeline would be undone by the next boolean, and a texture applied
before a fillet would vanish into it.

The MESH PASS runs at tessellation, against the FINAL shape, which is why a
texture survives everything applied after it. It resolves its stored selector
then, the same lossy-tolerant way every other selector feature does, so a face
that was split downstream still carries the pattern.

`_handle_texture` used to be in sidecar/builder.py and `"texture"` used to be a
key in its dispatch table.
"""

import texture

#: The pass name, re-exported from texture.py, which is where it is stamped into
#: every spec. The registry uses it to route a face back here at tessellation
#: time, and to keep this plugin's cache keys separate from another plugin's.
PASS = texture.PASS


def _handle_texture(f, ctx):
    """The rebuild-time verb for a `texture` feature.

    Two-phase, like every other selector feature but lazier: validate NOW (so a
    bad kind/param/image path shows red on the timeline immediately) against the
    CURRENT shape via a THROWAWAY resolve, but never touch `act["shape"]`. The
    spec is stored raw and re-resolved once, lazily, against the FINAL shape at
    tessellation/export time, so it survives downstream topology changes the
    same way every other lossy-tolerant selector already does.
    """
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Texture")
    if act is None:
        raise ValueError("Texture: the target body no longer exists")
    sel = f.get("faces") or {"by": "all"}
    found = texture._resolve_texture_faces(act["shape"], sel)
    if not found:
        raise ValueError("no face found for texture")
    ctx.stash(act, texture.validate_texture_spec(f))


def _resolve(body, spec, diag=None):
    """Which faces of the body's FINAL shape this spec lands on.

    A spec whose selector now matches nothing is dropped by returning an empty
    list: the targeted face was consumed downstream, which is best-effort
    behaviour every other selector-based feature already has.
    """
    shape = body.get("shape")
    if shape is None:
        return []
    return texture._resolve_texture_faces(
        shape, spec.get("faces") or {"by": "all"}, diag, spec.get("feature_id")
    )


def register(engine, plugin_id):
    """Called once by the sidecar, with the registry module and this plugin's id."""
    engine.register_feature("texture", plugin_id, _handle_texture)
    engine.register_mesh_pass(
        PASS,
        plugin_id,
        resolve=_resolve,
        displace=texture.displace_face,
        code_version=lambda: texture.CODE_VERSION,
    )
