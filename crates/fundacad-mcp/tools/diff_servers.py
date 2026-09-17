"""Both MCP servers, one script, and the differences between their replies.

`crates/fundacad-mcp` is a port of `plugins/FundaCAD.MCP`, and the thing that
makes a port right is not that its own tests pass, it is that the two answer the
same question the same way. So this drives a scripted session through each and
prints, per call, the first line on which they disagree.

    python crates/fundacad-mcp/tools/diff_servers.py scripts/spool.jsonl
    python crates/fundacad-mcp/tools/diff_servers.py --tools

A script is what `plugins/FundaCAD.MCP/client.py --script` takes: one JSON array
of `{"tool": ..., "args": {...}}`, or one such object per line.

Both servers are started PRIVATE (`FUNDACAD_MCP_MODE=standalone` and a session
file that cannot exist), so neither can find a running app and edit the document
somebody has open. Each spawns its own geometry engine, so the two are compared
on the same kernel only when both find the same one; the Python server spawns
`sidecar/server.py` and the Rust one spawns `fundacad-engine`, and geometry
numbers can therefore differ in the last digits. Everything that is not a
measurement should match word for word.

This is a migration tool. When the sidecar is deleted, so is the server on the
left of the comparison, and so is this.
"""

import asyncio
import difflib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))
PY_MCP = os.path.join(ROOT, "plugins", "FundaCAD.MCP")
sys.path.insert(0, PY_MCP)

from client import McpClient, _load_script  # noqa: E402


def rust_binary():
    """The built `fundacad-mcp`, from the environment or the workspace target."""
    named = os.environ.get("FUNDACAD_MCP_BIN")
    if named and os.path.isfile(named):
        return named
    name = "fundacad-mcp.exe" if sys.platform == "win32" else "fundacad-mcp"
    for profile in ("debug", "release"):
        candidate = os.path.join(ROOT, "target", profile, name)
        if os.path.isfile(candidate):
            return candidate
    raise SystemExit("cargo build -p fundacad-mcp first, or set FUNDACAD_MCP_BIN")


def private_env():
    """No running app, on either side. A comparison run that attached would be
    editing somebody's open document twice."""
    return {
        "FUNDACAD_MCP_MODE": "standalone",
        "FUNDACAD_SESSION_FILE": os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "no-app-in-a-diff.json"),
    }


async def replies(server, script):
    out = []
    async with McpClient(server=server, env=private_env()) as c:
        if script is None:
            out.append(("tools/list", json.dumps(
                [{k: t.get(k) for k in ("name", "description", "inputSchema")}
                 for t in sorted(await c.tools(), key=lambda t: t["name"])],
                indent=1, sort_keys=True), False))
            return out
        for step in script:
            r = await c.call(step["tool"], step.get("args") or {})
            out.append((step["tool"], r["text"], r["isError"]))
    return out


async def run(script):
    left = await replies(os.path.join(PY_MCP, "server.py"), script)
    right = await replies(rust_binary(), script)
    differences = 0
    for i, (a, b) in enumerate(zip(left, right)):
        name = a[0]
        if a[1:] == b[1:]:
            print(f"ok    {i:>3} {name}")
            continue
        differences += 1
        print(f"DIFF  {i:>3} {name}"
              + ("  (isError differs)" if a[2] != b[2] else ""))
        for line in difflib.unified_diff(
                a[1].splitlines(), b[1].splitlines(),
                fromfile="python", tofile="rust", lineterm=""):
            print("      " + line)
    if len(left) != len(right):
        differences += 1
        print(f"DIFF  the two runs answered {len(left)} and {len(right)} calls")
    print(f"{len(left)} calls, {differences} differences")
    return 1 if differences else 0


def main():
    argv = sys.argv[1:]
    script = None
    if argv and argv[0] != "--tools":
        script = _load_script(argv[0])
    sys.exit(asyncio.run(run(script)))


if __name__ == "__main__":
    main()
