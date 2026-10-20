import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from fundacad_harness import launch
from fundacad_harness.browser import find_chrome
from fundacad_harness.errors import LaunchError

FAKE = Path(__file__).with_name("fake_engine.py")


def test_free_port_can_be_bound():
    port = launch.free_port()
    with socket.socket() as s:
        s.bind(("127.0.0.1", port))


def test_split_command_groups_quotes_like_the_mcp_server():
    assert launch.split_command('"C:/Program Files/e.exe" --engine') == ["C:/Program Files/e.exe", "--engine"]
    assert launch.split_command("  a  'b c'  ''") == ["a", "b c", ""]


def touch(p: Path, mtime: float | None = None) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("x")
    if mtime:
        os.utime(p, (mtime, mtime))
    return p


def test_engine_discovery_order(tmp_path):
    repo = tmp_path / "repo"
    old = touch(repo / "target" / "release" / launch.EXE, time.time() - 100)
    new = touch(repo / "target" / "debug" / launch.EXE)
    assert launch.find_engine(repo, env={}) == [str(new)]
    os.utime(new, (time.time() - 200, time.time() - 200))
    assert launch.find_engine(repo, env={}) == [str(old)]
    custom = touch(tmp_path / "ct" / "debug" / launch.EXE)
    assert launch.find_engine(repo, env={"CARGO_TARGET_DIR": str(tmp_path / "ct")}) == [str(custom)]
    cmd = touch(tmp_path / "cmd" / "eng.exe")
    env = {"CARGO_TARGET_DIR": str(tmp_path / "ct"), "FUNDACAD_ENGINE_CMD": f'"{cmd}" --engine'}
    assert launch.find_engine(repo, env=env) == [str(cmd), "--engine"]
    arg = touch(tmp_path / "arg.exe")
    assert launch.find_engine(repo, engine=arg, env=env) == [str(arg)]
    with pytest.raises(LaunchError):
        launch.find_engine(repo, engine=tmp_path / "missing.exe", env=env)


def test_engine_env_strips_inherited_keys_and_sets_its_own(tmp_path):
    base = {"PATH": "p", "FUNDACAD_MCP_MODE": "attach", "SINDRI_X": "1", "sindricad_y": "2", "HOME": "h"}
    env = launch.engine_env(base, 9001, "tok", 5999, tmp_path, tmp_path / "repo")
    assert env["PATH"] == "p" and env["HOME"] == "h"
    assert "FUNDACAD_MCP_MODE" not in env and "SINDRI_X" not in env and "sindricad_y" not in env
    assert env["FUNDACAD_ENGINE_PORT"] == "9001"
    assert env["FUNDACAD_ENGINE_TOKEN"] == "tok"
    assert env["FUNDACAD_EXTRA_ORIGINS"] == "http://127.0.0.1:5999,http://localhost:5999"
    assert env["FUNDACAD_BLOB_DIR"] == str(tmp_path / "blobs")
    assert env["XDG_CACHE_HOME"] == str(tmp_path / "cache")
    assert env["FUNDACAD_PLUGIN_DIR"] == str(tmp_path / "repo" / "plugins")


def test_stale_engine_warning(tmp_path):
    eng = touch(tmp_path / "eng.exe", time.time() - 100)
    src = touch(tmp_path / "crates" / "a" / "src" / "lib.rs")
    assert launch.stale_warning([str(eng)], tmp_path) is not None
    os.utime(src, (time.time() - 500, time.time() - 500))
    assert launch.stale_warning([str(eng)], tmp_path) is None


def wait_line(proc, prefix: str) -> None:
    deadline = time.time() + 10
    while not any(line.startswith(prefix) for line in proc.lines) and time.time() < deadline:
        time.sleep(0.05)


def test_start_engine_waits_for_the_ready_line(tmp_path):
    proc, port, token = launch.start_engine([sys.executable, str(FAKE)], tmp_path, tmp_path, 5999, timeout=30)
    try:
        assert proc.alive()
        assert len(token) == 32
        wait_line(proc, "TOKEN_SEEN")
        assert f"TOKEN_SEEN {token}" in proc.lines
        assert f"LISTENING {port}" in proc.lines
    finally:
        proc.stop()
    assert not proc.alive()


def test_start_engine_retries_once_on_port_in_use(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_BUSY_ONCE", str(tmp_path / "busy"))
    proc, _, _ = launch.start_engine([sys.executable, str(FAKE)], tmp_path, tmp_path, 5999, timeout=30)
    proc.stop()
    assert (tmp_path / "busy").exists()


def test_a_dead_engine_reports_its_log(tmp_path):
    with pytest.raises(LaunchError) as e:
        launch.start_engine([sys.executable, "-c", "print('boom'); raise SystemExit(1)"], tmp_path, tmp_path, 5999, timeout=30)
    assert "exited with code 1" in str(e.value)
    assert "boom" in e.value.log_tail


def test_stop_kills_only_its_own_child(tmp_path):
    sleeper = [sys.executable, "-c", "import time; time.sleep(600)"]
    other = subprocess.Popen(sleeper)
    try:
        mine = launch.spawn("sleeper", sleeper, tmp_path, dict(os.environ), tmp_path / "s.log")
        assert mine.alive()
        mine.stop()
        assert not mine.alive()
        assert other.poll() is None
    finally:
        other.kill()
        other.wait()


def test_chrome_discovery_order(tmp_path):
    a = touch(tmp_path / "a" / "chrome")
    b = touch(tmp_path / "b" / "chrome")
    assert find_chrome(env={"FUNDACAD_CHROME": str(a), "SC_CHROME": str(b)}) == str(a)
    assert find_chrome(env={"SC_CHROME": str(b)}) == str(b)
    assert find_chrome(chrome=b, env={"FUNDACAD_CHROME": str(a)}) == str(b)
    with pytest.raises(LaunchError):
        find_chrome(chrome=tmp_path / "none")


def test_repo_is_found_by_walking_up(tmp_path, monkeypatch):
    monkeypatch.delenv("FUNDACAD_REPO", raising=False)
    touch(tmp_path / "package.json")
    (tmp_path / "src-tauri").mkdir()
    deep = tmp_path / "x" / "y"
    deep.mkdir(parents=True)
    assert launch.find_repo(start=deep) == tmp_path
