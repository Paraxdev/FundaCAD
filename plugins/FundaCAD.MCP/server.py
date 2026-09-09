"""FundaCAD over MCP: the tools another model uses to build, measure and look at
a part.

The protocol is JSON-RPC 2.0, one message per line, on stdin/stdout. That is all
MCP is on a stdio transport, and hand-rolling it here beats pinning an SDK into
a repository that has none, the whole of it is `_dispatch` below.

STDOUT IS THE PROTOCOL. Nothing else may ever be printed to it; a stray print
corrupts the stream and the client sees the server die for no stated reason.
Everything diagnostic goes to stderr, which the host shows in its logs.

What the tools are for, in the order they are meant to be used:

  schema        what a feature looks like, read this before authoring one
  param_set     the driving dimensions, named, so the model stays parametric
  feature_*     the timeline
  build         make it, and say what broke
  inspect       exact measurements, and the SELECTORS that address each face
                and edge, this is what makes the next feature writable
  view          a picture, because "is the hole in the right place" is not a
                question numbers answer
  doc_save      a .funda file the app opens

There are two worlds, and `sidecar_link.py` picks between them at start-up:

  PRIVATE     the document is held in this process and nowhere else. This server
              spawns its own geometry engine, so an agent working here cannot
              disturb a session in progress, and hands its work back as a file.

  LIVE        the document is the one a running FundaCAD has open. Its engine is
              found through the session file it publishes (app_session.py), and
              every tool below reads that document before it runs and offers the
              result back afterwards (live_link.py). The user watches it happen
              and can undo any of it.

Which one is in force is `self.live`. Nothing in the tools themselves knows:
`_call_live` wraps them, so a tool is written once and works either way. That is
deliberate, a tool that had to remember which world it was in would eventually
forget, and forgetting means editing the wrong document.
"""

import asyncio
import base64
import contextlib
import copy
import gzip
import io
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import time
import traceback
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app_session  # noqa: E402
import describe as D  # noqa: E402
import model as M  # noqa: E402
import render as R  # noqa: E402
import schema as S  # noqa: E402
from live_link import LiveLink, NoAppOpen, ReadOnlySession, StaleEdit  # noqa: E402
from sidecar_link import SidecarLink, mode_from_env  # noqa: E402

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


def _append(result, extra):
    """Add a line to a tool result without rebuilding its shape."""
    out = copy.deepcopy(result)
    blocks = out.get("content") or []
    if blocks and blocks[-1].get("type") == "text":
        blocks[-1]["text"] += extra
    else:
        blocks.append({"type": "text", "text": extra.strip()})
    out["content"] = blocks
    return out


def _edit_note(name, args):
    """What the user sees beside the indicator that an assistant is editing.

    The tool name plus the one argument that identifies what it touched, enough
    to recognise an edit in a list, short enough for a line of UI. Untrusted only
    in the sense that the model wrote it; the sidecar caps its length and the app
    renders it as text.
    """
    subject = args.get("id") or args.get("name") or (args.get("feature") or {}).get("type")
    return f"{name}: {subject}" if subject else name


def failure(s):
    return {"content": [{"type": "text", "text": s}], "isError": True}


#: What `doc_import` will read. The same set the app's file pickers offer, and
#: the same names the engine's importer switches on.
IMPORT_FORMATS = ("step", "stl", "3mf", "obj", "brep", "glb")


#: How much file may arrive inline, summed over every piece of one upload. A
#: TRANSPORT limit, not the reader's: the engine keeps its own per-format cap and
#: applies it to the file on disk. `path` has no ceiling at all and stays the
#: answer for anything genuinely large.
MAX_INLINE_BYTES = 64 * 1024 * 1024

#: How much may be WRITTEN once an archive is opened. Deliberately above the
#: engine's own 400 MiB STEP cap, so nothing is refused here that the reader
#: would have accepted, and finite because the ratio between an archive and its
#: contents has no upper bound: a few hundred bytes of gzip expands to a
#: gigabyte of zeroes, and a limit only on what arrives is not a limit at all.
MAX_UNPACKED_BYTES = 512 * 1024 * 1024

#: When pieces nobody came back for are dropped. This process outlives any one
#: conversation, so an upload abandoned halfway would otherwise hold its
#: directory for as long as the host runs.
UPLOAD_IDLE_SECONDS = 30 * 60

#: Extensions that wrap a file rather than being one, and what is inside when
#: the name is all there is to go on. `.stpZ` is ISO 10303-21's own spelling for
#: a zipped STEP and carries no inner extension to read.
ARCHIVE_SUFFIXES = {"gz": ("gzip", None), "gzip": ("gzip", None),
                    "zip": ("zip", None), "stpz": ("zip", "step")}

#: Spellings the file pickers accept that are not the format's own name.
FORMAT_ALIASES = {"stp": "step"}


def _safe_filename(name, fmt):
    """A filename for inline content, built rather than trusted.

    `name` is whatever the agent called the file and it is about to become a
    path on this machine, so basename() is the least of it: ".." survives that,
    and a colon or a wildcard is simply unwritable on Windows, which would turn
    an ordinary import into an OSError raised from the wrong layer entirely.
    Only the extension is cosmetic here anyway, the format is decided before this.
    """
    base = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename((name or "").strip()))
    return base if base.strip(".") else f"imported.{fmt}"


#: Read and written in multiples of 4, so that a base64 spool splits at
#: character boundaries the decoder can take one block at a time. Padding only
#: ever appears at the very end, which is what makes that legal.
BLOCK = 4 * 1024 * 1024


def _mib(n):
    return f"{n / (1024 * 1024):.1f} MiB"


class Upload:
    """A file arriving inline, in one piece or in several.

    The pieces are appended to a spool on disk rather than joined in memory:
    what arrives may be four times the size of the file once it is decoded and
    unpacked, and holding the payload, the bytes and the write at once is three
    copies of something already at the edge of what a message can carry.

    Everything about the file (its name, its format, how it is compressed) is
    settled by the FIRST piece and is not revisited. A later piece that
    contradicts it is refused rather than reconciled: the pieces are a transport
    detail, and a file whose format changed halfway through is not one file.
    """

    def __init__(self, args, parts):
        name = args.get("name") or ""
        inner, wrapped = _unwrap_name(name)

        given = str(args.get("compression") or "").lower()
        # Whether to look at the bytes at all. Saying "none" is the escape hatch
        # for a file that really is called .gz and really is not compressed, so
        # it has to overrule what the bytes look like too; half a switch would
        # leave the argument meaning nothing on the one input it exists for.
        self.sniff = given != "none"
        if given == "none":
            compression = None          # an explicit none overrules the name
        elif given:
            if given not in ("gzip", "zip"):
                raise ValueError(f"Unknown compression {given!r}. "
                                 'Use "gzip", "zip", or leave it out.')
            compression = given
        else:
            compression = wrapped

        self.encoding = str(args.get("encoding") or "base64").lower()
        if self.encoding in ("utf8", "utf-8"):
            self.encoding = "text"
        if self.encoding not in ("base64", "text"):
            raise ValueError(f"Unknown encoding {self.encoding!r}. "
                             'Use "base64" or "text".')

        # Where the format came from decides one later question: a plain `.zip`
        # tells us nothing, so if nobody has said, the file inside gets to.
        self.told_format = bool(args.get("format")) or _format_of(inner) is not None
        fmt = str(args.get("format") or _import_format(inner)).lower()
        if fmt not in IMPORT_FORMATS:
            raise ValueError(f"Cannot import {fmt!r} files. "
                             f"Formats: {', '.join(IMPORT_FORMATS)}.")

        self.id = secrets.token_hex(3)
        self.compression = compression
        self.fmt = fmt
        self.name = inner or f"imported.{fmt}"
        self.filename = _safe_filename(inner, fmt)
        self.parts = parts
        self.got = 0
        self.touched = time.monotonic()
        # A directory of its own, so the name cannot collide with a concurrent
        # import and one rmtree is the whole clean-up.
        self.dir = tempfile.mkdtemp(prefix="fundacad-import-")
        self.spool = os.path.join(self.dir, "spool")

    @property
    def spooled(self):
        try:
            return os.path.getsize(self.spool)
        except OSError:
            return 0

    def write(self, content, part):
        """Append one piece. Raises ValueError saying what to do about it,
        because this is the one layer that knows both what went wrong and which
        argument would have avoided it."""
        if not isinstance(content, str):
            raise ValueError("content must be a string: base64, or the file's "
                             'own text with encoding "text".')
        if self.encoding == "base64":
            content = "".join(content.split())
            # Whitespace goes first because base64 is routinely wrapped at 76
            # columns, and a strict decode refuses a newline: validating what
            # arrived verbatim would reject the well-formed payload far more
            # often than the malformed one.
            if part < self.parts and content.endswith("="):
                raise ValueError(
                    f"part {part} ends in base64 padding, so it looks separately "
                    "encoded. Encode the whole file once and split the text that "
                    "comes out, otherwise the pieces cannot be joined back into "
                    "the file.")
        if self.encoding == "text":
            data = content.encode("utf-8")
        else:
            try:
                data = content.encode("ascii")
            except UnicodeEncodeError:
                # Not base64 at all, and saying so beats a codec error naming a
                # character offset in something the caller never sees as text.
                raise ValueError(
                    "content is not valid base64. A text format (STEP, OBJ, "
                    'ASCII STL) can be sent as it is with encoding "text".'
                ) from None

        # A spool bound, not the real one: the exact limit is on the DECODED
        # bytes and is checked as they are written. This exists only so that a
        # caller ignoring the limit cannot spool without bound before finding out.
        if self.spooled + len(data) > MAX_INLINE_BYTES // 3 * 4 + 64:
            raise ValueError(_too_large(self.spooled * 3 // 4))
        with open(self.spool, "ab") as fh:
            fh.write(data)
        self.got = part
        self.touched = time.monotonic()


def _too_large(size):
    return (f"content reached {_mib(size)}, more than can be sent inline "
            f"(limit {MAX_INLINE_BYTES // (1024 * 1024)} MiB). Send it gzipped "
            "with compression=\"gzip\", which a STEP file typically shrinks "
            "tenfold, or pass path instead, which has no limit at all.")


def _decode_spool(up, out_path):
    """The spool, as the bytes that were sent. Streamed a block at a time, and
    the block is a multiple of 4, so each read is a whole number of base64
    groups and decodes on its own."""
    total = 0
    with open(up.spool, "rb") as src, open(out_path, "wb") as dst:
        while True:
            block = src.read(BLOCK)
            if not block:
                break
            if up.encoding == "text":
                data = block
            else:
                try:
                    data = base64.b64decode(block, validate=True)
                except ValueError:
                    raise ValueError(
                        "content is not valid base64. A text format (STEP, OBJ, "
                        'ASCII STL) can be sent as it is with encoding "text". '
                        "Pieces have to be one file's base64 split into parts, "
                        "not a part each.") from None
            total += len(data)
            if total > MAX_INLINE_BYTES:
                raise ValueError(_too_large(total))
            dst.write(data)
    if not total:
        raise ValueError("content is empty.")
    return total


def _sniff_compression(path):
    """gzip, from its first two bytes, and gzip alone.

    A 3MF IS a zip archive and the engine reads it as one, so unpacking anything
    that merely looked like a zip would quietly turn a 3MF import into whatever
    happened to sit inside it. A zip has to be declared, by the argument or by
    the name; nothing we read begins 1f 8b, so gzip can be recognised on sight.
    """
    with open(path, "rb") as fh:
        return "gzip" if fh.read(2) == b"\x1f\x8b" else None


def _copy_capped(src, dst, what):
    total = 0
    while True:
        block = src.read(BLOCK)
        if not block:
            return total
        total += len(block)
        if total > MAX_UNPACKED_BYTES:
            raise ValueError(
                f"{what} is over {_mib(MAX_UNPACKED_BYTES)} once unpacked, "
                "which is more than "
                "will be read from an archive. Send the file itself, or pass "
                "path.")
        dst.write(block)


def _gunzip(src_path, dst_path):
    try:
        with gzip.open(src_path, "rb") as src, open(dst_path, "wb") as dst:
            return _copy_capped(src, dst, "the file")
    except (OSError, EOFError) as ex:
        raise ValueError(f"the gzip data could not be read ({ex}). If the file "
                         'is not compressed, leave compression out.') from None


def _unzip_one(src_path, dst_path, fmt, told_format):
    """Take the one file out of a zip, and say what it was called.

    An archive holding several is refused rather than guessed at: which one was
    meant is a question with a right answer that this process does not have, and
    importing the wrong one looks like success until the measurements are wrong.
    """
    try:
        with zipfile.ZipFile(src_path) as z:
            entries = [i for i in z.infolist() if not i.is_dir()]
            if not entries:
                raise ValueError("the archive holds no files.")
            if len(entries) == 1:
                info = entries[0]
            else:
                # Only a format somebody actually stated may choose. `fmt` falls
                # back to step whenever the name was silent, and letting that
                # pick would answer the question with a default.
                want = ([i for i in entries if _format_of(i.filename) == fmt]
                        if told_format else [])
                if len(want) != 1:
                    names = ", ".join(sorted(i.filename for i in entries)[:8])
                    raise ValueError(
                        f"the archive holds {len(entries)} files ({names}). Send "
                        "the one to import on its own, or name its format.")
                info = want[0]
            if info.file_size > MAX_UNPACKED_BYTES:
                raise ValueError(
                    f"{info.filename} is {_mib(info.file_size)} unpacked, more "
                    f"than the {_mib(MAX_UNPACKED_BYTES)} an archive is read up "
                    "to. Pass path.")
            with z.open(info) as src, open(dst_path, "wb") as dst:
                total = _copy_capped(src, dst, info.filename)
            # Declared against actual. A zip states each entry's size in its own
            # directory, so the two disagreeing means the archive is damaged,
            # and a short read would otherwise import as a truncated file.
            if total != info.file_size:
                raise ValueError(
                    f"{info.filename} says it is {info.file_size} bytes but "
                    f"{total} came out, so the archive is damaged.")
            return info.filename
    except zipfile.BadZipFile as ex:
        raise ValueError(f"the zip archive could not be read ({ex}). If the file "
                         'is not compressed, leave compression out.') from None


def _unpack(up):
    """Everything spooled, as one file the engine can open. Returns its path."""
    payload = os.path.join(up.dir, "payload")
    _decode_spool(up, payload)
    compression = up.compression
    if compression is None and up.sniff:
        compression = _sniff_compression(payload)
    final = os.path.join(up.dir, up.filename)

    if compression is None:
        os.replace(payload, final)
        return final
    if compression == "gzip":
        _gunzip(payload, final)
    else:
        inside = _unzip_one(payload, final, up.fmt, up.told_format)
        # Nobody named a format and the archive's own extension could not, so
        # the file inside is the only thing left that knows.
        if not up.told_format and _format_of(inside):
            up.fmt = _format_of(inside)
    os.remove(payload)
    return final


def _format_of(name):
    """The format an extension NAMES, or None when it names nothing we read.

    Kept apart from the guess below because the difference matters in one
    place: what to do about a plain `.zip`, whose own extension says nothing
    about its contents. Knowing that the name was silent is what makes reading
    the answer off the file inside it correct rather than a second guess.
    """
    ext = os.path.splitext(name)[1].lstrip(".").lower()
    ext = FORMAT_ALIASES.get(ext, ext)
    return ext if ext in IMPORT_FORMATS else None


def _import_format(path):
    """The format an extension implies.

    STEP is the fallback rather than an error, mirroring extToImportFormat in
    src/io/files.ts and for its reason: a STEP file is spelled .step, .stp, .STP
    and occasionally nothing recognisable, so a lookup table that refused what it
    did not know would turn the commonest import into the one that needs an
    argument. A file that is not one fails in the reader, which says so.
    """
    return _format_of(path) or "step"


def _unwrap_name(name):
    """(the name of the file inside, how it is wrapped) for a name that may be
    an archive. "asm.step.gz" is a STEP called asm.step; "asm.stpz" is one too,
    and has to be told so, because the zip took its extension away."""
    ext = os.path.splitext(name)[1].lstrip(".").lower()
    if ext not in ARCHIVE_SUFFIXES:
        return name, None
    compression, inside = ARCHIVE_SUFFIXES[ext]
    inner = os.path.splitext(name)[0]
    if inside and not _format_of(inner):
        inner += "." + inside
    return inner, compression


class Server:
    def __init__(self):
        self.doc = M.new_document()
        self.path = None
        self.link = SidecarLink.from_env()
        #: Set by `attach` when this server is working on the document a running
        #: app has open. None means the document here is private, which is what
        #: every tool below assumed before there was another option.
        self.live = None
        #: True once a tool has changed the PRIVATE document. It is what stops
        #: the re-probe below from pulling the rug out from under work already
        #: done here: adopting the app's document replaces this one, which is
        #: right when nothing has been built and destructive when something has.
        self.private_edits = False
        #: Uploads still arriving, by id. Empty except between the first piece
        #: of a file and its last.
        self.uploads = {}
        #: When the last re-probe ran, so a closed app costs one file stat per
        #: tool rather than one connect timeout (see _adopt_running_app).
        self._probed_at = 0.0
        #: The last successful build's per-body mesh, which is what `view`
        #: draws. Kept rather than re-requested: a render right after a build is
        #: the common case and the mesh is the expensive part of the reply.
        self.mesh = []
        self.built_for = None  # the document signature `self.mesh` belongs to
        self.tools = {}
        self._register()

    #: Prepended to the working-order instructions when this server is driving
    #: the document a person has open. It is the one thing about this mode a
    #: model has to know, because it changes what a mistake costs: there is no
    #: private copy to throw away, and the person is watching.
    LIVE_INSTRUCTIONS = """YOU ARE WORKING ON A DOCUMENT SOMEONE HAS OPEN IN FUNDACAD, right now, on their
screen. Every edit you make appears in their window as it happens.

  * Read before you write. Each tool re-reads their document first, so what you
    saw a moment ago may already have changed.
  * An edit is refused if they changed the model while you were writing it. That
    is not an error to retry blindly: read it again and decide again.
  * `doc_new` and `doc_open` REPLACE what they have open. Do not call either
    unless you were asked to.
  * `doc_save` writes their document to a file. It is not how your work reaches
    them; it is already there.

"""

    def instructions(self):
        """What the host puts in front of the model. Live mode adds a paragraph
        rather than replacing the working order, which is just as true either
        way."""
        if self.live is None:
            return S.HOW_TO
        return self.LIVE_INSTRUCTIONS + S.HOW_TO

    async def attach(self, mode=None):
        """Decide where the engine comes from, once, at start-up.

        Split out of __init__ because it does IO, it reads the session file and
        dials the port, and because a test wants a Server with neither.
        """
        link, app = await SidecarLink.for_mode(mode, log=log)
        self.link = link
        if app is not None:
            self.live = LiveLink(link)
            try:
                await self.live.pull()
                log(f"[mcp] sharing the open document: {self.live.title or 'untitled'}")
            except NoAppOpen as ex:
                # The engine is the app's but the WINDOW is not sharing. That is
                # the live-editing setting being off, and it is a state to stay
                # in rather than fail on: the agent still gets the app's engine,
                # and every tool that needs the document says why it cannot have
                # it. Failing here would make a setting the user can flip look
                # like a broken installation.
                log(f"[mcp] attached to the engine, but not to a document: {ex}")
        return self

    #: How long to leave between re-probes for a running app. The probe is a
    #: file read, and only dials a port when that file exists, so the usual cost
    #: is nothing at all. The interval is for the stale-file case, where the dial
    #: waits out its timeout and would otherwise do so on every single tool call.
    REPROBE_SECONDS = 3.0

    async def _adopt_running_app(self):
        """Attach to the app if it has appeared since start-up.

        `attach` runs once, at start-up, which is the wrong moment and the only
        one that was available to it. An MCP host starts its servers when the
        HOST starts, not when a conversation starts, so "is FundaCAD open?" got
        asked before the user had any reason to have opened it. Answering no
        then meant a private engine for the rest of the host's session, however
        long ago the app was opened, which reads exactly as the server refusing
        to use the app that is right there.

        So the question is asked again, while the answer can still change: only
        while private, only when nothing has been built here that adopting would
        discard, and no more often than REPROBE_SECONDS.
        """
        if self.live is not None or self.private_edits:
            return
        if mode_from_env() == "standalone":
            return  # configured to stay private, so do not go looking
        now = time.monotonic()
        if now - self._probed_at < self.REPROBE_SECONDS:
            return
        self._probed_at = now

        app = await app_session.find_running_app()
        if app is None:
            return
        link = SidecarLink(port=app["port"], token=app["token"])
        live = LiveLink(link)
        try:
            doc = await live.pull()
        except (NoAppOpen, OSError, RuntimeError, TimeoutError) as ex:
            # Found the engine, but the window is not sharing (the live-editing
            # setting), or it went away between the probe and the pull. Staying
            # private is the honest outcome; saying why is what stops it looking
            # like the connector is broken.
            log(f"[mcp] FundaCAD is open but not sharing a document: {ex}")
            return
        log(f"[mcp] FundaCAD opened since start-up (pid {app.get('pid')}), "
            f"switching to its engine on port {app['port']} and its open "
            f"document: {live.title or 'untitled'}")
        old = self.link
        self.link, self.live = link, live
        self.doc = doc or M.new_document()
        self.doc.setdefault("parameters", {})
        self.doc.setdefault("paramDefs", {})
        self._invalidate()
        # The private engine held an OCCT worker pool that nothing will ask for
        # again. Dropped after the swap, never before: a failure above has to
        # leave a working private session behind, not neither.
        with contextlib.suppress(Exception):
            await old.stop()

    #: Tools that change the document. Anything here is offered to the app when
    #: a live session is on; anything not here only reads, and a reader that
    #: proposed would put a no-op edit and an undo step in front of the user
    #: every time an agent measured something.
    MUTATORS = frozenset({
        "doc_new", "doc_open", "doc_import", "doc_set", "param_set", "param_remove",
        "feature_add", "feature_update", "feature_remove", "feature_move",
    })

    #: Tools that need no document at all, so they must not be made to wait for
    #: one. `schema` in particular is what an agent reads BEFORE anything exists.
    NO_DOCUMENT = frozenset({"schema"})

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

        add("doc_import",
            "Read an external geometry file (STEP, STL, 3MF, OBJ, BREP, GLB) into "
            "the timeline as a body, so it can be measured with `inspect` and "
            "modelled against. Use it when asked to fit something to a part that "
            "exists as a file. Give `path` if this machine can open the file, or "
            "`content` if you are holding the file itself (an upload, a sandbox) "
            "and have no path to give. Inline, gzip it and say so: a STEP file "
            "shrinks about tenfold, and what fits in one message is the limit "
            "worth spending. Too big for one message even so? Send it in pieces: "
            "encode the WHOLE file once, split the text that comes out, and send "
            "each piece with `part` and `parts`, quoting the `upload` id the "
            "first reply gives you. The format comes from the extension unless "
            "given. A large STEP can take minutes: it is one read, so do it once "
            "and keep the document.",
            {"path": {"type": "string",
                      "description": "a file on the machine FundaCAD runs on"},
             "content": {"type": "string",
                         "description": "the file itself, base64, when there is "
                                        "no path to give. One piece of it if "
                                        "`part` says so"},
             "encoding": {"type": "string", "enum": ["base64", "text"],
                          "description": "how `content` is encoded, base64 by "
                                         "default. A text format (STEP, OBJ, "
                                         "ASCII STL) can be sent as \"text\""},
             "compression": {"type": "string", "enum": ["gzip", "zip", "none"],
                             "description": "what `content` is wrapped in, "
                                            "before encoding. Implied by a name "
                                            "ending .gz, .zip or .stpz, and gzip "
                                            "is recognised on sight"},
             "name": {"type": "string",
                      "description": "what the file is called, e.g. \"bracket.step\" "
                                     "or \"bracket.step.gz\", which is where "
                                     "`content` gets its format and the body its "
                                     "name"},
             "part": {"type": "integer",
                      "description": "which piece this is, counting from 1"},
             "parts": {"type": "integer",
                       "description": "how many pieces there are altogether"},
             "upload": {"type": "string",
                        "description": "the id the first piece's reply gave you, "
                                       "required on every piece after it"},
             "format": {"type": "string", "enum": list(IMPORT_FORMATS),
                        "description": "override what the extension says"},
             "at": {"type": "integer",
                    "description": "timeline position, appended by default"}},
            [], self.t_doc_import)

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
            "sizes, and any feature that failed. Build often, an error names the "
            "feature that caused it.",
            {}, [], self.t_build)

        add("inspect",
            "Exact measurements of the built bodies: volume, area, bounding box, "
            "and, the part that matters, every face and edge with a ready-made "
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
                                        "middle), keep: which half survives, "
                                        "below|min|near or above|max|far "
                                        "(default below). Anything else is "
                                        "refused rather than guessed at.}"},
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
        # Absolute from here down. A relative path resolves against the SERVER's
        # working directory, which an MCP host chooses and which is rarely the
        # one the caller has in mind, so echoing back what was typed says
        # nothing about where the file actually is. Say where it is.
        path = os.path.abspath(args["path"])
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

    def _drop_upload(self, up):
        self.uploads.pop(up.id, None)
        shutil.rmtree(up.dir, ignore_errors=True)

    def _spool(self, args):
        """Take one piece of an inline file and return the upload it belongs to.

        Order is required rather than reassembled. Buffering out-of-order pieces
        would mean holding them until the gap filled, and a gap that never fills
        is indistinguishable from one that has not filled yet; refusing by name
        turns a lost piece into something the caller can act on immediately.
        """
        part, parts = args.get("part"), args.get("parts")
        if (part is None) != (parts is None):
            raise ValueError("part and parts go together: say which piece this "
                             "is and how many there are altogether.")
        if part is None:
            part = parts = 1
        for label, n in (("part", part), ("parts", parts)):
            if not isinstance(n, int) or isinstance(n, bool) or n < 1:
                raise ValueError(f"{label} must be a whole number from 1 up.")
        if part > parts:
            raise ValueError(f"part {part} of {parts} is more pieces in than "
                             "there are pieces.")

        if part == 1:
            self._sweep_uploads()
            up = Upload(args, parts)
            self.uploads[up.id] = up
        else:
            up = self.uploads.get(args.get("upload"))
            if up is None:
                raise ValueError(
                    "no upload is in progress under that id. Send part 1 again; "
                    "every piece after it has to quote the id the first reply "
                    "gave, and an upload nobody returns to is dropped after "
                    f"{UPLOAD_IDLE_SECONDS // 60} minutes.")
            if parts != up.parts:
                raise ValueError(f"this upload was announced as {up.parts} "
                                 f"pieces and part {part} says {parts}.")
            if part != up.got + 1:
                raise ValueError(f"expected part {up.got + 1} of {up.parts}, "
                                 f"got part {part}. The pieces have to arrive "
                                 "in order.")
        try:
            up.write(args["content"], part)
        except (ValueError, OSError):
            self._drop_upload(up)
            raise
        return up

    def _sweep_uploads(self):
        """Pieces nobody came back for."""
        stale = [u for u in self.uploads.values()
                 if time.monotonic() - u.touched > UPLOAD_IDLE_SECONDS]
        for up in stale:
            log(f"[mcp] dropping an unfinished upload of {up.name}")
            self._drop_upload(up)

    async def t_doc_import(self, args):
        """Read a geometry file into an `import` feature.

        Two steps, the same two the app's own import does (src/io/files.ts
        importPath): ask the engine to read the file, then put the fields it
        hands back into the timeline. The geometry itself never travels through
        here, `geom` is its content hash in the engine's durable blob store,
        which is why this stays a small reply for a file of any size and why
        that store has to be the one the app reads (see SidecarLink.start).

        The file arrives one of two ways. `path` is one this machine can already
        open. `content` is the bytes themselves, for an agent holding a file its
        host will not give a path to (an upload, its own sandbox), and they are
        written to a temporary file because the engine's importer opens a path
        and both processes are on this machine. That file goes as soon as the
        read returns: what the document keeps is `geom`, a hash into the blob
        store, so the bytes are already durable where it matters and a second
        copy of them would be litter that nothing would ever come back for.

        Inline, the two things that decide whether a real part fits are stacked
        on purpose. Compression is the bigger lever, a STEP file is text and
        gzips about tenfold, so it is the difference between one message and ten.
        Pieces are the other, because the ceiling on a single message is the
        model's output and not this process's memory. Together they are what
        makes a part that arrives as an upload importable at all.

        Everything before the last piece changes nothing: the document is
        untouched, which is what keeps a half-arrived file from reaching the
        app as an edit (see `_call_live`, which offers nothing when a tool
        changed nothing).
        """
        has_path, has_content = bool(args.get("path")), bool(args.get("content"))
        if has_path and has_content:
            return failure("Give path or content, not both.")
        if not has_path and not has_content:
            return failure("Give either path (a file this machine can open) or "
                           "content (the file itself, base64) with name.")

        up = None
        if has_path:
            path = source = os.path.abspath(args["path"])
            if not os.path.isfile(path):
                return failure(f"No such file: {path}")
            fmt = str(args.get("format") or _import_format(path)).lower()
            if fmt not in IMPORT_FORMATS:
                return failure(f"Cannot import {fmt!r} files. "
                               f"Formats: {', '.join(IMPORT_FORMATS)}.")
        else:
            try:
                up = self._spool(args)
            except ValueError as ex:
                return failure(str(ex))
            if up.got < up.parts:
                return text(
                    f"Part {up.got} of {up.parts} received, {_mib(up.spooled)} "
                    f"of {up.name} so far. Send part {up.got + 1} with "
                    f'upload="{up.id}". Nothing is imported until the last piece.')
            try:
                path = _unpack(up)
            except (ValueError, OSError) as ex:
                self._drop_upload(up)
                return failure(f"Could not read what was sent: {ex}")
            # Provenance, not a path. The temporary file is about to be gone, and
            # recording it would send whoever read the field back to nothing.
            fmt, source = up.fmt, up.name

        try:
            reply = await self.link.call("import", path=path, format=fmt)
        finally:
            if up is not None:
                self._drop_upload(up)
        if not reply.get("ok"):
            # The engine refuses for reasons an agent can act on (too large, too
            # many triangles, unreadable), so its message is the whole answer and
            # is passed through rather than summarised.
            return failure("Import failed: "
                           + (reply.get("error") or {}).get("message", "unreadable file"))
        res = reply.get("result") or {}
        if not res.get("geom"):
            return failure(f"The engine read {source} but returned no geometry.")

        feature = {
            "type": "import",
            "format": fmt,
            "name": res.get("name") or os.path.splitext(os.path.basename(source))[0],
            "geom": res["geom"],
            "source": source,
            "solid": bool(res.get("solid")),
        }
        # Spread, not defaulted, exactly as the app's import does: a file with no
        # colour and no assembly tree must produce the feature it always did,
        # and `null` is a different thing from absent to everything downstream.
        for key in ("color", "nodes", "parts"):
            if res.get(key) is not None:
                feature[key] = res[key]

        fid = M.add_feature(self.doc, feature, args.get("at"))
        self._invalidate()
        kind = "solid" if feature["solid"] else "surface body (not a solid)"
        parts = f", {len(res['parts'])} parts" if res.get("parts") else ""
        return text(self._state_line(
            f"Imported {source} as {fid}: {feature['name']!r}, {kind}, "
            f"{res.get('faces', '?')} faces{parts}.\n"
            "Run `build`, then `inspect` for its sizes and the selectors that "
            "address its faces and edges."))

    async def t_doc_save(self, args):
        path = args.get("path") or self.path
        if not path:
            return failure("No path given and this document has never been saved.")
        path = os.path.abspath(path)
        M.recompute_parameters(self.doc)
        parent = os.path.dirname(path)
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
        # `featureErrors`, NOT `errors`. A feature that fails is recorded as a
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
            # The side actually kept, resolved the same way the renderer
            # resolves it, not the word that was passed in: this line used to
            # say "keeping max" over a picture that had kept the other half.
            side = "above" if R.KEEP_WORDS.get(
                str(sec.get("keep", "below")).strip().lower()) else "below"
            cut = (f", cut on {sec.get('axis', 'X')} at "
                   f"{sec.get('at', 'the middle')}, keeping {side}")
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
        gets no reply at all, which is not an oversight, replying to one is a
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
                "instructions": self.instructions(),
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

    async def _call_live(self, tool, name, args):
        """One tool, against the document a running app has open.

        Mirror in, mirror out. The pull before makes the local document the
        app's, so the tool sees what the user sees rather than whatever this
        process last built; the push after offers the result, and does not return
        until the app has taken it. The tools themselves know none of this.

        A tool that fails leaves nothing to offer, which is why the push is
        after the `isError` check rather than in a `finally`: proposing a
        half-applied document would put the failure in front of the user as an
        edit.
        """
        try:
            self.doc = await self.live.pull() or M.new_document()
            self.doc.setdefault("parameters", {})
            self.doc.setdefault("paramDefs", {})
        except NoAppOpen as ex:
            return failure(f"{ex}")

        # No _invalidate here, deliberately. `t_view` already asks whether the
        # cached mesh belongs to the document in hand (`built_for !=
        # _signature(self.doc)`), and that check answers "the user changed it
        # under us" as well as it answers "we changed it". Dropping the mesh on
        # every pull would make the ordinary `build` then `view` pair rebuild
        # twice, which in live mode is every single render.
        before = copy.deepcopy(self.doc)
        out = await tool.fn(args)

        if name not in self.MUTATORS or out.get("isError"):
            return out
        if self.doc == before:
            return out  # the tool decided to change nothing; nothing to offer

        try:
            rev = await self.live.push(self.doc, note=_edit_note(name, args))
        except (NoAppOpen, ReadOnlySession, StaleEdit, TimeoutError, RuntimeError) as ex:
            # The local document now holds an edit the app never took. Put it
            # back, or the next tool would build on a change that does not exist
            # anywhere else and the agent would have no way to notice. The mesh
            # cache needs no help: it is keyed on the document's signature, which
            # this restores along with the document.
            self.doc = before
            return failure(f"{ex}")
        return _append(out, f"\n(applied in FundaCAD, revision {rev})")

    async def call_tool(self, name, args):
        """A tool's own failure is a RESULT with isError, not a JSON-RPC error.

        The distinction matters: a JSON-RPC error means the call was malformed
        and the model cannot learn anything from it, while isError puts the
        message in front of the model as something to react to. Almost
        everything that goes wrong here, a bad selector, an impossible fillet,
        a sketch that does not close, is the second kind."""
        tool = self.tools.get(name)
        if tool is None:
            return failure(f"No tool {name!r}. Have: {', '.join(sorted(self.tools))}")
        with contextlib.suppress(Exception):
            # Never fatal to a tool call: working privately is a worse answer
            # than working on the open document, but it is a working one.
            await self._adopt_running_app()
        try:
            if self.live is not None and name not in self.NO_DOCUMENT:
                return await self._call_live(tool, name, args)
            if name in self.MUTATORS:
                self.private_edits = True
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
    server = server or await Server().attach()
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
        # Pieces of a file nobody finished sending. Not a substitute for the
        # sweep, which is what covers the case that actually happens: a host
        # kills its servers with TerminateProcess, and no finally runs then.
        for up in list(getattr(server, "uploads", {}).values()):
            server._drop_upload(up)
        if server.live is not None:
            await server.live.leave()
        await server.link.stop()


def _stdout_line(s):
    print(s, flush=True)  # stdout IS the protocol: nothing else may write here


async def _stdin_lines():
    """stdin, read on a thread.

    Not asyncio's connect_read_pipe: on Windows the proactor loop cannot take a
    console stdin and the selector loop cannot take a pipe, and a blocking
    readline on the default executor works on every platform. It costs nothing,
    this process spends its life waiting on one pipe or the other."""
    loop = asyncio.get_running_loop()
    return lambda: loop.run_in_executor(None, sys.stdin.readline)


async def _main():
    await serve(await _stdin_lines(), _stdout_line)


def main():
    """The entry point, and the one place a start-up refusal is phrased.

    `FUNDACAD_MCP_MODE=attach` with no app open raises on purpose. A traceback
    would say the same thing in twenty lines of a log the user may never open,
    so it is caught and stated once, stderr is what an MCP host shows."""
    try:
        asyncio.run(_main())
    except RuntimeError as ex:
        log(f"[mcp] {ex}")
        sys.exit(1)


if __name__ == "__main__":
    main()
