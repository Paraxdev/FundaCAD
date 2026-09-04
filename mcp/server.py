"""FundaCAD over MCP: the tools another model uses to build, measure and look at
a part.

The protocol is JSON-RPC 2.0, one message per line, on stdin/stdout. That is all
MCP is on a stdio transport, and hand-rolling it here beats pinning an SDK into
a repository that has none — the whole of it is `_dispatch` below.

STDOUT IS THE PROTOCOL. Nothing else may ever be printed to it; a stray print
corrupts the stream and the client sees the server die for no stated reason.
Everything diagnostic goes to stderr, which the host shows in its logs.

What the tools are for, in the order they are meant to be used:

  schema        what a feature looks like — read this before authoring one
  param_set     the driving dimensions, named, so the model stays parametric
  feature_*     the timeline
  build         make it, and say what broke
  inspect       exact measurements, and the SELECTORS that address each face
                and edge — this is what makes the next feature writable
  view          a picture, because "is the hole in the right place" is not a
                question numbers answer
  doc_save      a .funda file the app opens

The state is one document held in this process. It is never the document the
user has open in the app: this server spawns its own sidecar (see
sidecar_link.py), so an agent working here cannot disturb a session in progress
and hands its work back as a file.
"""

import asyncio
import base64
import copy
import io
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import describe as D  # noqa: E402
import model as M  # noqa: E402
import render as R  # noqa: E402
import schema as S  # noqa: E402
from sidecar_link import SidecarLink  # noqa: E402

#: The MCP revisions this server knows how to speak. The client names one in
#: `initialize` and we echo it back when we know it; otherwise we name our own
#: and let the client decide, which is what the specification asks for.
KNOWN_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_PROTOCOL = KNOWN_PROTOCOLS[0]

SERVER_INFO = {"name": "fundacad", "version": "0.1.0"}

#: Renders are returned inline as base64 PNG, so the size is a context cost
#: rather than a disk one. 640x480 is legible and about 25 kB of PNG on a
#: typical part; the cap stops a caller asking for something no context can hold.
MAX_IMAGE_PX = 1600


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Tool:
    """One MCP tool: a name, a description the caller reads, a JSON schema for
    its arguments, and the coroutine that runs it."""

    def __init__(self, name, description, properties, required, fn):
        self.name = name
        self.description = description
        self.schema = {"type": "object", "properties": properties, "required": list(required)}
        self.fn = fn

    def as_json(self):
        return {"name": self.name, "description": self.description, "inputSchema": self.schema}


def text(s):
    return {"content": [{"type": "text", "text": s}]}


def failure(s):
    return {"content": [{"type": "text", "text": s}], "isError": True}


class Server:
    def __init__(self):
        self.doc = M.new_document()
        self.path = None
        self.link = SidecarLink.from_env()
        #: The last successful build's per-body mesh, which is what `view`
        #: draws. Kept rather than re-requested: a render right after a build is
        #: the common case and the mesh is the expensive part of the reply.
        self.mesh = []
        self.built_for = None  # the document signature `self.mesh` belongs to
        self.tools = {}
        self._register()

    # --- the tools ------------------------------------------------------------

    def _register(self):
        def add(name, desc, props, required, fn):
            self.tools[name] = Tool(name, desc, props, required, fn)

        add("schema",
            "The document schema: every feature type, its fields, an example and "
            "the traps. Call it with no argument for the overview and the working "
            "order, or with a type name for that type's detail. READ THIS FIRST.",
            {"type": {"type": "string", "description": "a feature type, e.g. \"revolve\""}},
            [], self.t_schema)

        add("doc_new", "Start an empty document, discarding the current one.",
            {}, [], self.t_doc_new)

        add("doc_open", "Load a .funda document from disk.",
            {"path": {"type": "string"}}, ["path"], self.t_doc_open)

        add("doc_save",
            "Write the document to a .funda file, which the FundaCAD app opens "
            "directly. Saves to the path it was opened from if none is given.",
            {"path": {"type": "string"}}, [], self.t_doc_save)

        add("doc_get",
            "The whole document as JSON: parameters and the feature timeline in order.",
            {"features_only": {"type": "boolean",
                               "description": "omit the parameter table"}},
            [], self.t_doc_get)

        add("doc_set",
            "Replace the whole document with the given JSON. For wholesale "
            "rewrites; prefer the feature_* tools for edits.",
            {"document": {"type": "object"}}, ["document"], self.t_doc_set)

        add("param_set",
            "Define or redefine a parameter. `expr` may be a number or an "
            "expression over other parameters (\"hub_d/2 - wall\"). Features "
            "reference it by NAME, which is what keeps the model parametric. "
            "Refused, changing nothing, if the expression does not resolve.",
            {"name": {"type": "string"},
             "expr": {"type": ["string", "number"]},
             "unit": {"type": "string", "enum": ["mm", "deg", "count"]},
             "comment": {"type": "string"}},
            ["name", "expr"], self.t_param_set)

        add("param_remove", "Delete a parameter. Refused if anything still uses it.",
            {"name": {"type": "string"}}, ["name"], self.t_param_remove)

        add("feature_add",
            "Append a feature to the timeline (or insert it at `at`). Returns the "
            "id it was given. Call `schema` for the shape of one.",
            {"feature": {"type": "object", "description": "the feature JSON, needs at least `type`"},
             "at": {"type": "integer", "description": "insert position; append if omitted"}},
            ["feature"], self.t_feature_add)

        add("feature_update",
            "Merge `patch` into a feature. A null value in the patch REMOVES that "
            "field. Pass replace=true to swap the whole body instead.",
            {"id": {"type": "string"}, "patch": {"type": "object"},
             "replace": {"type": "boolean"}},
            ["id", "patch"], self.t_feature_update)

        add("feature_remove", "Delete a feature from the timeline.",
            {"id": {"type": "string"}}, ["id"], self.t_feature_remove)

        add("feature_move", "Move a feature to another position in the timeline.",
            {"id": {"type": "string"}, "to": {"type": "integer"}},
            ["id", "to"], self.t_feature_move)

        add("build",
            "Rebuild the document and report what came out: the bodies, their "
            "sizes, and any feature that failed. Build often — an error names the "
            "feature that caused it.",
            {}, [], self.t_build)

        add("inspect",
            "Exact measurements of the built bodies: volume, area, bounding box, "
            "and — the part that matters — every face and edge with a ready-made "
            "SELECTOR you can paste into the next feature. Also flags seam edges "
            "and wrapping faces, which are what fillet and press/pull refuse.",
            {"body": {"type": "string", "description": "one body id; all of them if omitted"},
             "detail": {"type": "boolean",
                        "description": "list every face and edge (default: summary only)"},
             "selectors": {"type": "boolean",
                           "description": "include the raw selector JSON for each face and edge"},
             "faces": {"type": "array", "items": {"type": "integer"},
                       "description": "only these face indices"},
             "edges": {"type": "array", "items": {"type": "integer"},
                       "description": "only these edge indices"}},
            [], self.t_inspect)

        add("view",
            "Render the built model as a PNG. Orthographic, flat-shaded, with "
            "edges drawn. Use it to check what the numbers cannot tell you. "
            "`section` cuts it open, which is the only way to see a bore, a "
            "pocket or a thread; `bodies` draws one part of an assembly; "
            "`focus` zooms in on a point, which is the only way to see a "
            "small feature on a large part.",
            {"view": {"type": "string",
                      "enum": ["iso", "front", "back", "left", "right", "top", "bottom"]},
             "azimuth": {"type": "number", "description": "degrees anticlockwise from +X"},
             "elevation": {"type": "number", "description": "degrees above the XY plane"},
             "width": {"type": "integer"}, "height": {"type": "integer"},
             "bodies": {"type": "array", "items": {"type": "string"},
                        "description": "only draw these body ids"},
             "section": {"type": "object",
                         "description": "cut the model open to see inside: "
                                        "{axis: X|Y|Z, at: mm (default: the "
                                        "middle), keep: below|above}"},
             "focus": {"type": "object",
                       "description": "look closer: {at: [x,y,z], size: mm} "
                                      "frames a window that many mm across "
                                      "around that point"},
             "highlight_body": {"type": "string"},
             "highlight_faces": {"type": "array", "items": {"type": "integer"},
                                 "description": "face indices to paint orange"}},
            [], self.t_view)

        add("export",
            "Write the model to STEP, STL, 3MF or OBJ.",
            {"path": {"type": "string"},
             "format": {"type": "string", "enum": ["step", "stl", "3mf", "obj", "brep"]}},
            ["path", "format"], self.t_export)

    # --- document -------------------------------------------------------------

    async def t_schema(self, args):
        return text(S.schema_text(args.get("type")))

    async def t_doc_new(self, args):
        self.doc = M.new_document()
        self.path = None
        self._invalidate()
        return text("New empty document.")

    async def t_doc_open(self, args):
        path = args["path"]
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        if not isinstance(doc, dict) or "features" not in doc:
            return failure(f"{path} is not a FundaCAD document (no `features`).")
        self.doc = doc
        self.doc.setdefault("parameters", {})
        self.doc.setdefault("paramDefs", {})
        self.path = path
        self._invalidate()
        issues = M.recompute_parameters(self.doc)
        note = ("\nparameter problems: " + "; ".join(f"{k}: {v}" for k, v in issues.items())
                if issues else "")
        return text(f"Opened {path}: {len(self.doc['features'])} features, "
                    f"{len(self.doc.get('paramDefs') or {})} parameters.{note}")

    async def t_doc_save(self, args):
        path = args.get("path") or self.path
        if not path:
            return failure("No path given and this document has never been saved.")
        M.recompute_parameters(self.doc)
        parent = os.path.dirname(os.path.abspath(path))
        if parent and not os.path.isdir(parent):
            return failure(f"No such directory: {parent}")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.doc, fh, indent=1)
        self.path = path
        return text(f"Saved {len(self.doc['features'])} features to {path}.")

    async def t_doc_get(self, args):
        out = {"features": self.doc.get("features", [])}
        if not args.get("features_only"):
            out["parameters"] = self.doc.get("parameters", {})
            out["paramDefs"] = self.doc.get("paramDefs", {})
        return text(json.dumps(out, indent=1))

    async def t_doc_set(self, args):
        doc = args["document"]
        if not isinstance(doc, dict) or not isinstance(doc.get("features"), list):
            return failure("`document` needs a `features` list.")
        self.doc = copy.deepcopy(doc)
        self.doc.setdefault("parameters", {})
        self.doc.setdefault("paramDefs", {})
        self.doc.setdefault("version", M.FORMAT_VERSION)
        self._invalidate()
        M.recompute_parameters(self.doc)
        return text(self._state_line("Replaced the document."))

    async def t_param_set(self, args):
        d = M.set_parameter(self.doc, args["name"], args["expr"],
                            args.get("unit", "mm"), args.get("comment"))
        self._invalidate()
        # Just this parameter. Printing the whole table on every call turned a
        # twenty-parameter model into twenty pages of the same numbers; anything
        # that wants the table can ask doc_get for it.
        return text(f"{args['name']} = {d['expr']} -> {d['value']:g} {d['unit']} "
                    f"({len(self.doc['parameters'])} parameters defined)")

    async def t_param_remove(self, args):
        M.remove_parameter(self.doc, args["name"])
        self._invalidate()
        return text(f"Removed {args['name']}. Now: {json.dumps(self.doc['parameters'])}")

    async def t_feature_add(self, args):
        fid = M.add_feature(self.doc, args["feature"], args.get("at"))
        self._invalidate()
        return text(self._state_line(f"Added {fid}."))

    async def t_feature_update(self, args):
        f = M.update_feature(self.doc, args["id"], args["patch"], bool(args.get("replace")))
        self._invalidate()
        return text(self._state_line(f"Updated {args['id']}: {json.dumps(f)}"))

    async def t_feature_remove(self, args):
        f = M.remove_feature(self.doc, args["id"])
        self._invalidate()
        return text(self._state_line(f"Removed {args['id']} ({f.get('type')})."))

    async def t_feature_move(self, args):
        M.move_feature(self.doc, args["id"], args["to"])
        self._invalidate()
        return text(self._state_line(f"Moved {args['id']} to position {args['to']}."))

    def _state_line(self, head):
        ids = " -> ".join(f"{f.get('id')}:{f.get('type')}" for f in self.doc.get("features", []))
        problems = M.validate(self.doc)
        out = f"{head}\ntimeline: {ids or '(empty)'}"
        if problems:
            out += "\nproblems (these WILL fail a build):\n  " + "\n  ".join(problems)
        return out

    def _invalidate(self):
        self.mesh = []
        self.built_for = None

    # --- geometry -------------------------------------------------------------

    async def t_build(self, args):
        problems = M.validate(self.doc)
        reply = await self.link.call("rebuild", document=self.doc, revision=1, tolerance=0.1)
        if not reply.get("ok"):
            err = (reply.get("error") or {}).get("message", "unknown error")
            where = (reply.get("error") or {}).get("feature_id")
            return failure(f"Build failed{f' at {where}' if where else ''}: {err}")
        result = reply.get("result") or {}
        self.mesh = result.get("bodies") or []
        self.built_for = _signature(self.doc)
        # Sizes come from a second call, not from the mesh bbox in this reply.
        # The mesh bbox is BRepBndLib over the triangulation plus the shape's
        # own gap tolerance, and after an offset or a thicken that tolerance is
        # large: measured 48.41 x 52.03 x 24.45 on a body whose exact box is
        # 36.57 x 36.57 x 21.45. A number a third too big, on the line an agent
        # reads after every single build, is worth one cache-warm rebuild.
        exact = {}
        deep = await self.link.call("inspect", document=self.doc, detail=False)
        if deep.get("ok"):
            exact = {b["id"]: b for b in (deep["result"].get("bodies") or [])}
        lines = []
        for b in self.mesh:
            e = exact.get(b["id"]) or {}
            size = ((e.get("bbox") or {}).get("size")
                    or [round(hi - lo, 3) for lo, hi in zip((b.get("bbox") or {}).get("min", [0, 0, 0]),
                                                            (b.get("bbox") or {}).get("max", [0, 0, 0]))])
            vol = f", vol {e['volume']:.6g} mm3" if e.get("volume") else ""
            lines.append(f"{b['id']} \"{b.get('name')}\": {size[0]} x {size[1]} x {size[2]} mm{vol}, "
                         f"{b.get('faceCount')} faces, {len(b.get('indices') or []) // 3} triangles")
        # `featureErrors` — NOT `errors`. A feature that fails is recorded as a
        # no-op and the rebuild carries on, so the reply is a successful one
        # carrying the failures beside the geometry that did build. Reading the
        # wrong key made a failed press/pull look like a press/pull that did
        # nothing, which is the single most misleading thing this tool could say.
        for e in result.get("featureErrors") or []:
            if isinstance(e, dict) and e.get("message"):
                lines.append(f"FEATURE FAILED ({e.get('feature_id')}): {e['message']}")
        for d in result.get("diagnostics") or []:
            if isinstance(d, dict) and d.get("message"):
                lines.append(f"warning: {d['message']}")
        if not self.mesh:
            lines.append("No bodies were produced.")
        if problems:
            lines.append("document problems: " + "; ".join(problems))
        return text("\n".join(lines))

    async def t_inspect(self, args):
        payload = {"document": self.doc, "detail": True}
        if args.get("body"):
            payload["bodies"] = [args["body"]]
        reply = await self.link.call("inspect", **payload)
        if not reply.get("ok"):
            return failure("Inspect failed: " + (reply.get("error") or {}).get("message", "?"))
        report = reply.get("result") or {}
        want_faces = set(args["faces"]) if args.get("faces") is not None else None
        want_edges = set(args["edges"]) if args.get("edges") is not None else None
        if want_faces is not None or want_edges is not None:
            for b in report.get("bodies") or []:
                if want_faces is not None:
                    b["faces"] = [f for f in (b.get("faces") or []) if f["i"] in want_faces]
                if want_edges is not None:
                    b["edges"] = [e for e in (b.get("edges") or []) if e["i"] in want_edges]
        detail = bool(args.get("detail") or want_faces is not None or want_edges is not None)
        out = D.describe(report, detail=detail)
        if args.get("selectors"):
            sel = {}
            for b in report.get("bodies") or []:
                sel[b["id"]] = {
                    "faces": {f"F{f['i']}": f["selector"] for f in (b.get("faces") or [])},
                    "edges": {f"E{e['i']}": e["selector"] for e in (b.get("edges") or [])},
                }
            out += "\n\nselectors:\n" + json.dumps(sel, indent=1)
        return text(out)

    async def t_view(self, args):
        if not self.mesh or self.built_for != _signature(self.doc):
            built = await self.t_build({})
            if built.get("isError"):
                return built
        if not self.mesh:
            return failure("Nothing to render: the document produced no bodies.")
        w = max(64, min(int(args.get("width") or 640), MAX_IMAGE_PX))
        h = max(64, min(int(args.get("height") or 480), MAX_IMAGE_PX))
        highlight = None
        if args.get("highlight_faces"):
            body = args.get("highlight_body") or self.mesh[0]["id"]
            highlight = {body: set(args["highlight_faces"])}
        img = R.render(self.mesh, w, h, view=args.get("view") or "iso",
                       azimuth=args.get("azimuth"), elevation=args.get("elevation"),
                       highlight=highlight, section=args.get("section"),
                       bodies=args.get("bodies"), focus=args.get("focus"))
        png = _png_bytes(img)
        where = args.get("view") or f"az {args.get('azimuth', 0)} el {args.get('elevation', 0)}"
        shown = args.get("bodies") or [b["id"] for b in self.mesh]
        cut = ""
        if args.get("section"):
            sec = args["section"]
            cut = (f", cut on {sec.get('axis', 'X')} at "
                   f"{sec.get('at', 'the middle')}, keeping "
                   f"{sec.get('keep', 'below')}")
        return {"content": [
            {"type": "text",
             "text": f"{where} view of {', '.join(shown)}, {w}x{h}{cut}"},
            {"type": "image", "data": base64.b64encode(png).decode("ascii"),
             "mimeType": "image/png"},
        ]}

    async def t_export(self, args):
        path = os.path.abspath(args["path"])
        parent = os.path.dirname(path)
        if parent and not os.path.isdir(parent):
            return failure(f"No such directory: {parent}")
        reply = await self.link.call("export", document=self.doc,
                                     format=args["format"], path=path)
        if not reply.get("ok"):
            return failure("Export failed: " + (reply.get("error") or {}).get("message", "?"))
        size = os.path.getsize(path) if os.path.exists(path) else 0
        return text(f"Wrote {path} ({size} bytes).")

    # --- the protocol ---------------------------------------------------------

    async def handle(self, msg):
        """One JSON-RPC message in, zero or one out. A notification (no `id`)
        gets no reply at all, which is not an oversight — replying to one is a
        protocol error the client is entitled to hang up over."""
        method = msg.get("method")
        mid = msg.get("id")
        params = msg.get("params") or {}
        if method == "initialize":
            asked = params.get("protocolVersion")
            version = asked if asked in KNOWN_PROTOCOLS else DEFAULT_PROTOCOL
            return _result(mid, {
                "protocolVersion": version,
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": SERVER_INFO,
                "instructions": S.HOW_TO,
            })
        if method in ("notifications/initialized", "notifications/cancelled"):
            return None
        if method == "ping":
            return _result(mid, {})
        if method == "tools/list":
            return _result(mid, {"tools": [t.as_json() for t in self.tools.values()]})
        if method == "resources/list":
            return _result(mid, {"resources": [{
                "uri": "fundacad://schema",
                "name": "FundaCAD document schema",
                "description": "Every feature type, its fields and its traps.",
                "mimeType": "text/plain",
            }]})
        if method == "resources/read":
            uri = params.get("uri")
            if uri != "fundacad://schema":
                return _error(mid, -32602, f"no such resource: {uri}")
            return _result(mid, {"contents": [{"uri": uri, "mimeType": "text/plain",
                                               "text": S.schema_text()}]})
        if method == "tools/call":
            return _result(mid, await self.call_tool(params.get("name"),
                                                     params.get("arguments") or {}))
        if mid is None:
            return None
        return _error(mid, -32601, f"unknown method: {method}")

    async def call_tool(self, name, args):
        """A tool's own failure is a RESULT with isError, not a JSON-RPC error.

        The distinction matters: a JSON-RPC error means the call was malformed
        and the model cannot learn anything from it, while isError puts the
        message in front of the model as something to react to. Almost
        everything that goes wrong here — a bad selector, an impossible fillet,
        a sketch that does not close — is the second kind."""
        tool = self.tools.get(name)
        if tool is None:
            return failure(f"No tool {name!r}. Have: {', '.join(sorted(self.tools))}")
        try:
            return await tool.fn(args)
        except (M.DocumentError, KeyError, ValueError, TypeError) as ex:
            return failure(f"{type(ex).__name__}: {ex}")
        except FileNotFoundError as ex:
            return failure(str(ex))
        except Exception:
            log(traceback.format_exc())
            return failure(f"{name} failed:\n{traceback.format_exc(limit=3)}")


def _signature(doc):
    """What the last build was of. Cheap and exact: if this string is unchanged,
    the cached mesh is still the answer."""
    return json.dumps({"f": doc.get("features"), "p": doc.get("parameters")}, sort_keys=True)


def _png_bytes(img):
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _result(mid, result):
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def _error(mid, code, message):
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


async def serve(read_line, write, server=None):
    """The read loop. Line-delimited JSON both ways.

    `read_line` is a coroutine returning the next line (b"" or "" at end of
    input) and `write` takes one line of text; injecting both is what lets a
    test drive the whole protocol over two lists instead of a process.

    Messages are handled one at a time. MCP allows concurrency, but every tool
    here ends in the sidecar, which serialises heavy work anyway, and an agent
    asking one question at a time is the entire traffic pattern."""
    server = server or Server()
    try:
        while True:
            line = await read_line()
            if not line:
                break
            if isinstance(line, bytes):
                line = line.decode("utf-8", "replace")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception as ex:
                write(json.dumps(_error(None, -32700, f"parse error: {ex}")))
                continue
            try:
                reply = await server.handle(msg)
            except Exception:
                log(traceback.format_exc())
                reply = _error(msg.get("id"), -32603, "internal error")
            if reply is not None:
                write(json.dumps(reply))
    finally:
        await server.link.stop()


def _stdout_line(s):
    print(s, flush=True)  # stdout IS the protocol: nothing else may write here


async def _stdin_lines():
    """stdin, read on a thread.

    Not asyncio's connect_read_pipe: on Windows the proactor loop cannot take a
    console stdin and the selector loop cannot take a pipe, and a blocking
    readline on the default executor works on every platform. It costs nothing
    — this process spends its life waiting on one pipe or the other."""
    loop = asyncio.get_running_loop()
    return lambda: loop.run_in_executor(None, sys.stdin.readline)


async def _main():
    await serve(await _stdin_lines(), _stdout_line)


def main():
    asyncio.run(_main())


if __name__ == "__main__":
    main()
