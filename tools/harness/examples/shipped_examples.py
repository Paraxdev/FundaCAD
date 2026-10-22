"""Every example on Home opens from its card as an untitled, clean copy, builds, and holds the bodies it should,
and the Box with a lid still fits its lid after its size and clearance change.

Run with `python tools/harness/examples/shipped_examples.py`.
"""

from fundacad_harness import Session

# Each body's bounding box, min and max corners in mm, in body order.
EXAMPLES = {
    "Wall bracket": [((0, -12, 0), (70, 12, 60))],
    "Box with a lid": [((-69, -22, 0), (-5, 22, 27)), ((5, -22, 0), (69, 22, 7))],
    "Plate": [((-40, -25, 0), (40, 25, 6))],
    "Pinned lever": [((-13, -13, 0), (100, 13, 10))],
}

INSPECT = "() => window.geometry.session('inspect', { document: window.store.document })"
CLASHES = "() => window.geometry.interference(window.store.document, 0.01)"


def open_example(s, name):
    if s.bridge.call("startScreen") != "home":
        s.menu("File/Home")
    s.page.click(f'.home-example:has-text("{name}")')
    s.settle()


def boxes(found):
    return [
        (tuple(round(v, 2) for v in b["bbox"]["min"]), tuple(round(v, 2) for v in b["bbox"]["max"]))
        for b in found["bodies"]
    ]


def near(got, want, tol):
    return len(got) == len(want) and all(
        abs(g - w) <= tol for gb, wb in zip(got, want) for gc, wc in zip(gb, wb) for g, w in zip(gc, wc)
    )


def walls(body, axis, above):
    """The centres along `axis` of the flat walls facing that axis whose centre sits above Z `above`."""
    return sorted(
        {round(f["centroid"][axis], 3) for f in body["faces"] if abs(f["normal"][axis]) > 0.99 and f["centroid"][2] > above}
    )


def fit(found, floor):
    box, lid = found["bodies"]
    bx, by = walls(box, 0, floor), walls(box, 1, floor)
    lx, ly = walls(lid, 0, floor), walls(lid, 1, floor)
    return {
        "inner": (round(bx[2] - bx[1], 3), round(by[2] - by[1], 3)),
        "lip": (round(lx[-1] - lx[0], 3), round(ly[-1] - ly[0], 3)),
    }


def set_params(s, values):
    for name, expr in values.items():
        err = s.page.evaluate("([n, e]) => window.store.setParamExpr(n, e)", [name, expr])
        assert err is None, (name, err)
    s.settle()


def run(s):
    for name, want in EXAMPLES.items():
        open_example(s, name)
        st = s.status(raw=True)
        path = s.page.evaluate("() => window.store.filePath")
        assert (st["doc"], path, st["dirty"]) == (name, None, False), (name, st, path)
        assert s.last_error() == "none", (name, s.last_error())
        found = s.page.evaluate(INSPECT)
        assert found["errors"] == [], (name, found["errors"])
        assert near(boxes(found), want, 0.05), (name, boxes(found))

    open_example(s, "Box with a lid")
    found = s.page.evaluate(INSPECT)
    assert fit(found, 2) == {"inner": (60, 40), "lip": (59.6, 39.6)}, fit(found, 2)
    clash = s.page.evaluate(CLASHES)
    assert (clash["ok"], clash.get("pairs", []), clash.get("clearances", [])) == (True, [], []), clash

    set_params(s, {"innerWidth": "63.7", "clearance": "0.35"})
    assert s.last_error() == "none", s.last_error()
    found = s.page.evaluate(INSPECT)
    assert fit(found, 2) == {"inner": (63.7, 40), "lip": (63, 39.3)}, fit(found, 2)
    assert near(boxes(found), [((-72.7, -22, 0), (-5, 22, 27)), ((5, -22, 0), (72.7, 22, 7))], 0.05), boxes(found)
    clash = s.page.evaluate(CLASHES)
    assert (clash["ok"], clash.get("pairs", []), clash.get("clearances", [])) == (True, [], []), clash
    assert not s.page_errors(), s.page_errors()


if __name__ == "__main__":
    with Session() as s:
        run(s)
    print("shipped examples: all checks passed")
