"""A small MCP client, so the server can be driven without an MCP host.

Two jobs, and the second is the reason it is in the repository rather than in a
scratch directory:

  * the end-to-end test needs a client. Testing the tools by calling their
    coroutines directly would skip the protocol, and the protocol is where a
    stray print to stdout or a notification answered with a reply breaks
    everything, silently, only under a real host.

  * a person (or an agent with a shell and no MCP host) can drive the server
    from a terminal:

        python mcp/client.py schema '{"type": "revolve"}'
        python mcp/client.py build
        python mcp/client.py --script build.jsonl

    Each invocation is a FRESH server with an EMPTY document, so a sequence of
    one-shot calls is not a session — use --script, which sends a whole list of
    calls down one connection.

Images come back as base64 and are written to files rather than printed: a PNG
on a terminal is noise, and a path is something to open.
"""

import asyncio
import base64
import contextlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOCOL = "2025-06-18"


class McpClient:
    """One server subprocess, spoken to over its stdio."""

    def __init__(self, python=None, server=None, env=None):
        self.python = python or sys.executable
        self.server = server or os.path.join(HERE, "server.py")
        self.env = env
        self.proc = None
        self._id = 0

    async def __aenter__(self):
        await self.start()
        return self

    async def __aexit__(self, *exc):
        await self.stop()

    async def start(self):
        env = dict(os.environ)
        if self.env:
            env.update(self.env)
        self.proc = await asyncio.create_subprocess_exec(
            # The CALLER's directory, not this file's. The server resolves a
            # relative `path` against its own working directory, so launching it
            # in `mcp/` made `doc_save "part.funda"` land inside the repository
            # while the person who typed it watched their own directory stay
            # empty. It does not need to be here: server.py puts its own
            # directory on sys.path itself.
            self.python, self.server, cwd=os.getcwd(), env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=None,  # inherit: the server's diagnostics belong on OUR stderr
        )
        await self.request("initialize", {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "fundacad-cli", "version": "0.1.0"},
        })
        self.notify("notifications/initialized")

    async def stop(self):
        """Close stdin, wait, and CLOSE THE TRANSPORT.

        The last part is not tidiness. Without it the proactor loop on Windows
        finalises the subprocess transport during interpreter shutdown, by which
        time the pipes are gone, and every run ends in two pages of
        "I/O operation on closed pipe" from __del__ — noise that buries whatever
        the run was actually reporting."""
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            proc.stdin.close()
            await asyncio.wait_for(proc.wait(), 30)
        except Exception:
            with contextlib.suppress(Exception):
                proc.kill()
                await proc.wait()
        finally:
            transport = getattr(proc, "_transport", None)
            if transport is not None:
                with contextlib.suppress(Exception):
                    transport.close()
            await asyncio.sleep(0)  # let the loop actually run the close

    def _send(self, obj):
        self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    async def request(self, method, params=None):
        self._id += 1
        mid = self._id
        self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                raise RuntimeError("the MCP server closed its output")
            msg = json.loads(line)
            if msg.get("id") != mid:
                continue  # a notification or a stale reply; not ours
            if "error" in msg:
                raise RuntimeError(f"{method}: {msg['error'].get('message')}")
            return msg.get("result")

    async def tools(self):
        return (await self.request("tools/list"))["tools"]

    async def call(self, name, args=None):
        """The tool's result. Text blocks are joined; image blocks are returned
        separately as raw bytes, because nothing sensible can be done with a
        base64 PNG in the middle of a paragraph."""
        res = await self.request("tools/call", {"name": name, "arguments": args or {}})
        parts = res.get("content") or []
        out = "\n".join(p["text"] for p in parts if p.get("type") == "text")
        images = [base64.b64decode(p["data"]) for p in parts if p.get("type") == "image"]
        return {"text": out, "images": images, "isError": bool(res.get("isError"))}


def _load_script(path):
    """A script file, as either one JSON array or one call per line.

    Both, because a call with a sketch in it does not fit on a line anybody
    wants to read, and JSON-lines is what makes a long script diffable. The
    array form is tried first: a file that parses whole is unambiguous."""
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, list):
            return loaded
        if isinstance(loaded, dict):
            return [loaded]
    except json.JSONDecodeError:
        pass
    out = []
    for n, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as ex:
            raise SystemExit(f"{path}:{n}: {ex}. A call must fit on one line, "
                             "or the whole file must be one JSON array.")
    return out


async def _run(argv):
    script = None
    if argv and argv[0] == "--script":
        script = _load_script(argv[1])
        argv = argv[2:]
    out_dir = os.getcwd()

    async with McpClient() as c:
        if script is None:
            if not argv:
                for t in await c.tools():
                    print(f"{t['name']:16} {t['description'].splitlines()[0]}")
                return 0
            script = [{"tool": argv[0], "args": json.loads(argv[1]) if len(argv) > 1 else {}}]
        failed = 0
        for i, step in enumerate(script):
            r = await c.call(step["tool"], step.get("args") or {})
            print(f"--- {step['tool']} {'FAILED' if r['isError'] else ''}")
            print(r["text"])
            failed += bool(r["isError"])
            for k, png in enumerate(r["images"]):
                path = os.path.join(out_dir, f"view-{i}-{k}.png")
                with open(path, "wb") as fh:
                    fh.write(png)
                print(f"[image written to {path}]")
        return 1 if failed else 0


def main():
    sys.exit(asyncio.run(_run(sys.argv[1:])))


if __name__ == "__main__":
    main()
