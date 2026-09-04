"""Telling a fillet that is too BIG apart from one that will never build.

OCCT answers every blend failure with "try a smaller length value(s)", whatever
went wrong. Sometimes that is the truth; sometimes it is a retry loop that
cannot terminate, because the operation fails identically at 5mm and at 0.05mm.

The instrument is one extra kernel attempt on the failure path, at a twentieth
of the size. Measured on a cylinder half sunk into a plate — the partial cap rim
runs into the plate at both ends — that rim builds at 1.5mm and fails at 2.0mm,
and the smaller probe builds, so OCCT's own sentence is the honest one and is
passed through unchanged.

Where it fails at both, the user is told so and told what to do instead. That is
worth holding down in both directions: a guard like this is useless if it never
fires, and actively harmful if it fires on an ordinary too-big radius.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Box, Cylinder, Pos, Rot, fillet

from builder import (
    SIZE_PROBE_FRACTION,
    _blend_failure_message,
    _size_would_help,
)


def _boss_on_a_plate():
    """A cylinder lying on its side, half sunk in a plate. Its end cap is cut by
    the plate, so the cap rim is a pair of ARCS that die into a neighbouring
    face rather than a closed circle — the shape a blend has the most trouble
    terminating on."""
    plate = Box(40, 40, 6)
    return plate + Pos(0, 0, 3) * Rot(0, 90, 0) * Cylinder(8, 30)


def _cap_rim(shape):
    return [e for e in shape.edges()
            if e.geom_type.name == "CIRCLE" and abs(e.center().X - 15) < 1e-6]


def _one_edge_at(shape, edge, size):
    return fillet([edge], radius=size)


def test_the_partial_rim_is_a_real_size_limit():
    """It builds small and fails big, so this genuinely IS about the radius."""
    shape = _boss_on_a_plate()
    rim = _cap_rim(shape)
    assert len(rim) == 2, f"expected the cap circle cut into 2 arcs, got {len(rim)}"
    fillet(rim, radius=1.5)
    try:
        fillet(rim, radius=2.0)
        raise AssertionError("2.0mm was expected to exceed what this rim can hold")
    except AssertionError:
        raise
    except Exception:
        pass
    print("partial cap rim: builds at 1.5mm, refused at 2.0mm OK")


def test_size_probe_says_yes_when_the_radius_is_the_problem():
    shape = _boss_on_a_plate()
    rim = _cap_rim(shape)
    assert _size_would_help(shape, rim, _one_edge_at, 2.0) is True
    print(f"probe at {2.0 * SIZE_PROBE_FRACTION}mm builds -> size is the problem OK")


def test_a_huge_request_does_not_make_the_probe_lie():
    """A twentieth of a HUGE value is still huge.

    The probe used to be a fraction of the REQUESTED size and nothing else, so a
    drag that ran far past the limit probed past it too, and the refusal
    announced that no size would help while a small one built perfectly. The
    message was at its most misleading exactly when the user was furthest from a
    value that works — which a drag reaches in a fraction of a second.

    CONTROL: the same rim at 2.0mm, where the probe is genuinely small, must
    still come back True and must NOT be dragged down by this cap.
    """
    shape = _boss_on_a_plate()
    rim = _cap_rim(shape)
    fillet(rim, radius=1.5)          # a size that builds, so "ANY size" would be false
    assert _size_would_help(shape, rim, _one_edge_at, 200.0) is True
    msg = _blend_failure_message("Fillet", {"name": "Body1", "shape": shape}, rim,
                                 _one_edge_at, 200.0, "Failed creating a fillet")
    assert "ANY size" not in msg, msg
    assert _size_would_help(shape, rim, _one_edge_at, 2.0) is True
    print("a 200mm request still probes small enough to find the 1.5mm that builds OK")


def test_the_message_passes_OCCTs_own_words_through_when_size_would_help():
    """The one case where "try a smaller value" is worth repeating. Inventing a
    friendlier sentence here would be worse than OCCT's, because OCCT is right."""
    shape = _boss_on_a_plate()
    body = {"name": "Body1", "shape": shape}
    msg = _blend_failure_message(
        "Fillet", body, _cap_rim(shape), _one_edge_at, 2.0,
        "Failed creating a fillet with radius of 2.0",
    )
    assert "Fillet failed on Body1" in msg, msg
    assert "ANY size" not in msg, msg
    print("size-limited refusal keeps the kernel's wording OK")


def test_the_kernel_sentence_drops_the_method_nobody_here_can_call():
    """The pass-through above is only good advice as far as its first comma.

    build123d ends every fillet failure with "or use max_fillet() to find the
    largest valid fillet radius". That is a method on a build123d Shape, offered
    to someone whose entire interface is a radius box in a ribbon or a JSON
    field over a socket. An agent building through MCP followed it and found
    nothing to call; a user reading a toast has even less. The first half is
    right and stays.

    The CONTROL comes first: take the sentence from build123d itself rather than
    from a string in this file, so that if the wording ever changes this test
    fails instead of quietly guarding text that no longer exists.
    """
    shape = _boss_on_a_plate()
    rim = _cap_rim(shape)
    try:
        fillet(rim, radius=2.0)
        raise AssertionError("2.0mm was expected to exceed what this rim can hold")
    except AssertionError:
        raise
    except Exception as ex:
        raw = str(ex)
    assert "max_fillet()" in raw, f"build123d no longer says this: {raw}"

    msg = _blend_failure_message("Fillet", {"name": "Body1", "shape": shape},
                                 rim, _one_edge_at, 2.0, raw)
    assert "max_fillet" not in msg, msg
    assert "try a smaller value" in msg, msg
    assert "Fillet failed on Body1" in msg, msg
    print("the uncallable method is dropped, the useful half kept OK:", msg)


def test_the_message_refuses_by_name_when_no_size_would_help():
    """The failure this exists for. Nothing may suggest a smaller value, because
    the user has already tried smaller values — that is how they got here."""
    shape = _boss_on_a_plate()
    body = {"name": "Body1", "shape": shape}

    def never(_shape, _edge, _size):
        raise RuntimeError("Failed creating a fillet with radius of 0.15")

    msg = _blend_failure_message(
        "Fillet", body, _cap_rim(shape)[:1], never, 0.15,
        "Failed creating a fillet with radius of 0.15",
    )
    assert "ANY size" in msg, msg
    assert "0.0075mm" in msg, msg   # 0.15 * SIZE_PROBE_FRACTION, spelled out
    assert "smaller" not in msg.lower(), msg
    assert "nowhere to end" in msg, msg
    print("all-sizes refusal names the real cause OK")


def test_a_large_selection_is_not_probed():
    """The probe is a kernel call per edge. Past a handful it would cost more
    than the failed operation did, so it declines to answer and the caller falls
    back to OCCT's wording rather than to a guess."""
    shape = _boss_on_a_plate()
    many = list(shape.edges())[:12]
    assert _size_would_help(shape, many, _one_edge_at, 1.0) is None
    body = {"name": "Body1", "shape": shape}
    msg = _blend_failure_message("Fillet", body, many, _one_edge_at, 1.0, "nope")
    assert "ANY size" not in msg, msg
    print("oversized selections skip the probe and keep the kernel wording OK")


if __name__ == "__main__":
    try:
        test_the_partial_rim_is_a_real_size_limit()
        test_size_probe_says_yes_when_the_radius_is_the_problem()
        test_a_huge_request_does_not_make_the_probe_lie()
        test_the_message_passes_OCCTs_own_words_through_when_size_would_help()
        test_the_kernel_sentence_drops_the_method_nobody_here_can_call()
        test_the_message_refuses_by_name_when_no_size_would_help()
        test_a_large_selection_is_not_probed()
        print("\nall blend-refusal tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
