// Native frames over the loopback WebSocket, received by a real Chromium page.
//
//   1. 30 stamped 1080p RGBA8 frames arrive whole and in order in under 1 s.
//   2. A connection without the launch token is refused.
//
// Not Playwright on purpose: with a DevTools client attached Chrome mirrors
// every WebSocket frame's payload to it, about 40 ms per 8 MB frame, which
// alone breaks the bound. Chrome opens a file page directly and the page
// reports back over the socket.
//
// Usage (from the repo root):
//   cargo build --release --example frames_serve --manifest-path src-tauri/frames/Cargo.toml
//   SC_CHROME=<chromium or chrome> node e2e/frames_ws_e2e.cjs
// SC_FRAMES_SERVE points at the example if CARGO_TARGET_DIR moved it.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const target = process.env.CARGO_TARGET_DIR || path.join(__dirname, "..", "src-tauri", "target");
const SERVE = process.env.SC_FRAMES_SERVE
  || path.join(target, "release", "examples", process.platform === "win32" ? "frames_serve.exe" : "frames_serve");
const TOKEN = crypto.randomBytes(16).toString("hex");

(async () => {
  const srv = spawn(SERVE, [TOKEN], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = [];
  let waiters = [];
  let buf = "";
  srv.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
      waiters.forEach((w) => w());
    }
  });
  const line = (test, ms) => new Promise((ok) => {
    const look = () => { const l = lines.find(test); if (l !== undefined) { waiters = waiters.filter((w) => w !== look); ok(l); } };
    waiters.push(look);
    look();
    setTimeout(() => ok(null), ms);
  });
  const port = await line((l) => /^\d+$/.test(l), 10000);
  if (!port) { console.error("frames_serve printed no port"); srv.kill(); process.exit(1); }
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "frames-e2e-"));
  const url = pathToFileURL(path.join(__dirname, "frames_ws_page.html")).href + `?port=${port}&token=${TOKEN}`;
  const args = ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${prof}`];
  if (process.platform === "linux") args.push("--no-sandbox");
  const chrome = spawn(EXE, [...args, url], { stdio: "ignore" });
  const got = await line((l) => l.startsWith("NOTE RESULT "), 30000);
  chrome.kill();
  srv.kill();
  setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} }, 1500);
  const res = got ? JSON.parse(got.slice("NOTE RESULT ".length)) : { error: "the page never reported" };
  console.log(JSON.stringify(res));
  const fails = [];
  if (!res.refused) fails.push("a connection without the token was accepted");
  if (res.ok !== 30) fails.push(`${res.ok ?? 0} of 30 frames arrived whole and in order`);
  if (!(res.ms < 1000)) fails.push(`30 frames took ${res.ms ?? "forever"} ms, the bound is 1000`);
  fails.forEach((f) => console.error("FAIL " + f));
  if (!fails.length) console.log("PASS frames over WebSocket");
  process.exitCode = fails.length ? 1 : 0;
})();
