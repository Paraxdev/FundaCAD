// A real wheel in Chromium at every page zoom and display scale, read by the code the viewport uses. A zoom divides
// deltaY and truncates wheelDeltaY, so these numbers come from the engine's own input path, not from a guess at them.
// Needs no vite or engine: it bundles wheelKind.ts and serves a blank page.
//
// Usage (from the repo root): SC_CHROME=<chrome.exe> node e2e/wheel_zoom_e2e.cjs
const { chromium } = require("playwright-core");
const esbuild = require("esbuild");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const ROOT = path.resolve(__dirname, "..");

// Interface size in percent, and the display scale under it. The app knows its own webview zoom, and with none set it
// has only devicePixelRatio to go on, which is how wheelScales in interfaceSize.ts picks the factor.
const CASES = [
  [100, 1],
  [80, 1],
  [110, 1],
  [125, 1],
  [150, 1],
  [175, 1],
  [200, 1],
  [100, 1.25],
  [100, 1.5],
  [110, 1.25],
  [150, 1.5],
];
// A notch of 3 lines, and of 1 line, in CSS pixels.
const NOTCHES = [100, 33.33];

(async () => {
  const lib = esbuild.buildSync({
    entryPoints: [path.join(ROOT, "src/viewport/navigator/wheelKind.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "wheelKind",
  }).outputFiles[0].text;
  const server = http.createServer((_, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><body style="height:5000px"><script>${lib}</script></body>`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/`;

  let failures = 0;
  for (const [pct, scale] of CASES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wheel-zoom-"));
    fs.mkdirSync(path.join(dir, "Default"));
    const level = Math.log(pct / 100) / Math.log(1.2);
    fs.writeFileSync(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({ partition: { per_host_zoom_levels: { x: { "127.0.0.1": { zoom_level: level } } } } }),
    );
    const ctx = await chromium.launchPersistentContext(dir, {
      executablePath: EXE,
      headless: false,
      args: ["--headless=new", "--no-sandbox", `--force-device-scale-factor=${scale}`],
      viewport: null,
    });
    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(url);
      const scales = pct === 100 ? await page.evaluate(() => [1, devicePixelRatio]) : [1, pct / 100];
      await page.evaluate((factors) => {
        window.reads = [];
        addEventListener("wheel", (e) => {
          const kind = window.wheelKind.wheelEvidence(e, false, factors);
          window.reads.push({ deltaY: e.deltaY, wheelDeltaY: e.wheelDeltaY, kind });
        });
      }, scales);
      const cdp = await ctx.newCDPSession(page);
      for (const deltaY of NOTCHES) {
        const before = await page.evaluate(() => window.reads.length);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY });
        await page.waitForFunction((n) => window.reads.length > n, before);
      }
      const reads = await page.evaluate(() => window.reads);
      const ok = reads.length === NOTCHES.length && reads.every((r) => r.kind === "mouse");
      if (!ok) failures++;
      console.log(`  ${ok ? "PASS" : "FAIL"}  size ${pct} scale ${scale} ${JSON.stringify({ scales, reads })}`);
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  server.close();
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
