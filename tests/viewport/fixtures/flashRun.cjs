// Node side of tests/viewport/pathtraceFlash*.test.ts, in CommonJS as the test programs have no node types.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { capLogFile } = require("../../../e2e/lib/flash.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "e2e/pathtrace_flash_e2e.cjs");
const FAKE = path.join(__dirname, "flashFakePlaywright.cjs");

function inTempDir(use) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-run-"));
  try {
    return use(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runFlash(env, fake) {
  return inTempDir((dir) => {
    const out = path.join(dir, "shots");
    const stdoutPath = path.join(dir, "stdout");
    const stderrPath = path.join(dir, "stderr");
    const inherited = { ...process.env };
    for (const key of Object.keys(inherited)) if (/^(FLASH_|SC_|DEBUG)/.test(key)) delete inherited[key];
    // Files, not pipes: a pipe is asynchronous on Windows, and the script ends with process.exit.
    const stdout = fs.openSync(stdoutPath, "w");
    const stderr = fs.openSync(stderrPath, "w");
    const { status } = spawnSync(process.execPath, ["--require", FAKE, SCRIPT, out], {
      cwd: ROOT,
      env: { ...inherited, SC_TOKEN: "s3cret", SC_TRACER_PORT: "1", FAKE_PW: JSON.stringify(fake), ...env },
      stdio: ["ignore", stdout, stderr],
      timeout: 30000,
    });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    const lines = fs
      .readFileSync(stdoutPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\[page \S+ /, "[page "))
      .filter(Boolean);
    const chromeLog = path.join(out, "chrome_stderr.log");
    return {
      status,
      chromeLog,
      lines,
      stderr: fs.readFileSync(stderrPath, "utf8"),
      files: fs.readdirSync(out).sort(),
      chromeLogText: fs.existsSync(chromeLog) ? fs.readFileSync(chromeLog, "utf8") : null,
    };
  });
}

function realPlaywrightOpensLog() {
  return inTempDir((dir) => {
    const log = path.join(dir, "real.log");
    const { status } = spawnSync(process.execPath, ["-e", 'require("playwright-core")'], {
      cwd: ROOT,
      env: { ...process.env, DEBUG: "pw:browser", DEBUG_FILE: log },
      timeout: 30000,
    });
    return { status, opened: fs.existsSync(log) };
  });
}

function capped(text, sizes) {
  return inTempDir((dir) => {
    const file = path.join(dir, "log");
    fs.writeFileSync(file, text);
    capLogFile(file, sizes);
    return fs.readFileSync(file, "utf8");
  });
}

module.exports = { capped, realPlaywrightOpensLog, runFlash };
