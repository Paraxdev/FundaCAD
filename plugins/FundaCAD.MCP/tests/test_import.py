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
engine opens paths, and the middle of this file is about that file: that it
holds what was sent, that the name it is given cannot be turned into a path
somewhere else, and that it is gone afterwards whether the read worked or not.

The last part is about the two things that decide whether a real part fits down
that route. Compressed, a STEP file is a tenth of the size; split into pieces, it
is not limited to one message at all. Both are ways of turning bytes back into
the file, so both are tested the same way: the engine has to receive exactly what
the file was, and anything short of that has to be refused rather than imported
as a body that is quietly not the part.

The end-to-end case is covered separately by driving the real server against
sidecar/fixtures/asm_flat.step; this file is about the parts that are hard to
provoke on purpose.

Run: uv run python plugins/FundaCAD.MCP/tests/test_import.py
"""

import _bootstrap  # noqa: F401
import _run

import asyncio
import atexit
import base64
import gzip
import io
import os
import re
import tempfile
import zipfile

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


#: Every server these tests make. Several are left holding an upload on
#: purpose (a piece refused, an order broken, a file nobody finished sending),
#: and each of those is a directory in the temp folder that outlives the run.
SERVERS = []


def server_with(reply):
    srv = S.Server()
    srv.link = FakeLink(reply)
    SERVERS.append(srv)
    return srv


@atexit.register
def _drop_what_the_tests_left():
    for srv in SERVERS:
        for up in list(srv.uploads.values()):
            srv._drop_upload(up)


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


def test_content_that_is_not_even_ascii_still_says_base64():
    # A codec error naming a character offset would be about a string the
    # caller never sees as text. The answer is the same as for any other
    # not-base64: say so, and name the argument that takes text.
    srv = server_with(PART)
    out = run(srv, {"content": "éééé", "name": "p.step"})
    assert out.get("isError")
    assert "base64" in text_of(out) and "text" in text_of(out), text_of(out)
    assert not srv.link.calls
    assert not srv.uploads


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


# --- compressed ---------------------------------------------------------------

def a_zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
    return buf.getvalue()


def test_a_gzipped_file_is_unpacked_before_the_engine_sees_it():
    srv = server_with(PART)
    out = run(srv, {"content": b64(gzip.compress(STL)), "name": "part.stl",
                    "compression": "gzip"})
    assert not out.get("isError"), text_of(out)
    assert srv.link.saw[0] == STL, "the engine was handed the archive"


def test_a_name_ending_gz_says_so_without_being_told():
    # And the format has to come from what is INSIDE: "gz" is not a format, and
    # a file called part.stl.gz is a part.stl.
    srv = server_with(PART)
    run(srv, {"content": b64(gzip.compress(STL)), "name": "part.stl.gz"})
    op, payload = srv.link.calls[0]
    assert payload["format"] == "stl", payload
    assert srv.link.saw[0] == STL
    assert srv.doc["features"][0]["source"] == "part.stl", srv.doc["features"][0]


def test_gzip_is_recognised_on_sight():
    # Nothing this reads begins 1f 8b, so a gzip can be spotted from its first
    # two bytes. Worth doing because an agent that gzips a file and forgets to
    # say so otherwise gets a reader error about a corrupt STEP.
    srv = server_with(PART)
    run(srv, {"content": b64(gzip.compress(STL)), "name": "part.stl"})
    assert srv.link.saw[0] == STL


def test_a_3mf_is_passed_through_although_it_is_a_zip():
    # THE control for sniffing. A 3MF *is* a zip archive and the engine reads it
    # as one, so unpacking anything that merely looked like a zip would turn a
    # 3MF import into whatever happened to sit inside it. A zip is unpacked only
    # when it is declared, which is why only gzip is recognised on sight.
    blob = a_zip([("3D/3dmodel.model", b"<model/>")])
    srv = server_with(PART)
    run(srv, {"content": b64(blob), "name": "part.3mf"})
    assert srv.link.calls[0][1]["format"] == "3mf"
    assert srv.link.saw[0] == blob, "unpacked a 3MF and handed over its contents"


def test_a_zipped_step_is_taken_out_of_the_archive():
    step = b"ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n"
    srv = server_with(PART)
    out = run(srv, {"content": b64(a_zip([("asm.step", step)])),
                    "name": "asm.zip", "compression": "zip"})
    assert not out.get("isError"), text_of(out)
    assert srv.link.saw[0] == step


def test_stpz_is_a_zipped_step_by_name():
    # ISO 10303-21's own spelling for a zipped STEP. The zip took the inner
    # extension away, so the suffix has to carry the format itself.
    step = b"ISO-10303-21;\nEND-ISO-10303-21;\n"
    srv = server_with(PART)
    run(srv, {"content": b64(a_zip([("asm.stp", step)])), "name": "asm.stpz"})
    assert srv.link.calls[0][1]["format"] == "step"
    assert srv.link.saw[0] == step


def test_the_format_comes_from_the_file_inside_a_plain_zip():
    # A ".zip" says nothing about what it holds, and nobody said either, so the
    # only thing left that knows is the entry's own name.
    srv = server_with(PART)
    run(srv, {"content": b64(a_zip([("thing.stl", STL)])), "name": "bundle.zip"})
    assert srv.link.calls[0][1]["format"] == "stl", srv.link.calls


def test_a_zip_of_several_files_is_refused_by_name():
    # Which one was meant is a question with a right answer this process does
    # not have, and importing the wrong one looks like success until the
    # measurements come out wrong.
    blob = a_zip([("a.step", b"ISO-10303-21;"), ("b.stl", STL)])
    srv = server_with(PART)
    out = run(srv, {"content": b64(blob), "name": "two.zip", "compression": "zip"})
    assert out.get("isError")
    assert "a.step" in text_of(out) and "b.stl" in text_of(out), text_of(out)
    assert not srv.link.calls
    assert not srv.doc["features"]

    # The control: naming the format answers the question, so the same archive
    # goes through. The refusal is the ambiguity, not the archive.
    srv = server_with(PART)
    out = run(srv, {"content": b64(blob), "name": "two.zip",
                    "compression": "zip", "format": "stl"})
    assert not out.get("isError"), text_of(out)
    assert srv.link.saw[0] == STL


def test_compression_none_overrules_a_name_that_says_otherwise():
    # The escape hatch for a file that really is called .gz and really is not
    # compressed. Without it the name would be the last word on the question.
    blob = gzip.compress(STL)
    srv = server_with(PART)
    run(srv, {"content": b64(blob), "name": "part.stl.gz", "compression": "none"})
    assert srv.link.saw[0] == blob, "unpacked it after being told not to"


def test_a_gzip_that_is_not_one_is_refused_pointing_at_the_argument():
    srv = server_with(PART)
    out = run(srv, {"content": b64(STL), "name": "part.stl", "compression": "gzip"})
    assert out.get("isError")
    assert "compression" in text_of(out), text_of(out)
    assert not srv.link.calls
    assert not srv.doc["features"]


def test_what_comes_out_of_an_archive_is_capped():
    # The ratio between an archive and its contents has no upper bound: a few
    # hundred bytes of gzip expands to a gigabyte of zeroes, so a limit on what
    # ARRIVES is not a limit at all. Patched small, because the assertion is
    # about the refusal and not about writing half a gigabyte.
    fat = b"0" * 4096
    srv = server_with(PART)
    real, S.MAX_UNPACKED_BYTES = S.MAX_UNPACKED_BYTES, 1024
    try:
        out = run(srv, {"content": b64(gzip.compress(fat)), "name": "p.stl",
                        "compression": "gzip"})
        assert out.get("isError"), text_of(out)
        assert not srv.link.calls

        # The control: the same archive under a cap that fits goes through, so
        # what was refused is the size and not the gzip.
        S.MAX_UNPACKED_BYTES = len(fat)
        srv = server_with(PART)
        assert not run(srv, {"content": b64(gzip.compress(fat)), "name": "p.stl",
                             "compression": "gzip"}).get("isError")
        assert srv.link.saw[0] == fat
    finally:
        S.MAX_UNPACKED_BYTES = real


# --- in pieces ----------------------------------------------------------------

def upload_id(out):
    m = re.search(r'upload="([0-9a-f]+)"', text_of(out))
    assert m, text_of(out)
    return m.group(1)


def in_pieces(srv, blob, parts, **first):
    """Encode the WHOLE file once and split the text, which is what the tool
    asks for and what an agent splitting its own output does."""
    enc = b64(blob)
    step = -(-len(enc) // parts)
    outs, uid = [], None
    for i in range(parts):
        args = {"content": enc[i * step:(i + 1) * step], "part": i + 1,
                "parts": parts}
        args.update(first if i == 0 else {"upload": uid})
        outs.append(run(srv, args))
        if i == 0 and not outs[0].get("isError") and parts > 1:
            uid = upload_id(outs[0])
    return outs


def test_a_file_split_across_calls_arrives_whole():
    srv = server_with(PART)
    body = STL * 200
    outs = in_pieces(srv, body, 4, name="part.stl")
    assert not outs[-1].get("isError"), text_of(outs[-1])
    assert len(srv.link.calls) == 1, "asked the engine more than once"
    assert srv.link.saw[0] == body
    assert len(srv.doc["features"]) == 1


def test_nothing_is_imported_until_the_last_piece():
    # What makes a half-arrived file safe in live mode: the document is
    # untouched, so `_call_live` finds nothing changed and offers the app
    # nothing. A partial upload that pushed would put a body that is not the
    # part in front of the user.
    srv = server_with(PART)
    enc = b64(STL * 200)
    out = run(srv, {"content": enc[:100], "part": 1, "parts": 3, "name": "p.stl"})
    assert not out.get("isError"), text_of(out)
    assert not srv.link.calls, "read a file that had not finished arriving"
    assert not srv.doc["features"]
    assert "part 2" in text_of(out).lower(), text_of(out)
    assert upload_id(out) in srv.uploads


def test_the_pieces_have_to_arrive_in_order():
    # Buffering a gap would mean holding the pieces until it filled, and a gap
    # that never fills looks exactly like one that has not filled yet.
    srv = server_with(PART)
    enc = b64(STL * 200)
    first = run(srv, {"content": enc[:100], "part": 1, "parts": 3, "name": "p.stl"})
    uid = upload_id(first)
    out = run(srv, {"content": enc[100:200], "part": 3, "parts": 3, "upload": uid})
    assert out.get("isError")
    assert "part 2" in text_of(out), text_of(out)

    # The control: the piece that WAS expected is taken, on the same upload.
    out = run(srv, {"content": enc[100:200], "part": 2, "parts": 3, "upload": uid})
    assert not out.get("isError"), text_of(out)


def test_a_piece_that_names_no_upload_is_refused():
    srv = server_with(PART)
    enc = b64(STL * 200)
    run(srv, {"content": enc[:100], "part": 1, "parts": 2, "name": "p.stl"})
    out = run(srv, {"content": enc[100:], "part": 2, "parts": 2})
    assert out.get("isError")
    assert "upload" in text_of(out), text_of(out)
    assert not srv.link.calls


def test_a_piece_that_disagrees_about_how_many_there_are_is_refused():
    # The declared count is what says the file is complete. A piece that
    # renegotiated it could end an upload early, and a truncated STEP is a file
    # the reader may well accept.
    srv = server_with(PART)
    enc = b64(STL * 200)
    uid = upload_id(run(srv, {"content": enc[:100], "part": 1, "parts": 3,
                              "name": "p.stl"}))
    out = run(srv, {"content": enc[100:], "part": 2, "parts": 2, "upload": uid})
    assert out.get("isError")
    assert "3" in text_of(out), text_of(out)
    assert not srv.link.calls


def test_separately_encoded_pieces_are_caught_at_the_first_one():
    # The other way to read "send it in pieces": encode each piece rather than
    # split the encoding. Joining those back gives a file that is not the file,
    # and base64 padding in the middle is the signature. Caught at the piece
    # that carries it rather than at the end, where it would look like a
    # corrupt STEP.
    srv = server_with(PART)
    out = run(srv, {"content": b64(STL), "part": 1, "parts": 2, "name": "p.stl"})
    assert out.get("isError"), text_of(out)
    assert "split" in text_of(out), text_of(out)
    assert not srv.uploads, "left the upload open after refusing its first piece"


def test_part_and_parts_go_together():
    srv = server_with(PART)
    out = run(srv, {"content": b64(STL), "part": 1, "name": "p.stl"})
    assert out.get("isError")
    assert "parts" in text_of(out)


def test_an_upload_nobody_came_back_for_is_swept():
    # This process outlives any one conversation, so an upload abandoned halfway
    # would hold its directory for as long as the host runs.
    srv = server_with(PART)
    enc = b64(STL * 200)
    first = run(srv, {"content": enc[:100], "part": 1, "parts": 9, "name": "p.stl"})
    up = srv.uploads[upload_id(first)]
    assert os.path.isdir(up.dir)

    up.touched -= S.UPLOAD_IDLE_SECONDS + 1     # time passes
    run(srv, {"content": enc[:100], "part": 1, "parts": 9, "name": "q.stl"})
    assert up.id not in srv.uploads, "kept an upload nobody came back for"
    assert not os.path.exists(up.dir), "left its directory behind"


def test_a_refused_piece_leaves_nothing_open():
    srv = server_with(PART)
    enc = b64(STL * 200)
    uid = upload_id(run(srv, {"content": enc[:100], "part": 1, "parts": 3,
                              "name": "p.stl"}))
    where = srv.uploads[uid].dir
    out = run(srv, {"content": 12345, "part": 2, "parts": 3, "upload": uid})
    assert out.get("isError")
    assert uid not in srv.uploads
    assert not os.path.exists(where)


def test_the_inline_cap_counts_every_piece_and_not_each_one():
    # Pieces are a transport detail, so they must not be a way around the limit
    # on how much may arrive inline. WHERE it is refused is the assertion: at
    # the piece that crosses the line, not after the whole thing has been
    # spooled to disk. A cap that only counted at the end would let a caller
    # ignoring it write without bound before finding out.
    srv = server_with(PART)
    body = STL * 200
    real, S.MAX_INLINE_BYTES = S.MAX_INLINE_BYTES, len(body) // 2
    try:
        outs = in_pieces(srv, body, 4, name="part.stl")
        first_bad = next(i for i, o in enumerate(outs) if o.get("isError"))
        assert first_bad == 2, [text_of(o) for o in outs]
        assert not srv.link.calls
        assert not srv.uploads, "left the over-large upload open"
    finally:
        S.MAX_INLINE_BYTES = real


def test_compressed_and_in_pieces_at_once():
    # The combination is the point of both: a STEP file gzips about tenfold, and
    # pieces lift the ceiling of one message, so together they are what makes a
    # real part importable this way at all.
    step = b"ISO-10303-21;\n" + b"#1=CARTESIAN_POINT('',(0.,0.,0.));\n" * 400
    srv = server_with(PART)
    packed = gzip.compress(step)
    assert len(packed) < len(step) // 4, "the fixture does not compress"
    outs = in_pieces(srv, packed, 3, name="asm.step.gz")
    assert not outs[-1].get("isError"), text_of(outs[-1])
    assert srv.link.calls[0][1]["format"] == "step"
    assert srv.link.saw[0] == step


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
