"""tests/vectors/body_ids.json and face_colors.json against the Python modules they
were recorded from, so a change here that the Rust twin (fundacad-core) and the
TypeScript decoder would not follow fails in this suite too.

Run: uv run python tests/test_shared_vectors.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import json
import os

import body_ids
import face_colors

_VECTORS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tests", "vectors")


def _load(name):
    with open(os.path.join(_VECTORS, name), encoding="utf8") as fh:
        return json.load(fh)


def test_body_ids():
    v = _load("body_ids.json")
    for bid, n in v["number"]:
        assert body_ids.number(bid) == n, bid
    for s in v["sessions"]:
        ids = body_ids.BodyIds(s["recorded"])
        for step, want in zip(s["steps"], s["results"]):
            if step[0] == "start":
                ids.start_feature(step[1])
                continue
            key = ids.key(step[1] if step[0] == "keyNode" else None)
            got = [key, ids.assign(key, step[1] if step[0] == "keyInherit" else None)]
            assert got == want, (s["name"], got, want)
        assert [list(e) for e in ids.events] == s["events"], s["name"]
        assert ids.resulting_map() == s["resultingMap"], s["name"]
    for r in v["restore"]:
        ids = body_ids.BodyIds(r["recorded"])
        assert ids.restore([tuple(e) for e in r["events"]]) == r["expect"], r["name"]


def test_face_colors():
    v = _load("face_colors.json")
    for c in v["encode"]:
        assert face_colors.encode(c["colors"]) == c["packed"], c["name"]
    for c in v["decode"]:
        assert face_colors.decode(c["packed"], c["count"]) == c["colors"], c["packed"]
    for c in v["dominant"]:
        assert face_colors.dominant(c["colors"]) == c["dominant"], c["colors"]


if __name__ == "__main__":
    test_body_ids()
    test_face_colors()
    print("shared vectors OK")
