"""Cold import-to-payload benchmark for a large STEP.

Runs, in a fresh process with empty blob and geometry caches, exactly what the
app does when a file is imported: `import_geometry`, then the worker rebuild and
the per-body payload loop (`server._rebuild_job`). Prints a per-phase breakdown.

  sidecar/.venv/Scripts/python.exe sidecar/tools/bench_import.py path/to/file.step
  sidecar/.venv/Scripts/python.exe sidecar/tools/bench_import.py file.step --profile 40
  sidecar/.venv/Scripts/python.exe sidecar/tools/bench_import.py file.step --record sv08

Phases nest: `tessellate` includes `display_face`, `rebuild` includes
`import_shape`, `bind_assembly`, `update_owners` and the checkpoint writes.
`--record NAME` stores the result under NAME in tools/bench/import_baseline.json.
"""

import argparse
import json
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.dirname(HERE)
BASELINE = os.path.join(HERE, "bench", "import_baseline.json")


def _timed(acc, key, fn):
    def wrapper(*a, **kw):
        t0 = time.perf_counter()
        try:
            return fn(*a, **kw)
        finally:
            acc[key] = acc.get(key, 0.0) + time.perf_counter() - t0
            acc[key + "#"] = acc.get(key + "#", 0) + 1
    return wrapper


def _patch(acc, module, name, key=None):
    setattr(module, name, _timed(acc, key or name.lstrip("_"), getattr(module, name)))


def single_run(path, profile_top=0):
    tmp = tempfile.mkdtemp(prefix="fundacad-bench-")
    os.environ["XDG_CACHE_HOME"] = os.path.join(tmp, "cache")
    os.environ["FUNDACAD_BLOB_DIR"] = os.path.join(tmp, "blobs")
    sys.path.insert(0, SIDECAR)
    try:
        import occt_smp
        occt_smp.configure()

        import builder
        import face_bands
        import mesh_import
        import rebuild_cache
        import server
        import step_assembly
        import tessellate

        acc = {}
        _patch(acc, mesh_import, "_canonicalize")
        _patch(acc, mesh_import, "_shape_to_blob")
        _patch(acc, builder, "_import_shape")
        _patch(acc, builder, "_bind_assembly")
        _patch(acc, builder, "_update_owners")
        _patch(acc, builder, "_persist_tick")
        _patch(acc, builder, "_save_checkpoint")
        _patch(acc, tessellate, "tessellate")
        _patch(acc, tessellate, "_display_face")
        _patch(acc, tessellate, "edge_polylines_by_body", "edges")
        _patch(acc, face_bands, "face_bands")
        _patch(acc, server, "_parallel_payloads")
        _patch(acc, server, "_moved_payload")
        _patch(acc, server, "_compute_payload")

        prof = None
        if profile_top:
            import cProfile
            prof = cProfile.Profile()
            prof.enable()

        t0 = time.perf_counter()
        res = mesh_import.import_geometry(path, "step")
        t_import = time.perf_counter() - t0

        doc = {"parameters": {}, "features": [{
            "id": "im", "type": "import", "format": "step", "name": res["name"],
            "geom": res["geom"], "solid": res["solid"],
            **({"nodes": res["nodes"]} if res.get("nodes") else {}),
            **({"parts": res["parts"]} if res.get("parts") else {}),
        }]}
        t1 = time.perf_counter()
        orig_rebuild = builder.rebuild_cached
        rebuild_s = {}

        def rebuild_cached(*a, **kw):
            t = time.perf_counter()
            try:
                return orig_rebuild(*a, **kw)
            finally:
                rebuild_s["s"] = time.perf_counter() - t
        builder.rebuild_cached = rebuild_cached
        result = server._rebuild_job(doc, server._DEFAULT_TOLERANCE)
        t_job = time.perf_counter() - t1

        t2 = time.perf_counter()
        blob = pickle.dumps(result, 5)
        t_pickle = time.perf_counter() - t2

        if prof is not None:
            prof.disable()

        bodies = result.get("bodies") or []
        tris = sum(len(b.get("indices") or ()) // 3 for b in bodies)
        out = {
            "file": os.path.basename(path),
            "total_s": round(time.perf_counter() - t0, 2),
            "import_s": round(t_import, 2),
            **{k + "_s": round(v, 2) for k, v in step_assembly.last_timings.items()},
            "rebuild_s": round(rebuild_s.get("s", 0.0), 2),
            "payloads_s": round(t_job - rebuild_s.get("s", 0.0), 2),
            "pickle_s": round(t_pickle, 2),
            "pickle_mib": round(len(blob) / (1 << 20), 1),
            "bodies": len(bodies),
            "faces": res.get("faces"),
            "tris": tris,
            "phases": {k: (round(v, 2) if isinstance(v, float) else v)
                       for k, v in sorted(acc.items())},
        }
        if prof is not None:
            import io
            import pstats
            s = io.StringIO()
            pstats.Stats(prof, stream=s).sort_stats("tottime").print_stats(profile_top)
            out["profile"] = s.getvalue()
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--profile", type=int, default=0, metavar="TOP")
    ap.add_argument("--record", metavar="NAME")
    ap.add_argument("--single", action="store_true", help="internal: run in this process")
    args = ap.parse_args()
    path = os.path.abspath(args.path)

    if args.single:
        out = single_run(path, args.profile)
        profile = out.pop("profile", None)
        if profile:
            print(profile, file=sys.stderr)
        print(json.dumps(out))
        return 0

    cmd = [sys.executable, os.path.abspath(__file__), "--single", path]
    if args.profile:
        cmd += ["--profile", str(args.profile)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.stderr:
        sys.stderr.write(r.stderr)
    for ln in r.stdout.splitlines():
        if ln.startswith("[rebuild]"):
            print(ln, file=sys.stderr)
    lines = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
    if r.returncode != 0 or not lines:
        print(f"run crashed (exit {r.returncode})", file=sys.stderr)
        return 2
    out = json.loads(lines[-1])
    print(json.dumps(out, indent=1))
    if args.record:
        base = {}
        if os.path.exists(BASELINE):
            with open(BASELINE, encoding="utf-8") as f:
                base = json.load(f)
        base.setdefault(args.record, []).append(
            {"at": time.strftime("%Y-%m-%d %H:%M"), **out})
        os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
        with open(BASELINE, "w", encoding="utf-8") as f:
            json.dump(base, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
