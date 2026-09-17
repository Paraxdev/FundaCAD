"""Dump the documents the Python test suites build inline to JSON fixtures, so the
fundacad-core round-trip tests cover them without Python.

Every sidecar and plugin geometry test file is loaded in its own process with
`builder.rebuild` wrapped to record the document it is handed. Each zero-argument
`test_*` function is then called, failures ignored, since only the documents
matter. Results are deduplicated and written to tests/fixtures/<suite>.json.

    D:/dev/neocad/sidecar/.venv/Scripts/python.exe crates/fundacad-core/tests/gen_fixtures.py
"""

import concurrent.futures
import glob
import hashlib
import inspect
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
OUT = os.path.join(HERE, "fixtures")

# Network and process tests start servers, their documents never reach an
# in-process rebuild.
SKIP = {
    "test_ws.py", "test_cancel.py", "test_conn_limit.py", "test_heartbeat.py",
    "test_stale_worker.py", "test_pool_init.py", "test_live_session.py",
    "test_sysmem.py", "test_appenv.py", "test_font_guard.py",
}
SUITES = {
    "sidecar_tests": "sidecar/tests/test_*.py",
    "plugin_tests": "plugins/*/geometry/tests/test_*.py",
}
MAX_DOC_BYTES = 48_000
MAX_SUITE_BYTES = 900_000
TIMEOUT_S = 300


def child(test_file, out_path):
    tests_dir = os.path.dirname(test_file)
    sys.path.insert(0, tests_dir)
    sys.path.insert(0, os.path.join(REPO, "sidecar"))
    os.chdir(tests_dir)
    import builder

    current = {"name": ""}
    seen = set()
    sink = open(out_path, "a", encoding="utf8")

    def record(document):
        try:
            text = json.dumps(document, allow_nan=False, sort_keys=True)
        except (TypeError, ValueError):
            return
        if text in seen:
            return
        seen.add(text)
        sink.write(json.dumps({"source": current["name"], "doc": json.loads(text)}) + "\n")
        sink.flush()

    def wrap(fn):
        def inner(document, *a, **k):
            record(document)
            return fn(document, *a, **k)
        return inner

    builder.rebuild = wrap(builder.rebuild)
    builder.rebuild_cached = wrap(builder.rebuild_cached)

    import runpy
    try:
        ns = runpy.run_path(test_file, run_name="fixture_capture")
    except BaseException:
        return
    for name, fn in list(ns.items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            if inspect.signature(fn).parameters:
                continue
        except (TypeError, ValueError):
            continue
        current["name"] = f"{os.path.relpath(test_file, REPO).replace(os.sep, '/')}::{name}"
        try:
            fn()
        except BaseException:
            pass


def scrub(text):
    """No machine paths in committed fixtures."""
    for p in {os.path.expanduser("~"), tempfile.gettempdir(), REPO}:
        for form in {p, p.replace("\\", "/"), p.replace("\\", "\\\\")}:
            text = re.sub(re.escape(form), "/scrubbed", text, flags=re.IGNORECASE)
    return text


def run_suite(suite, pattern):
    files = sorted(f for f in glob.glob(os.path.join(REPO, pattern)) if os.path.basename(f) not in SKIP)
    tmp = tempfile.mkdtemp(prefix="fcore_fixtures_")

    def one(f):
        out = os.path.join(tmp, hashlib.md5(f.encode()).hexdigest() + ".jsonl")
        try:
            subprocess.run([sys.executable, __file__, "--child", f, out], timeout=TIMEOUT_S,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            print(f"  timeout, kept what was captured: {os.path.basename(f)}")
        return f, out

    rows, keys = [], set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for f, out in pool.map(one, files):
            if not os.path.exists(out):
                continue
            with open(out, encoding="utf8") as fh:
                for line in fh:
                    row = json.loads(scrub(line))
                    key = json.dumps(row["doc"], sort_keys=True)
                    if key in keys or len(key) > MAX_DOC_BYTES:
                        continue
                    keys.add(key)
                    rows.append(row)
    rows.sort(key=lambda r: (r["source"], len(json.dumps(r["doc"]))))
    kept, total = [], 0
    for r in rows:
        size = len(json.dumps(r["doc"], separators=(",", ":")))
        if total + size > MAX_SUITE_BYTES:
            continue
        kept.append(r)
        total += size
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{suite}.json"), "w", encoding="utf8", newline="\n") as fh:
        fh.write("[\n")
        fh.write(",\n".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) for r in kept))
        fh.write("\n]\n")
    print(f"{suite}: {len(kept)} documents ({total} bytes) from {len(files)} files, {len(rows) - len(kept)} dropped for size")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--child":
        child(sys.argv[2], sys.argv[3])
    else:
        for suite, pattern in SUITES.items():
            run_suite(suite, pattern)
