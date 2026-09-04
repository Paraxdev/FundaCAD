"""The server over a real pipe, spoken to by a real client.

Everything else here tests a function. This tests the PROTOCOL, which is where
the failures nothing else can see live: a stray print to stdout corrupts the
stream, a reply to a notification is a protocol error the host may hang up over,
and a tool that raises instead of returning isError takes the whole session down
instead of telling the model what went wrong.

The last group builds real geometry, so it spawns a sidecar and is the slowest
thing in this directory. It is here anyway: "can an agent go from an empty
document to a solid" is the only question this whole server exists to answer.

Run: uv run python mcp/tests/test_protocol.py
"""

import _bootstrap  # noqa: F401
import _run

import asyncio
import json
import os
import tempfile

from client import McpClient


def drive(steps):
    """Run a list of (tool, args) against one server and return the results."""
    async def go():
        async with McpClient() as c:
            return [await c.call(name, args) for name, args in steps]
    return asyncio.run(go())


def one(name, args=None):
    return drive([(name, args or {})])[0]


# --- the handshake ------------------------------------------------------------


def test_the_server_initializes_and_lists_its_tools():
    async def go():
        async with McpClient() as c:
            return await c.tools()
    tools = asyncio.run(go())
    names = {t["name"] for t in tools}
    for want in ("schema", "build", "inspect", "view", "feature_add", "param_set",
                 "doc_save"):
        assert want in names, f"{want} is not offered: {sorted(names)}"
    for t in tools:
        assert t["description"], t["name"]
        assert t["inputSchema"]["type"] == "object", t["name"]
        for req in t["inputSchema"]["required"]:
            assert req in t["inputSchema"]["properties"], (t["name"], req)


def test_a_notification_gets_no_reply():
    """MCP notifications carry no id, and answering one desynchronises every
    reply after it — the client would match the next request against a stale
    message and hang. McpClient.start() sends `initialized` and then the first
    tool call has to come back correctly, which is the assertion."""
    r = one("schema", {"type": "box"})
    assert not r["isError"] and "box" in r["text"]


def test_an_unknown_tool_is_an_isError_result_and_not_a_crash():
    r = one("no_such_tool")
    assert r["isError"] and "no_such_tool" in r["text"]


def test_a_tool_that_raises_comes_back_as_isError_with_the_reason():
    r = one("feature_add", {"feature": {"nope": 1}})
    assert r["isError"] and "type" in r["text"], r["text"]


def test_the_server_survives_a_failed_call_and_keeps_answering():
    """The property that makes isError worth having: the session continues."""
    rs = drive([("feature_add", {"feature": {}}),
                ("feature_add", {"feature": {"type": "box", "length": 1,
                                             "width": 1, "height": 1}}),
                ("doc_get", {})])
    assert rs[0]["isError"]
    assert not rs[1]["isError"]
    assert "bx1" in rs[2]["text"]


# --- documents ----------------------------------------------------------------


def test_a_document_round_trips_through_a_file():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "part.funda").replace("\\", "/")
        rs = drive([
            ("param_set", {"name": "h", "expr": 12}),
            ("feature_add", {"feature": {"id": "bx1", "type": "box", "length": 40,
                                         "width": 30, "height": "h"}}),
            ("doc_save", {"path": path}),
        ])
        assert not any(r["isError"] for r in rs), [r["text"] for r in rs]
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        assert doc["features"][0]["height"] == "h", "the parameter reference was flattened"
        assert doc["parameters"]["h"] == 12, "the derived cache the sidecar reads is missing"
        assert doc["paramDefs"]["h"]["expr"] == "12"

        back = drive([("doc_open", {"path": path}), ("doc_get", {})])
        assert not back[0]["isError"], back[0]["text"]
        assert "bx1" in back[1]["text"]


def test_a_RELATIVE_path_lands_where_the_caller_is_standing():
    """Where does `doc_save "part.funda"` put the file?

    A relative path resolves against the SERVER process's working directory. The
    client used to start it in `mcp/`, so an agent that ran the client from its
    own scratch directory and saved a part watched that directory stay empty
    while the file appeared inside this repository — which it had been told not
    to write to. Nothing said so: the reply echoed back the relative path it had
    been given, which is true from every directory and useful from none.

    Two things are asserted, and the second is the one that failed: the file is
    where the caller stands, and it is NOT next to the server.
    """
    here = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        os.chdir(tmp)
        try:
            rs = drive([
                ("feature_add", {"feature": {"id": "bx1", "type": "box",
                                             "length": 4, "width": 4, "height": 4}}),
                ("doc_save", {"path": "part.funda"}),
            ])
        finally:
            os.chdir(here)
        assert not rs[-1]["isError"], rs[-1]["text"]
        landed = os.path.join(tmp, "part.funda")
        assert os.path.exists(landed), f"not in the caller directory: {os.listdir(tmp)}"
        # and the reply says WHERE, so a caller never has to go looking
        assert os.path.abspath(landed) in rs[-1]["text"].replace("/", os.sep), rs[-1]["text"]
    stray = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "part.funda")
    assert not os.path.exists(stray), f"the server wrote into the repository: {stray}"


def test_a_refused_edit_leaves_the_document_alone():
    rs = drive([
        ("feature_add", {"feature": {"id": "bx1", "type": "box", "length": 1,
                                     "width": 1, "height": 1}}),
        ("feature_add", {"feature": {"id": "bx1", "type": "sphere", "radius": 2}}),
        ("doc_get", {"features_only": True}),
    ])
    assert rs[1]["isError"], rs[1]["text"]
    doc = json.loads(rs[2]["text"])
    assert len(doc["features"]) == 1 and doc["features"][0]["type"] == "box"


def test_an_EXPRESSION_in_a_feature_field_is_named_as_such():
    """The mistake that looks like it ought to work. The app evaluates
    expressions in the parameter table and writes numbers into fields, so a
    field holds a number or a bare parameter NAME; the sidecar's own error for
    an expression names the string and not the rule."""
    rs = drive([
        ("param_set", {"name": "d", "expr": 20}),
        ("feature_add", {"feature": {"id": "cy1", "type": "cylinder",
                                     "radius": "d/2", "height": 30}}),
    ])
    assert "expression" in rs[1]["text"], rs[1]["text"]
    assert "param_set" in rs[1]["text"], rs[1]["text"]


def test_a_document_problem_is_reported_before_a_build_is_attempted():
    r = one("feature_add", {"feature": {"id": "ex1", "type": "extrude",
                                        "sketch": "nothing", "distance": 1,
                                        "operation": "new"}})
    assert "nothing" in r["text"], r["text"]


# --- geometry (spawns a sidecar) ----------------------------------------------


def test_an_empty_document_can_be_taken_all_the_way_to_a_solid():
    rs = drive([
        ("param_set", {"name": "d", "expr": 20}),
        ("param_set", {"name": "r", "expr": "d/2"}),
        ("feature_add", {"feature": {"id": "cy1", "type": "cylinder",
                                     "radius": "r", "height": 30}}),
        ("build", {}),
        ("inspect", {}),
        ("view", {"view": "front", "width": 160, "height": 120}),
    ])
    for name, r in zip(("param_set", "param_set", "feature_add", "build",
                        "inspect", "view"), rs):
        assert not r["isError"], f"{name}: {r['text']}"
    assert "20.0 x 20.0 x 30.0" in rs[3]["text"], rs[3]["text"]
    assert "cylinder" in rs[4]["text"], rs[4]["text"]
    assert rs[5]["images"] and rs[5]["images"][0][:8] == b"\x89PNG\r\n\x1a\n"
    assert len(rs[5]["images"][0]) > 200


def test_a_failed_feature_is_REPORTED_and_not_passed_off_as_a_no_op():
    """The one that bit hardest while this was being written: a rebuild whose
    feature fails still returns ok, with the failures in `featureErrors` beside
    the geometry that did build. Reading the wrong key made a refused press/pull
    look like a press/pull that did nothing at all."""
    rs = drive([
        ("feature_add", {"feature": {"id": "bx1", "type": "box", "length": 20,
                                     "width": 20, "height": 20}}),
        ("feature_add", {"feature": {"id": "fil1", "type": "fillet",
                                     "edges": {"kind": "edge", "by": "all",
                                               "body": "body1"},
                                     "radius": 500}}),
        ("build", {}),
    ])
    assert "FEATURE FAILED" in rs[2]["text"], rs[2]["text"]
    assert "fil1" in rs[2]["text"], rs[2]["text"]


def test_inspect_hands_back_a_selector_that_addresses_the_face_it_names():
    """The whole point of inspect: an agent that has never clicked on anything
    can still write the next feature. The proof is using one of the selectors it
    returns to press/pull that face, and getting a body that changed."""
    rs = drive([
        ("feature_add", {"feature": {"id": "bx1", "type": "box", "length": 20,
                                     "width": 20, "height": 20}}),
        ("build", {}),
        ("inspect", {"detail": True, "selectors": True}),
    ])
    assert not rs[2]["isError"], rs[2]["text"]
    body = json.loads(rs[2]["text"].split("selectors:", 1)[1])
    top = None
    for _, sel in body["body1"]["faces"].items():
        if sel["fp"]["normal"] == [0.0, 0.0, 1.0]:
            top = sel
    assert top is not None, "no face selector reported an upward normal"
    rs2 = drive([
        ("feature_add", {"feature": {"id": "bx1", "type": "box", "length": 20,
                                     "width": 20, "height": 20}}),
        ("feature_add", {"feature": {"id": "pp1", "type": "press-pull",
                                     "face": top, "distance": 5,
                                     "operation": "join"}}),
        ("build", {}),
    ])
    assert "FEATURE FAILED" not in rs2[2]["text"], rs2[2]["text"]
    assert "20.0 x 20.0 x 25.0" in rs2[2]["text"], rs2[2]["text"]


if __name__ == "__main__":
    _run.run(globals(), "protocol")
