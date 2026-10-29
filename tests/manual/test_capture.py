"""The capture tool's manifests, its GIF encoder and the order of a run.

    python3 tests/manual/test_capture.py

No browser or engine: a run's retakes are replaced by a stand-in that writes the file.
"""

import contextlib
import io
import json
import random
import re
import struct
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "manual" / "tools" / "capture"
sys.path.insert(0, str(TOOL))

import capture  # noqa: E402
import gif  # noqa: E402


def entries():
    for area in capture.AREAS:
        with open(TOOL / "manifests" / f"{area}.toml", "rb") as f:
            for shot in tomllib.load(f)["shot"]:
                yield area, shot


def picture_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return struct.unpack("<HH", data[6:10])
    i = 2
    while i < len(data):
        marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    raise ValueError(f"no size in {path}")


def picture_refs(text: str) -> list[tuple[str, str]]:
    """(path, alt) of every Markdown image and HTML img in a page."""
    refs = re.findall(r"!\[([^\]]*)\]\(([^)\s]+)", text)
    found = [(src, alt) for alt, src in refs]
    for tag in re.findall(r"<img\b[^>]*>", text):
        src = re.search(r'src="([^"]+)"', tag)
        alt = re.search(r'alt="([^"]*)"', tag)
        if src:
            found.append((src.group(1), alt.group(1) if alt else ""))
    return found


class Manifests(unittest.TestCase):
    def test_every_use_is_a_page_that_shows_the_picture_with_its_alt(self):
        wrong = []
        for area, shot in entries():
            name = Path(shot["file"]).name
            for use in shot["uses"]:
                page = REPO / use
                if not page.is_file():
                    wrong.append(f"{area}: {use} is not a file")
                    continue
                text = page.read_text(encoding="utf-8")
                alts = [alt for src, alt in picture_refs(text) if Path(src).name == name]
                if name not in text:
                    wrong.append(f"{area}: {use} never names {name}")
                elif "alt" in shot and shot["alt"] not in alts:
                    wrong.append(f"{area}: {use} shows {name} as {alts}, the manifest says {shot['alt']!r}")
        self.assertEqual(wrong, [])

    def test_every_manual_and_readme_picture_has_one_entry(self):
        listed = [shot["file"] for _, shot in entries()]
        on_disk = sorted(
            p.relative_to(REPO).as_posix()
            for folder in ("manual/docs/img", "assets/readme")
            for p in (REPO / folder).iterdir()
            if p.suffix in (".png", ".gif", ".jpg")
        )
        self.assertEqual([f for f in on_disk if f not in listed], [])
        self.assertEqual(sorted(f for f in listed if listed.count(f) > 1), [])

    def test_every_entry_has_the_size_of_its_file(self):
        wrong = {
            shot["file"]: (picture_size(REPO / shot["file"]), tuple(shot["size"]))
            for _, shot in entries()
            if picture_size(REPO / shot["file"]) != tuple(shot["size"])
        }
        self.assertEqual(wrong, {})

    def test_no_two_retaken_entries_share_a_file_name_for_out(self):
        names = [Path(shot["file"]).name for _, shot in entries() if shot.get("crop") != "copy"]
        self.assertEqual(sorted(n for n in set(names) if names.count(n) > 1), [])

    def test_a_copy_is_taken_from_another_entry(self):
        files = {shot["file"] for _, shot in entries()}
        copies = {shot["file"]: shot["from"] in files for _, shot in entries() if shot.get("crop") == "copy"}
        self.assertEqual(copies, {f: True for f in copies})

    def test_the_fixtures_are_at_the_current_format_version(self):
        migrate = (REPO / "src" / "document" / "migrate.ts").read_text(encoding="utf-8")
        current = int(re.search(r"export const FORMAT_VERSION = (\d+);", migrate).group(1))
        versions = {
            p.name: json.loads(p.read_text(encoding="utf-8"))["version"] for p in (TOOL / "fixtures").glob("*.json")
        }
        self.assertEqual(versions, {name: current for name in versions})


def lzw_decode(data: bytes, min_size: int) -> bytes:
    clear, end = 1 << min_size, (1 << min_size) + 1
    table = [bytes([i]) for i in range(clear)] + [b"", b""]
    size, prev, out = min_size + 1, None, bytearray()
    bits, pos = int.from_bytes(data, "little"), 0
    while pos + size <= len(data) * 8:
        code = (bits >> pos) & ((1 << size) - 1)
        pos += size
        if code == clear:
            table, size, prev = table[: clear + 2], min_size + 1, None
            continue
        if code == end:
            break
        if prev is None:
            entry = table[code]
        else:
            entry = table[code] if code < len(table) else prev + prev[:1]
            table.append(prev + entry[:1])
            if len(table) == 1 << size and size < 12:
                size += 1
        out += entry
        prev = entry
    return bytes(out)


def decode_gif(path: Path) -> tuple[tuple[int, int], list[tuple[bytes, int]], int]:
    """The canvas after each frame as RGB, with its delay in centiseconds, and the loop count."""
    data = path.read_bytes()
    assert data[:6] == b"GIF89a"
    w, h, flags = struct.unpack("<HHB", data[6:11])
    i = 13
    palette = data[i:i + 3 * (2 << (flags & 7))] if flags & 0x80 else b""
    i += len(palette)
    canvas = bytearray(w * h * 3)
    frames, delay, transparent, loop = [], 0, None, None
    while data[i] != 0x3B:
        if data[i] == 0x21:
            label, i = data[i + 1], i + 2
            body = bytearray()
            while data[i]:
                body += data[i + 1:i + 1 + data[i]]
                i += 1 + data[i]
            i += 1
            if label == 0xF9:
                delay = struct.unpack("<H", body[1:3])[0]
                transparent = body[3] if body[0] & 1 else None
            elif label == 0xFF and body[:11] == b"NETSCAPE2.0":
                loop = struct.unpack("<H", body[12:14])[0]
            continue
        x0, y0, fw, fh, local = struct.unpack("<HHHHB", data[i + 1:i + 10])
        assert not local & 0x80
        min_size, i = data[i + 10], i + 11
        lzw = bytearray()
        while data[i]:
            lzw += data[i + 1:i + 1 + data[i]]
            i += 1 + data[i]
        i += 1
        indices = lzw_decode(bytes(lzw), min_size)
        assert len(indices) == fw * fh, (len(indices), fw, fh)
        for n, index in enumerate(indices):
            if index != transparent:
                at = ((y0 + n // fw) * w + x0 + n % fw) * 3
                canvas[at:at + 3] = palette[index * 3:index * 3 + 3]
        frames.append((bytes(canvas), delay))
    return (w, h), frames, loop


def rgba(pixels) -> bytes:
    return b"".join(bytes((r, g, b, 255)) for r, g, b in pixels)


def rgb(pixels) -> bytes:
    return b"".join(bytes(p) for p in pixels)


class Gif(unittest.TestCase):
    def round_trip(self, w, h, frames, loop=0):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.gif"
            gif.write_gif(path, [(w, h, rgba(px), delay) for px, delay in frames], loop=loop)
            return decode_gif(path)

    def test_noise_of_200_colours_over_several_table_resets_decodes_exactly(self):
        rnd = random.Random(7)
        colours = [(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(200)]
        first = [rnd.choice(colours) for _ in range(96 * 96)]
        second = list(first)
        for n in range(30 * 96 + 20, 30 * 96 + 60):
            second[n] = rnd.choice(colours)
        size, frames, loop = self.round_trip(96, 96, [(first, 100), (second, 250)], loop=3)
        self.assertEqual((size, frames, loop), ((96, 96), [(rgb(first), 10), (rgb(second), 25)], 3))

    def test_one_pixel_decodes_exactly(self):
        self.assertEqual(self.round_trip(1, 1, [([(9, 8, 7)], 100)]), ((1, 1), [(rgb([(9, 8, 7)]), 10)], 0))

    def test_one_flat_colour_decodes_exactly(self):
        px = [(40, 50, 60)] * (32 * 20)
        self.assertEqual(self.round_trip(32, 20, [(px, 100)]), ((32, 20), [(rgb(px), 10)], 0))

    def test_255_colours_decode_exactly(self):
        px = [(c, 255 - c, (c * 7) % 256) for c in range(255)] * 3
        self.assertEqual(self.round_trip(255, 3, [(px, 100)]), ((255, 3), [(rgb(px), 10)], 0))

    def test_a_repeated_frame_is_merged_into_the_one_before(self):
        a = [(10, 20, 30)] * 64
        b = list(a)
        b[27] = (200, 100, 0)
        size, frames, _ = self.round_trip(8, 8, [(a, 100), (a, 300), (b, 100)])
        self.assertEqual((size, frames), ((8, 8), [(rgb(a), 40), (rgb(b), 10)]))


class Run(unittest.TestCase):
    """A run in a repo of its own, where a retake writes "new" over the file."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        manifests = self.repo / "manifests"
        manifests.mkdir()
        (manifests / "render.toml").write_text(
            '[[shot]]\nfile = "img/a.png"\ncrop = "region"\n'
            '[[shot]]\nfile = "img/s.png"\nstub = true\n'
            '[[shot]]\nfile = "img/k.png"\ncrop = "keep"\n',
            encoding="utf-8",
        )
        (manifests / "readme-design.toml").write_text(
            '[[shot]]\nfile = "assets/a.png"\ncrop = "copy"\nfrom = "img/a.png"\n'
            '[[shot]]\nfile = "assets/b.png"\ncrop = "copy"\nfrom = "img/a.png"\n',
            encoding="utf-8",
        )
        (self.repo / "img").mkdir()
        (self.repo / "img" / "a.png").write_bytes(b"old")
        for patch in (
            mock.patch.object(capture, "REPO", self.repo),
            mock.patch.object(capture, "MANIFESTS", manifests),
            mock.patch.object(capture, "AREAS", ("readme-design", "render")),
            mock.patch.object(capture, "take_live", self.retake),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    @staticmethod
    def retake(live, args, frames_root):
        for shot in live:
            out = capture.target_path(shot, args.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"new")
        return list(live)

    def run_main(self, *argv):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed), contextlib.redirect_stderr(io.StringIO()):
            code = capture.main(list(argv))
        return code, printed.getvalue().splitlines()

    def test_a_copy_in_the_repo_is_taken_from_the_retaken_picture(self):
        code, lines = self.run_main("--area", "all")
        copies = [(self.repo / f).read_bytes() for f in ("assets/a.png", "assets/b.png")]
        self.assertEqual((code, copies, lines[-1]), (0, [b"new", b"new"], "1 taken, 0 failed, 1 still a stub, 1 kept, 2 copied"))

    def test_a_copy_in_the_out_folder_is_taken_from_the_retaken_picture_there(self):
        out = self.repo / "out"
        code, lines = self.run_main("--area", "all", "--out", str(out))
        written = {p.name: p.read_bytes() for p in out.iterdir()}
        self.assertEqual(
            (code, written, (self.repo / "img" / "a.png").read_bytes(), lines[-1]),
            (0, {"a.png": b"new", "b.png": b"new"}, b"old", "1 taken, 0 failed, 1 still a stub, 1 kept, 2 copied"),
        )

    def test_a_copy_whose_picture_is_not_retaken_is_taken_from_the_repo(self):
        code, lines = self.run_main("--area", "readme-design")
        copies = [(self.repo / f).read_bytes() for f in ("assets/a.png", "assets/b.png")]
        self.assertEqual((code, copies, lines[-1]), (0, [b"old", b"old"], "0 taken, 0 failed, 0 still a stub, 0 kept, 2 copied"))

    def test_asking_for_a_stub_by_name_fails_the_run(self):
        code, lines = self.run_main("--area", "render", "--only", "s")
        self.assertEqual((code, lines[-1]), (1, "0 taken, 0 failed, 1 still a stub, 0 kept, 0 copied"))

    def test_asking_for_a_name_no_manifest_has_fails_the_run(self):
        code, lines = self.run_main("--area", "render", "--only", "k,nothing")
        self.assertEqual((code, lines[-1]), (1, "0 taken, 0 failed, 0 still a stub, 1 kept, 0 copied"))

    def test_a_failed_retake_fails_the_run_and_is_counted(self):
        with mock.patch.object(capture, "take_live", lambda live, args, frames_root: []):
            code, lines = self.run_main("--area", "render")
        self.assertEqual((code, lines[-1]), (1, "0 taken, 1 failed, 1 still a stub, 1 kept, 0 copied"))


class Shoot(unittest.TestCase):
    """shoot with a fake session that records what it tried, and a take that fails as each test says."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.frames = Path(tmp.name)
        self.args = mock.Mock(engine=None, settle_timeout=1, out=self.frames / "out")
        self.sessions = []
        self.fails = {}
        self.stalls = set()
        self.broken = 0
        test = self

        class Page:
            drawing = True

            def evaluate(self, js):
                return self.drawing if js == capture.DRAWING else None

            def screenshot(self, path, timeout):
                raise RuntimeError("no screen")

        class FakeSession:
            def __init__(self, gpu, **kwargs):
                if test.broken:
                    test.broken -= 1
                    test.sessions.append((gpu, "did not open"))
                    raise RuntimeError("no browser")
                self.page = Page()
                self.tried = []
                test.sessions.append((gpu, self.tried))

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def take(s, shot, out, frames_root):
            name = capture.name_of(shot)
            s.tried.append(name)
            if test.fails.get(name):
                test.fails[name] -= 1
                s.page.drawing = name not in test.stalls
                raise capture.ShotError("did not settle")
            return ""

        self.FakeSession = FakeSession
        patch = mock.patch.object(capture, "take", take)
        patch.start()
        self.addCleanup(patch.stop)

    def shoot(self, *names, gpu=()):
        live = [{"file": f"img/{n}.png", "crop": "region", "gpu": n in gpu} for n in names]
        with contextlib.redirect_stdout(io.StringIO()):
            failed = capture.shoot(live, self.args, self.frames, self.FakeSession, "http://vite")
        return [capture.name_of(x) for x in failed], self.sessions

    def test_every_entry_is_taken_in_one_session_per_renderer(self):
        self.assertEqual(self.shoot("a", "b", "g", gpu=("g",)), ([], [(False, ["a", "b"]), (True, ["g"])]))

    def test_a_failure_on_a_page_that_still_draws_goes_on_and_is_taken_again_in_a_new_session(self):
        self.fails = {"a": 1}
        self.assertEqual(self.shoot("a", "b"), ([], [(False, ["a", "b"]), (False, ["a"])]))

    def test_a_page_that_stopped_drawing_leaves_the_rest_for_the_new_session(self):
        self.fails, self.stalls = {"a": 1}, {"a"}
        self.assertEqual(self.shoot("a", "b", "c"), ([], [(False, ["a"]), (False, ["a", "b", "c"])]))

    def test_an_entry_that_fails_twice_is_failed_and_not_tried_a_third_time(self):
        self.fails = {"b": 5}
        self.assertEqual(self.shoot("a", "b"), (["b"], [(False, ["a", "b"]), (False, ["b"])]))

    def test_a_session_that_does_not_open_is_opened_once_more(self):
        self.broken = 1
        self.assertEqual(self.shoot("a"), ([], [(False, "did not open"), (False, ["a"])]))

    def test_two_sessions_that_do_not_open_fail_their_entries(self):
        self.broken = 2
        self.assertEqual(self.shoot("a", "b"), (["a", "b"], [(False, "did not open"), (False, "did not open")]))


if __name__ == "__main__":
    unittest.main()
