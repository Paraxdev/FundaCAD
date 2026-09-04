"""Does the geometry engine die with the server that started it?

This is not housekeeping. Each session spawns a sidecar, which spawns a worker
holding a loaded OCCT; an MCP host kills its servers with TerminateProcess,
which runs no cleanup. Measured while driving the server from a script before
this was fixed: 53 python processes left behind, after which a fresh sidecar
could not start its own worker and every build failed with "the geometry engine
could not start on this computer" — an error about the machine, from a machine
that had been fine an hour earlier.

So the test kills the OWNER the way a host would, with no chance to clean up,
and asks whether the sidecar is still there. The control is the same run with
the job object switched off, which must leave it alive — otherwise this would
pass on a platform where something else happens to be reaping the process, and
prove nothing.

Windows only. Linux gets PR_SET_PDEATHSIG and macOS polls getppid(), both inside
the sidecar itself and both already covered by its own tests; the job object
exists because Windows has neither and the app's Rust shell is the only other
thing that supplies one.

Run: uv run python mcp/tests/test_lifetime.py
"""

import _bootstrap  # noqa: F401
import _run

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MCP = os.path.dirname(HERE)

#: The child process: start a sidecar, say what its pid is, and wait to be
#: killed. `job` decides whether the kill-on-close job object is used at all,
#: which is the only difference between the case and its control.
OWNER = r'''
import asyncio, os, sys
sys.path.insert(0, r"{mcp}")
import sidecar_link
if not {job}:
    class _NoJob:
        available = False
        def adopt(self, pid): return False
        def close(self): pass
    sidecar_link.ProcessJob = _NoJob

async def main():
    link = sidecar_link.SidecarLink()
    # A real rebuild, so the pool worker exists: the worker is what actually
    # leaks. It is the sidecar's child, it holds the loaded OCCT, and on Windows
    # the sidecar's own die-with-parent is a no-op, so terminating the sidecar
    # orphans it.
    await link.call("rebuild", document={{"parameters": {{}}, "features": [
        {{"id": "b", "type": "box", "length": 10, "width": 10, "height": 10}}]}},
        revision=1, tolerance=0.1)
    print("PID", link.proc.pid, flush=True)
    await asyncio.sleep(600)

asyncio.run(main())
'''


def alive(pid):
    out = subprocess.run(["tasklist", "/FI", f"PID eq {int(pid)}", "/NH"],
                         capture_output=True, text=True).stdout
    return str(pid) in out


def children(pid):
    """The pids whose parent is `pid`. The sidecar's worker pool is what leaks,
    and it is one level down from the process this test can name."""
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Get-CimInstance Win32_Process -Filter 'ParentProcessId={int(pid)}' "
         "| Select-Object -ExpandProperty ProcessId"],
        capture_output=True, text=True).stdout
    return [int(x) for x in out.split() if x.strip().isdigit()]


def run_case(job):
    """Start an owner, kill it hard, and report whether the sidecar outlived it."""
    code = OWNER.format(mcp=MCP.replace("\\", "/"), job="True" if job else "False")
    owner = subprocess.Popen([sys.executable, "-c", code],
                             stdout=subprocess.PIPE, text=True)
    try:
        pid = None
        deadline = time.time() + 180
        while time.time() < deadline:
            line = owner.stdout.readline()
            if not line:
                break
            if line.startswith("PID"):
                pid = int(line.split()[1])
                break
        assert pid is not None, "the owner never reported a sidecar pid"
        assert alive(pid), "the sidecar was not running before the kill"
        tree = [pid] + children(pid)
        assert len(tree) > 1, "the sidecar had no worker to leak — nothing to measure"
        # TerminateProcess on the OWNER only: no /T, so nothing sweeps the tree
        # and nothing in the owner gets to run. This is what a host does.
        subprocess.run(["taskkill", "/F", "/PID", str(owner.pid)], capture_output=True)
        owner.wait(timeout=30)
        for _ in range(80):
            left = [p for p in tree if alive(p)]
            if not left:
                return tree, []
            time.sleep(0.25)
        return tree, [p for p in tree if alive(p)]
    finally:
        if owner.poll() is None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(owner.pid)],
                           capture_output=True)


def test_the_sidecar_dies_when_its_owner_is_killed_outright():
    if sys.platform != "win32":
        print("not Windows — the sidecar's own PR_SET_PDEATHSIG/getppid cover this")
        return
    tree, left = run_case(job=True)
    assert not left, f"{left} outlived the process that started them (tree was {tree})"
    print(f"the whole engine tree {tree} died with its owner OK")


def test_the_control_without_a_job_object_leaks():
    """Without the job object the sidecar MUST survive. If it does not, something
    else on this machine is reaping it and the test above proves nothing."""
    if sys.platform != "win32":
        print("not Windows — skipped with the case above")
        return
    tree, left = run_case(job=False)
    try:
        assert left, (f"the engine tree {tree} died even with no job object — the "
                      "test above is not measuring what it claims")
        print(f"{left} of {tree} leaked without a job object, as expected")
    finally:
        for p in tree:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(p)], capture_output=True)


if __name__ == "__main__":
    _run.run(globals(), "process lifetime")
