"""Starting and stopping what a session owns: its engine and its vite server."""

from __future__ import annotations

import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .errors import LaunchError

EXE = "fundacad-engine.exe" if os.name == "nt" else "fundacad-engine"
STRIP_PREFIXES = ("FUNDACAD_", "SINDRI_", "SINDRICAD_")
EXIT_PORT_IN_USE = 3


def find_repo(repo: str | os.PathLike | None = None, start: Path | None = None) -> Path:
    if repo:
        return Path(repo).resolve()
    if os.environ.get("FUNDACAD_REPO"):
        return Path(os.environ["FUNDACAD_REPO"]).resolve()
    for base in (start or Path.cwd(), Path(__file__).resolve().parent):
        for d in (base, *base.parents):
            if (d / "package.json").is_file() and (d / "src-tauri").is_dir():
                return d
    raise LaunchError("cannot find the FundaCAD checkout, pass repo= or set FUNDACAD_REPO")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def split_command(text: str) -> list[str]:
    """Same rules as the MCP server's FUNDACAD_ENGINE_CMD: quotes group, no escapes."""
    out: list[str] = []
    cur = ""
    quote = None
    any_quote = False
    for ch in text:
        if quote:
            if ch == quote:
                quote = None
            else:
                cur += ch
        elif ch in "\"'":
            quote = ch
            any_quote = True
        elif ch.isspace():
            if any_quote or cur:
                out.append(cur)
                cur, any_quote = "", False
        else:
            cur += ch
    if any_quote or cur:
        out.append(cur)
    return out


def find_engine(repo: Path, engine: str | os.PathLike | None = None, env: dict | None = None) -> list[str]:
    env = os.environ if env is None else env
    if engine:
        parts = split_command(str(engine)) if isinstance(engine, str) else [str(engine)]
        if not parts or not Path(parts[0]).is_file():
            raise LaunchError(f"engine {engine} is not a file")
        return parts
    cmd = env.get("FUNDACAD_ENGINE_CMD", "").strip()
    if cmd:
        parts = split_command(cmd)
        if parts and Path(parts[0]).is_file():
            return parts
    found: list[Path] = []
    target = env.get("CARGO_TARGET_DIR")
    for root in ([Path(target)] if target else []) + [repo / "target"]:
        hits = [root / p / EXE for p in ("debug", "release") if (root / p / EXE).is_file()]
        if hits:
            found.append(max(hits, key=lambda p: p.stat().st_mtime))
            break
    if found:
        return [str(found[0])]
    on_path = shutil.which("fundacad-engine")
    if on_path:
        return [on_path]
    raise LaunchError("no engine found, build one with cargo build -p fundacad-cli or set FUNDACAD_ENGINE_CMD")


def newest_source(repo: Path) -> float:
    newest = 0.0
    for p in (repo / "crates").glob("*/src/**/*.rs"):
        try:
            newest = max(newest, p.stat().st_mtime)
        except OSError:
            pass
    return newest


def stale_warning(engine: list[str], repo: Path) -> str | None:
    try:
        built = Path(engine[0]).stat().st_mtime
    except OSError:
        return None
    if newest_source(repo) > built:
        return "engine is older than the source, rebuild with cargo build -p fundacad-cli"
    return None


def engine_env(base: dict, port: int, token: str, vite_port: int, work: Path, repo: Path) -> dict:
    env = {k: v for k, v in base.items() if not k.upper().startswith(STRIP_PREFIXES)}
    env.update(
        FUNDACAD_ENGINE_PORT=str(port),
        FUNDACAD_ENGINE_TOKEN=token,
        FUNDACAD_EXTRA_ORIGINS=f"http://127.0.0.1:{vite_port},http://localhost:{vite_port}",
        FUNDACAD_BLOB_DIR=str(work / "blobs"),
        XDG_CACHE_HOME=str(work / "cache"),
        FUNDACAD_PLUGIN_DIR=str(repo / "plugins"),
    )
    return env


def _group_flags() -> dict:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


_job: int | None = None


def _kill_with_us(popen: subprocess.Popen) -> None:
    """On Windows the children join a job that dies with this Python, even a TerminateProcess
    of it, which is what a shell tool's timeout sends and no atexit hook outlives."""
    global _job
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    if _job is None:

        class Basic(ctypes.Structure):
            _fields_ = [("user_time", ctypes.c_int64), ("job_time", ctypes.c_int64), ("flags", wintypes.DWORD),
                        ("min_ws", ctypes.c_size_t), ("max_ws", ctypes.c_size_t), ("procs", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", ctypes.c_uint64 * 6), ("proc_mem", ctypes.c_size_t),
                        ("job_mem", ctypes.c_size_t), ("peak_proc_mem", ctypes.c_size_t), ("peak_job_mem", ctypes.c_size_t)]

        job = k32.CreateJobObjectW(None, None)
        info = Extended()
        info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not job or not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            return
        _job = job
    k32.AssignProcessToJobObject(wintypes.HANDLE(_job), wintypes.HANDLE(int(popen._handle)))


@dataclass
class Proc:
    """A child this session started, and only that child is ever stopped."""

    name: str
    popen: subprocess.Popen
    log: Path
    ready: threading.Event = field(default_factory=threading.Event)
    lines: list[str] = field(default_factory=list)

    @property
    def pid(self) -> int:
        return self.popen.pid

    def alive(self) -> bool:
        return self.popen.poll() is None

    def tail(self, n: int = 20) -> str:
        try:
            text = self.log.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        return "\n".join(text.splitlines()[-n:])

    def stop(self) -> None:
        if not self.alive():
            return
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.pid)], capture_output=True)
        else:
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            try:
                self.popen.wait(5)
                return
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    return
        try:
            self.popen.wait(10)
        except subprocess.TimeoutExpired:
            pass


def spawn(name: str, cmd: list[str], cwd: Path, env: dict, log: Path, ready_prefix: str | None = None) -> Proc:
    log.parent.mkdir(parents=True, exist_ok=True)
    out = open(log, "w", encoding="utf-8", errors="replace")
    popen = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        **_group_flags(),
    )
    _kill_with_us(popen)
    proc = Proc(name, popen, log)

    def pump() -> None:
        assert popen.stdout is not None
        for line in popen.stdout:
            out.write(line)
            out.flush()
            if len(proc.lines) < 200:
                proc.lines.append(line.rstrip())
            if ready_prefix and line.startswith(ready_prefix):
                proc.ready.set()
        out.close()

    threading.Thread(target=pump, name=f"{name}-log", daemon=True).start()
    return proc


def wait_ready(proc: Proc, timeout: float) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if proc.ready.wait(0.1):
            return
        if not proc.alive():
            raise LaunchError(f"{proc.name} exited with code {proc.popen.returncode}", proc.tail())
    proc.stop()
    raise LaunchError(f"{proc.name} did not get ready in {int(timeout)} s", proc.tail())


def start_engine(cmd: list[str], repo: Path, work: Path, vite_port: int, timeout: float = 60) -> tuple[Proc, int, str]:
    token = secrets.token_hex(16)
    for attempt in range(2):
        port = free_port()
        env = engine_env(dict(os.environ), port, token, vite_port, work, repo)
        proc = spawn("engine", [*cmd, "--ws"], repo, env, work / "engine.log", ready_prefix="LISTENING")
        try:
            wait_ready(proc, timeout)
            return proc, port, token
        except LaunchError:
            if attempt == 0 and proc.popen.returncode == EXIT_PORT_IN_USE:
                continue
            raise
    raise AssertionError("unreachable")


def http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def start_vite(repo: Path, work: Path, timeout: float = 60) -> tuple[Proc, int]:
    vite = repo / "node_modules" / "vite" / "bin" / "vite.js"
    if not vite.is_file():
        raise LaunchError(f"no {vite}, run npm ci in {repo}")
    real = (repo / "node_modules").resolve()
    if real.name != "node_modules":
        raise LaunchError(f"{repo / 'node_modules'} links to {real}, node resolves packages only from a folder"
                          " named node_modules, so link to one of that name")
    node = shutil.which("node")
    if not node:
        raise LaunchError("node is not on PATH")
    for attempt in range(2):
        port = free_port()
        proc = spawn("vite", [node, str(vite), "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
                     repo, dict(os.environ), work / "vite.log")
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if http_ok(f"http://127.0.0.1:{port}/"):
                return proc, port
            if not proc.alive():
                break
            time.sleep(0.25)
        proc.stop()
        if attempt == 0 and "in use" in proc.tail().lower():
            continue
        raise LaunchError(f"vite did not answer on port {port} in {int(timeout)} s", proc.tail())
    raise AssertionError("unreachable")


def python_info() -> str:
    return f"Python {sys.version.split()[0]} at {sys.executable}"
