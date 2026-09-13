// Screenshots of the floating shell in its states, for review by eye: a
// stylesheet cannot be reviewed by reading it.
//
//   01 idle model, 02 a category flyout, 03 a body selection, 04 the views
//   popover, 05 sketch mode, 06 a short window (the rail goes compact), 07 the
//   cards closed.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/shell_shots.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "shell_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failures = 0;
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript((t) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, TOKEN);

  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 24 }] });
    s.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 12, operation: "new", regions: [[0, 0, 0]] });
    s.addFeature({ id: "b1", type: "box", length: 10, width: 10, height: 30 });
    await s.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1200);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

  await shot("01-idle");

  await page.locator('[data-family="cat:MODIFY"]').click();
  await page.waitForTimeout(1200);
  await shot("02-flyout");
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    window.viewport.setSelectionMode("bodies");
    window.viewport.setSelectedBodies([window.store.buildState.result.bodies[0].id]);
    window.dispatchEvent(new Event("pointerup"));
  });
  await page.waitForTimeout(800);
  await shot("03-selection");

  await page.locator('#viewcontrols [title="Views"]').click();
  await page.waitForTimeout(600);
  await shot("04-views");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__fundacad.move.cancel());

  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(1500);
  await shot("05-sketch");

  await page.setViewportSize({ width: 1100, height: 640 });
  await page.waitForTimeout(1000);
  await shot("06-short-window");
  const compact = await page.evaluate(() => document.querySelector("#toolrail")?.classList.contains("compact"));
  console.log(`  rail compact at 640px: ${compact}`);
  await page.evaluate(() => window.sketch.cancel());
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.keyboard.press("Control+Alt+S");
  await page.keyboard.press("Control+Alt+H");
  await page.waitForTimeout(600);
  const closed = await page.evaluate(() => ({ items: !!document.querySelector("#browser"), history: !!document.querySelector("#timeline") }));
  console.log(`  after Ctrl+Alt+S and Ctrl+Alt+H: ${JSON.stringify(closed)}`);
  if (closed.items || closed.history) failures++;
  await shot("07-cards-closed");
  await page.keyboard.press("Control+Alt+S");
  await page.keyboard.press("Control+Alt+H");

  console.log(`\n  shots in ${OUT}${failures ? `, ${failures} FAILED` : ""}\n`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
