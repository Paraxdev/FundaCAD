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

A file can also arrive as `content`, for an agent whose host holds the file but
will not give a path to it. Those bytes become a temporary file, because the
engine opens paths, and the second half of this file is about that file: that it
holds what was sent, that the name it is given cannot be turned into a path
somewhere else, and that it is gone afterwards whether the read worked or not.

The end-to-end case is covered separately by driving the real server against
sidecar/fixtures/asm_flat.step; this file is about the parts that are hard to
provoke on purpose.

Run: uv run python plugins/FundaCAD.MCP/tests/test_import.py
"""

import _bootstrap  # noqa: F401
import _run

import asyncio
import base64
import os
import tempfile

import model as M
import server as S


class FakeLink:
    """The engine, replaced by whatever the test wants it to answer.

    It reads the file WHILE the call is in flight, which is the only moment it
    exists for an inline import: by the time the tool returns the temporary file
    has been deleted, so a test that looked afterwards would find nothing and be
    unable to tell a correct write from no write at all.
    """

    def __init__(self, reply):
        self.reply = reply
        self.calls = []
        self.saw = []

    async def call(self, op, **payload):
        self.calls.append((op, payload))
        try:
            with open(payload["path"], "rb") as fh:
                self.saw.append(fh.read())
        except OSError:
            self.saw.append(None)
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


#: Small enough to read in a failure message, and a real (if trivial) ASCII STL.
STL = b"solid s\nfacet normal 0 0 1\nendfacet\nendsolid s\n"


def b64(data):
    return base64.b64encode(data).decode()


def test_content_reaches_the_engine_as_a_file_holding_those_bytes():
    srv = server_with(PART)
    out = run(srv, {"content": b64(STL), "name": "part.stl"})
    assert not out.get("isError"), text_of(out)

    _op, payload = srv.link.calls[0]
    assert payload["format"] == "stl", payload
    assert srv.link.saw[0] == STL, srv.link.saw
    assert os.path.basename(payload["path"]) == "part.stl", payload["path"]


def test_the_temporary_file_does_not_outlive_the_read():
    # The document keeps `geom`, a hash into the blob store, so the bytes are
    # already durable. Leaving the copy behind would put every file an agent
    # ever handed over into the temp directory, permanently.
    srv = server_with(PART)
    run(srv, {"content": b64(STL), "name": "part.stl"})
    path = srv.link.calls[0][1]["path"]
    assert not os.path.exists(path), path
    assert not os.path.exists(os.path.dirname(path)), "left the directory behind"


def test_the_temporary_file_goes_when_the_read_fails_too():
    # The control for the case above, and the one worth writing down: clean-up
    # on the happy path is easy to get right by accident.
    srv = server_with({"ok": False, "error": {"message": "unreadable"}})
    out = run(srv, {"content": b64(STL), "name": "part.stl"})
    assert out.get("isError")
    assert not os.path.exists(srv.link.calls[0][1]["path"])


def test_the_document_records_the_file_name_and_not_the_temporary_path():
    # `source` is provenance. Naming a file that was deleted a moment later
    # would send anyone who read the field to a path that never resolves.
    srv = server_with(PART)
    run(srv, {"content": b64(STL), "name": "part.stl"})
    assert srv.doc["features"][0]["source"] == "part.stl"


def test_a_text_format_can_be_sent_as_its_own_text():
    # STEP, OBJ and ASCII STL are text, and an agent that has read one is
    # holding a string. Making it base64 first would be a step whose only
    # purpose is to be undone here.
    srv = server_with(PART)
    out = run(srv, {"content": STL.decode(), "name": "part.stl", "encoding": "text"})
    assert not out.get("isError"), text_of(out)
    assert srv.link.saw[0] == STL


def test_text_sent_as_base64_says_which_argument_would_have_worked():
    # The likeliest mistake, and the one whose default message is least useful:
    # "Invalid base64-encoded string" does not tell anyone that the file was
    # fine and the encoding argument was the problem.
    srv = server_with(PART)
    out = run(srv, {"content": "ISO-10303-21;\nHEADER;\n", "name": "asm.step"})
    assert out.get("isError")
    assert "text" in text_of(out), text_of(out)
    assert not srv.link.calls, "went to the engine with nothing to read"
    assert not srv.doc["features"]


def test_base64_wrapped_in_newlines_is_still_base64():
    # The control for the refusal above. Encoders wrap at 76 columns and a
    # strict decode refuses a newline, so validating what arrived verbatim would
    # reject the well-formed payload far more often than the malformed one.
    srv = server_with(PART)
    enc = b64(STL * 40)
    wrapped = "\n".join(enc[i:i + 76] for i in range(0, len(enc), 76))
    out = run(srv, {"content": wrapped, "name": "part.stl"})
    assert not out.get("isError"), text_of(out)
    assert srv.link.saw[0] == STL * 40


def test_a_file_has_to_arrive_one_way_or_the_other():
    srv = server_with(PART)
    out = run(srv, {})
    assert out.get("isError")
    assert "path" in text_of(out) and "content" in text_of(out)
    assert not srv.link.calls


def test_a_file_cannot_arrive_both_ways_at_once():
    # Refused rather than resolved. Either one is a defensible guess, and
    # importing the file the caller did not mean is a mistake that looks like
    # success right up until the measurements come out wrong.
    srv = server_with(PART)
    path = a_file()
    try:
        out = run(srv, {"path": path, "content": b64(STL)})
    finally:
        os.unlink(path)
    assert out.get("isError")
    assert not srv.link.calls


def test_the_name_is_what_gives_inline_content_its_format():
    srv = server_with(PART)
    run(srv, {"content": b64(STL), "name": "part.3mf"})
    assert srv.link.calls[0][1]["format"] == "3mf"


def test_content_with_no_name_at_all_is_read_as_step():
    # The same fallback the extension takes, for the same reason.
    srv = server_with(PART)
    run(srv, {"content": b64(b"ISO-10303-21;")})
    assert srv.link.calls[0][1]["format"] == "step"


def test_the_format_argument_still_names_the_file_it_writes():
    # With no `name` there is nothing to take an extension from, so the format
    # has to supply one: a file called `imported` with no suffix is a worse
    # thing to see in a log than one called `imported.stl`.
    srv = server_with(PART)
    run(srv, {"content": b64(STL), "format": "stl"})
    op, payload = srv.link.calls[0]
    assert payload["format"] == "stl"
    assert os.path.basename(payload["path"]) == "imported.stl", payload["path"]


def test_a_name_cannot_write_outside_the_directory_made_for_it():
    # `name` is a string from the model and it becomes a path here, so a
    # separator in it must not be one.
    srv = server_with(PART)
    run(srv, {"content": b64(STL), "name": "../../../evil.step"})
    path = srv.link.calls[0][1]["path"]
    parent = os.path.dirname(path)
    assert os.path.basename(parent).startswith("fundacad-import-"), path
    assert os.sep not in os.path.basename(path), path
    assert "evil" in os.path.basename(path), path


def test_an_ordinary_name_is_left_exactly_as_it_is():
    # The control for the sanitiser: it must not rewrite the ordinary case.
    assert S._safe_filename("Bracket_v2-final.step", "step") == "Bracket_v2-final.step"
    assert S._safe_filename("", "stl") == "imported.stl"
    assert S._safe_filename("..", "step") == "imported.step"


def test_content_too_large_to_send_inline_points_at_path():
    # The cap is on the MESSAGE, not the file: the engine has its own limit and
    # applies it to what is on disk. Patched small here, because the assertion
    # is about the refusal and not about allocating the real ceiling.
    srv = server_with(PART)
    real, S.MAX_INLINE_BYTES = S.MAX_INLINE_BYTES, len(STL) - 1
    try:
        out = run(srv, {"content": b64(STL), "name": "p.stl"})
        assert out.get("isError")
        assert "path" in text_of(out), text_of(out)
        assert not srv.link.calls

        # The control: the same bytes under the same cap go through, so what
        # was refused above is the size and not the mechanism.
        S.MAX_INLINE_BYTES = len(STL)
        srv = server_with(PART)
        assert not run(srv, {"content": b64(STL), "name": "p.stl"}).get("isError")
    finally:
        S.MAX_INLINE_BYTES = real


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
