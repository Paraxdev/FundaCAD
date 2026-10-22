// A .funda saved in the browser build opens whole on an engine that never saw
// its import: the geometry travels in the file, as it does from the desktop app.
//
// Two engines with separate blob stores stand in for two machines. The first
// imports a coloured STEP assembly and the page saves it by download; the first
// engine is stopped, a second one with an empty blob store takes over, and the
// download is opened through the file picker. Its bodies and their colours have
// to come back, which they only can if the bytes were in the file.
//
// Usage (from the repo root, with vite running; the script starts its own engines):
//   SC_ENGINE=<fundacad-engine> SC_CHROME=<chrome> [SC_VITE=http://localhost:5173] \
//     node e2e/browser_save_geometry_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const ENGINE = process.env.SC_ENGINE ? path.resolve(process.env.SC_ENGINE) : "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const VITE = (process.env.SC_VITE || "http://localhost:5173").replace(/\/$/, "");
const OUT = path.resolve(process.argv[2] || "browser_save_geometry_shots");
const FIXTURE = path.resolve(__dirname, "../tests/fixtures/asm_colors.step");
const TOKEN = "savegeom";
if (!ENGINE) {
  console.error("set SC_ENGINE to a fundacad-engine binary");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

// The engine prints the port it was given, so an ephemeral one is picked here.
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function startEngine(tag) {
  const listen = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `fundacad-savegeom-${tag}-`));
  const env = {
    ...process.env,
    FUNDACAD_ENGINE_PORT: String(listen),
    FUNDACAD_ENGINE_TOKEN: TOKEN,
    FUNDACAD_BLOB_DIR: path.join(root, "blobs"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    FUNDACAD_EXTRA_ORIGINS: new URL(VITE).origin,
  };
  const proc = spawn(ENGINE, ["--ws"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const port = new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`engine ${tag} never listened: ${buf}`)), 60000);
    const read = (d) => {
      buf += d;
      const m = /LISTENING (\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    proc.stdout.on("data", read);
    proc.stderr.on("data", read);
    proc.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`engine ${tag} exited ${c}: ${buf}`));
    });
  });
  return { proc, root, port };
}

function stopEngine(e) {
  if (!e || e.proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    e.proc.once("exit", resolve);
    e.proc.kill();
    setTimeout(resolve, 5000);
  });
}

async function openApp(page, port) {
  await page.goto(`${VITE}/?engine=${port}&token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.geometry && window.geometry.connected, null, {
    timeout: 60000,
  });
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(300);
  }
}

const idle = (page) =>
  page.waitForFunction(() => !window.store.buildState.building && !window.store.busy?.active, null, {
    timeout: 120000,
  });

const bodies = (page) =>
  page.evaluate(() =>
    (window.store.buildState.result?.bodies ?? [])
      .map((b) => ({
        name: window.store.bodyName(b.id) ?? b.name,
        color: window.store.bodyMaterialOf(b.id)?.color ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let first = null;
  let second = null;
  let browser = null;
  try {
    first = await startEngine("a");
    const portA = await first.port;
    browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await openApp(page, portA);
    const imported = await page.evaluate(async (file) => {
      const { importPath } = await import("/src/io/files.ts");
      await importPath(window.store, window.geometry, file);
      await window.store.rebuildNow();
      return window.store.document.features.find((f) => f.type === "import")?.geom ?? null;
    }, FIXTURE);
    await idle(page);
    const before = await bodies(page);
    console.log("  imported bodies:", JSON.stringify(before));
    check(
      "the import landed and its parts wear colours",
      !!imported && before.length >= 3 && before.filter((b) => b.color).length >= 3,
      `geom ${imported}`,
    );

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.evaluate(() => window.__fundacad.handleAction("saveas")),
    ]);
    const saved = path.join(OUT, download.suggestedFilename() || "saved.funda");
    await download.saveAs(saved);
    const file = JSON.parse(fs.readFileSync(saved, "utf8"));
    const keys = Object.keys(file);
    check(
      "the download carries the import's geometry, as the last key",
      keys.at(-1) === "geometry" && typeof file.geometry?.[imported] === "string",
      `${fs.statSync(saved).size} bytes, keys ${keys.join(",")}`,
    );

    await page.goto("about:blank");
    await stopEngine(first);
    second = await startEngine("b");
    const portB = await second.port;
    check(
      "the second engine starts with no blobs",
      !fs.existsSync(path.join(second.root, "blobs")) || fs.readdirSync(path.join(second.root, "blobs")).length === 0,
    );

    await openApp(page, portB);
    errors.length = 0;
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 30000 }),
      page.evaluate(() => window.__fundacad.handleAction("open")),
    ]);
    await chooser.setFiles(saved);
    await page.waitForFunction(() => window.store.document.features.some((f) => f.type === "import"), null, {
      timeout: 60000,
    });
    await page.evaluate(() => window.store.rebuildNow());
    await idle(page);
    const after = await bodies(page);
    console.log("  reopened bodies:", JSON.stringify(after));
    check(
      "the reopened file builds the same bodies in the same colours",
      JSON.stringify(after) === JSON.stringify(before),
    );
    const blobs = fs.readdirSync(path.join(second.root, "blobs"));
    check(
      "the second engine got the import's bytes from the file",
      blobs.some((n) => n.startsWith(imported)),
      JSON.stringify(blobs),
    );
    const buildError = await page.evaluate(() => window.store.buildState.error?.message ?? null);
    check("nothing failed to build", !buildError, String(buildError));
    check("no error was shown", errors.length === 0, JSON.stringify(errors));

    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(900);
    await page.locator("#viewport").screenshot({ path: `${OUT}/reopened.png` });
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    if (browser) await browser.close();
    await stopEngine(first);
    await stopEngine(second);
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
