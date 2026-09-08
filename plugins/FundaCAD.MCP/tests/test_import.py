"""Reading a geometry file into the timeline.

An agent asked to make something that fits a real part could not get the part.
`import` was a feature type it was told not to author, and correctly: `geom` is a
content hash into the engine's blob store, so a hand-written one names a blob
that does not exist and the document fails to build with an error about a string.

`doc_import` is the two steps the app's own import does (src/io/files.ts,
importPath): ask the engine to read the file, then put the fields it hands back
into the timeline. The engine is stubbed here, because what is under test is
those fields and the refusals around them, and a test that needed a real STEP
reader could not check what happens when the read fails.

The end-to-end case is covered separately by driving the real server against
sidecar/fixtures/asm_flat.step; this file is about the parts that are hard to
provoke on purpose.

Run: uv run python plugins/FundaCAD.MCP/tests/test_import.py
"""

import _bootstrap  # noqa: F401
import _run

import asyncio
import os
import tempfile

import model as M
import server as S


class FakeLink:
    """The engine, replaced by whatever the test wants it to answer."""

    def __init__(self, reply):
        self.reply = reply
        self.calls = []

    async def call(self, op, **payload):
        self.calls.append((op, payload))
        return self.reply


#: What the real importer returns for a plain part: no colour, no assembly tree.
PART = {"ok": True, "result": {"geom": "abc123", "solid": True, "faces": 15,
                               "name": "bracket"}}


def server_with(reply):
    srv = S.Server()
    srv.link = FakeLink(reply)
    return srv


def a_file(suffix=".step"):
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    return path


def run(srv, args):
    return asyncio.run(srv.t_doc_import(args))


def text_of(out):
    return out["content"][0]["text"]


def test_the_extension_decides_the_format():
    for ext, want in ((".stl", "stl"), (".3MF", "3mf"), (".obj", "obj"),
                      (".brep", "brep"), (".glb", "glb"), (".step", "step"),
                      (".stp", "step")):
        assert S._import_format("part" + ext) == want, ext


def test_an_unknown_extension_is_read_as_step():
    # Mirrors extToImportFormat, and for its reason: STEP is spelled several
    # ways and occasionally not at all, so refusing what is not recognised would
    # make the commonest import the one that needs an argument. A file that is
    # not a STEP fails in the reader, which says so.
    assert S._import_format("part.xyz") == "step"
    assert S._import_format("part") == "step"


def test_it_reads_the_file_and_puts_a_body_in_the_timeline():
    srv = server_with(PART)
    path = a_file()
    try:
        out = run(srv, {"path": path})
    finally:
        os.unlink(path)
    assert not out.get("isError"), text_of(out)

    op, payload = srv.link.calls[0]
    assert op == "import", op
    assert payload["format"] == "step"
    assert payload["path"] == os.path.abspath(path)

    f = srv.doc["features"][0]
    # Exactly the fields the app's import writes. `geom` is the one that matters:
    # without it the feature is a body with no geometry.
    assert f["type"] == "import"
    assert f["geom"] == "abc123"
    assert f["solid"] is True
    assert f["format"] == "step"
    assert f["name"] == "bracket"
    assert f["source"] == os.path.abspath(path)


def test_a_plain_part_carries_no_colour_and_no_tree():
    # The control for the case below. `color`, `nodes` and `parts` are SPREAD by
    # the app's import, not defaulted, and absent is a different thing from null
    # to everything downstream. A feature that always carried them would change
    # what an ordinary import means.
    srv = server_with(PART)
    path = a_file()
    try:
        run(srv, {"path": path})
    finally:
        os.unlink(path)
    f = srv.doc["features"][0]
    for key in ("color", "nodes", "parts"):
        assert key not in f, key


def test_an_assembly_keeps_its_tree_and_a_glb_its_colour():
    srv = server_with({"ok": True, "result": {
        "geom": "def456", "solid": True, "faces": 40, "name": "asm",
        "color": [0.2, 0.4, 0.6], "nodes": [{"name": "Plate"}], "parts": ["a", "b"]}})
    path = a_file(".glb")
    try:
        out = run(srv, {"path": path})
    finally:
        os.unlink(path)
    f = srv.doc["features"][0]
    assert f["color"] == [0.2, 0.4, 0.6]
    assert f["nodes"] == [{"name": "Plate"}]
    assert f["parts"] == ["a", "b"]
    assert "2 parts" in text_of(out), text_of(out)


def test_a_missing_file_is_refused_without_asking_the_engine():
    # A read that cannot happen must not cost a round trip, and must not look
    # like the engine's fault.
    srv = server_with(PART)
    out = run(srv, {"path": os.path.join(tempfile.gettempdir(), "no-such-part.step")})
    assert out.get("isError")
    assert "No such file" in text_of(out)
    assert not srv.link.calls, srv.link.calls
    assert not srv.doc["features"]


def test_a_format_the_engine_cannot_read_is_refused_by_name():
    srv = server_with(PART)
    path = a_file()
    try:
        out = run(srv, {"path": path, "format": "dwg"})
    finally:
        os.unlink(path)
    assert out.get("isError")
    assert "dwg" in text_of(out) and "step" in text_of(out)
    assert not srv.link.calls


def test_the_engine_s_refusal_is_passed_through_whole():
    # It refuses for reasons an agent can act on: too large, too many triangles,
    # unreadable. Summarising those would throw away the only actionable part.
    why = "file is 512 MiB, too large to import (limit 400 MiB)."
    srv = server_with({"ok": False, "error": {"message": why}})
    path = a_file()
    try:
        out = run(srv, {"path": path})
    finally:
        os.unlink(path)
    assert out.get("isError")
    assert why in text_of(out)
    assert not srv.doc["features"], "kept a feature for a read that failed"


def test_a_read_that_returns_no_geometry_is_a_failure():
    # ok, but nothing to reference. A feature built from this would name an empty
    # hash and fail at build time instead of here.
    srv = server_with({"ok": True, "result": {"name": "empty", "solid": False}})
    path = a_file()
    try:
        out = run(srv, {"path": path})
    finally:
        os.unlink(path)
    assert out.get("isError")
    assert not srv.doc["features"]


def test_an_imported_feature_validates_clean():
    # `geom` and `source` are strings in a document whose other string fields
    # name parameters, so without an exemption every import reported two
    # problems saying a build WILL fail, on a document that builds.
    doc = {"parameters": {}, "features": [{
        "id": "f1", "type": "import", "format": "step", "name": "asm",
        "geom": "dcbb8a24", "source": r"C:\parts\asm.step", "solid": True}]}
    assert M.validate(doc) == [], M.validate(doc)
    # The control: the exemption is by field NAME, so a genuinely bad reference
    # in a numeric field on the same feature is still caught.
    doc["features"][0]["distance"] = "nope"
    assert any("distance" in p for p in M.validate(doc)), M.validate(doc)


def test_it_is_offered_to_the_app_like_any_other_edit():
    # In live mode a mutator's result is pushed to the running app as one undo
    # step. An import that was not on this list would be read into the agent's
    # copy and never reach the document the user is looking at.
    assert "doc_import" in S.Server.MUTATORS


if __name__ == "__main__":
    _run.run(globals(), "doc_import")
