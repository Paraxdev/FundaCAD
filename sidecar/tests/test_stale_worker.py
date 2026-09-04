"""A worker running code this package no longer contains.

A worker process imports every module in sidecar/ ONCE, at spawn, and then lives
for the rest of the session. Edit a file after that and the code on disk and the
code doing the work disagree, silently and for as long as the process lives. It
is not a subtle failure once you see it, but there is nothing to see: the fix is
in the file, the error is still in the app, and the only way to establish which
is which is to compare a file's mtime against a process's start time.

Measured on this repo the day this was written. A boolean fix landed at 21:09;
the app, whose worker had started at 20:49, went on reporting the bug the fix
removed, with the corrected source sitting on disk the whole time.

So the pool carries a stamp of the sources it was built from and retires itself
when they change. The control that keeps that honest is the first test: an
untouched tree must cost nothing, because a check that fires when nothing
happened would respawn the kernel on every single request.

Run:  uv run python test_stale_worker.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import os
import shutil
import sys
import tempfile
import time
import traceback
from concurrent.futures import ProcessPoolExecutor

import server


def _probe():
    """Trivial task: force the lazy spawn without paying for build123d."""
    return True


def _init_ok(err_buf=None):
    return None


class Fake:
    """Stands in for the pool _new_pool would have built, so a test can ask
    whether a respawn was decided on without paying for a real OCCT import."""

    def __init__(self):
        self.gen = None


def _reset():
    server._pool = None
    server._pool_gen = -1
    server._warm = None
    server._failed_gens = set()
    server._reaped_gens = set()
    server._ever_came_up = False
    server._env_broken = False
    server._pool_src = None


def _light_pool():
    """A real worker process with none of the geometry: enough to prove the
    recycle actually kills something."""
    server._pool_gen += 1
    pool = ProcessPoolExecutor(max_workers=1, mp_context=server._mp_ctx,
                               initializer=_init_ok, initargs=(None,))
    pool.submit(_probe).result(timeout=60)
    server._pool = pool
    return pool


def _workers(pool):
    """The worker Process OBJECTS, not their pids.

    is_alive() is the portable liveness test. os.kill(pid, 0) is not one on
    Windows: any signal other than CTRL_C_EVENT / CTRL_BREAK_EVENT goes to
    TerminateProcess, so the probe kills what it was asked to ask about and then
    reports it alive.
    """
    return list(getattr(pool, "_processes", {}).values())


class tree:
    """A directory of .py files standing in for sidecar/, so no test ever has to
    write into the package it is testing."""

    def __enter__(self):
        self.dir = tempfile.mkdtemp()
        self.real = server._SIDECAR_DIR
        server._SIDECAR_DIR = self.dir
        self.write("alpha.py", "x = 1\n")
        self.write("beta.py", "y = 2\n")
        return self

    def __exit__(self, *exc):
        server._SIDECAR_DIR = self.real
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, text):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    def path(self, name):
        return os.path.join(self.dir, name)


def test_an_untouched_tree_costs_nothing():
    """The control, and the one that matters most. If this ever fails, every
    request respawns the geometry kernel and the app is unusable."""
    _reset()
    with tree():
        pool = _light_pool()
        server._pool_src = server._src_stamp()
        gen = server._pool_gen
        workers = _workers(pool)
        for _ in range(3):
            assert server._pool_available() is None
            assert server._pool is pool, "an untouched tree respawned the worker"
            assert server._pool_gen == gen, "an untouched tree bumped the pool"
            assert all(w.is_alive() for w in workers), "the worker was killed anyway"
        pool.shutdown(wait=False)
    print("ok  an untouched tree leaves the worker alone")


def test_editing_a_source_file_retires_the_worker_that_imported_it():
    _reset()
    made = []
    with tree() as t:
        pool = _light_pool()
        server._pool_src = server._src_stamp()
        gen = server._pool_gen
        workers = _workers(pool)
        assert workers, "no worker to retire"

        server._new_pool, real = (lambda: (made.append(1), Fake())[1]), server._new_pool
        try:
            t.write("alpha.py", "x = 1  # the fix\n")
            assert server._pool_available() is None
            assert made, "the edit did not reach a respawn"
            assert not isinstance(server._pool, ProcessPoolExecutor)
        finally:
            server._new_pool = real

        # the old worker is really gone, not merely dropped on the floor
        deadline = time.time() + 10
        while time.time() < deadline and any(w.is_alive() for w in workers):
            time.sleep(0.05)
        alive = [w.pid for w in workers if w.is_alive()]
        assert not alive, f"worker {alive} outlived the recycle"
        assert gen in server._reaped_gens, "a deliberate retire counted as a crash"
    print("ok  an edited source file retires the worker that imported it")


def test_a_second_edit_within_the_filesystem_clock_is_still_seen():
    """Why the stamp carries size and not just mtime: a coarse clock — FAT, a
    network share, an OS that rounds to the second — hands two edits made in
    quick succession the same timestamp, and mtime alone would call the second
    one no change at all."""
    _reset()
    with tree() as t:
        before = server._src_stamp()
        p = t.path("alpha.py")
        st = os.stat(p)
        t.write("alpha.py", "x = 1  # longer than it was\n")
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))  # same mtime, exactly
        after = server._src_stamp()
        assert os.stat(p).st_mtime_ns == st.st_mtime_ns, "the clock was not pinned"
        assert after != before, "an edit that kept its mtime went unnoticed"
    print("ok  an edit that keeps its timestamp is still seen")


def test_a_tree_with_no_python_in_it_is_not_watched():
    """The packaged app: modules frozen into the executable, no .py on disk. The
    check has to fall silent there rather than recycle on every request because
    it can never find what it is looking for."""
    _reset()
    with tree() as t:
        for name in os.listdir(t.dir):
            os.remove(t.path(name))
        assert server._src_stamp() is None, "an empty tree produced a stamp"

        pool = _light_pool()
        server._pool_src = None  # what _new_pool would have stored there
        gen = server._pool_gen
        t.write("appeared.py", "z = 3\n")
        assert server._pool_available() is None
        assert server._pool is pool and server._pool_gen == gen
        pool.shutdown(wait=False)
    print("ok  a tree with no sources in it is not watched")


def test_a_missing_directory_is_not_a_crash():
    """_src_stamp runs before every job. It cannot be the thing that takes the
    server down when the directory is unreadable."""
    _reset()
    assert server._src_stamp(os.path.join(tempfile.gettempdir(), "no-such-dir-here")) is None
    print("ok  an unreadable directory reads as nothing to watch")


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            print(f"FAIL {name}")
            failed += 1
    print("stale worker:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
