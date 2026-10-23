// Export starts from the selection, in a real browser with the real engine.
//
//   1. Two of three bodies selected, Export opens on "Selected (2 bodies)".
//   2. Exporting writes a file holding exactly those two bodies.
//   3. One body selected opens on that body, by Ctrl+E too.
//
// A plain browser has no save dialog, so after boot the Tauri bridge is stood
// up for that one call: it answers the save dialog with a path in outDir.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/export_selection_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "export_selection_out");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

function stl(file) {
  const raw = fs.readFileSync(file);
  const n = raw.readUInt32LE(80);
  const xs = [];
  for (let t = 0; t < n; t++) for (let v = 0; v < 3; v++) xs.push(raw.readFloatLE(84 + 50 * t + 12 + 12 * v));
  return { n, xs };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const target = path.join(OUT, "pick.stl");
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  if (process.env.SC_DEBUG) page.on("console", (m) => console.log("console:", m.text().slice(0, 200)));
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.evaluate(() => localStorage.removeItem("fundacad.exportSettings"));

  const bodies = await page.evaluate(async () => {
    const box = (id) => ({ id, type: "box", length: 10, width: 10, height: 10 });
    window.store.addFeature(box("a"));
    window.store.addFeature(box("b"));
    window.store.addFeature({ id: "mb", type: "move", dx: 30, bodies: ["body2"] });
    window.store.addFeature(box("c"));
    window.store.addFeature({ id: "mc", type: "move", dx: 60, bodies: ["body3"] });
    await window.store.rebuildNow();
    return (window.store.buildState.result?.bodies ?? []).map((b) => b.id);
  });
  check("three bodies built", bodies.join() === "body1,body2,body3", bodies.join());

  // Not an addInitScript: isTauri() true at boot would take other code paths.
  await page.evaluate((p) => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => (cmd === "plugin:dialog|save" ? p : null),
      transformCallback: () => 0,
    };
  }, target);

  const scopeText = () => page.$eval("[data-testid=export-scope]", (el) => el.textContent.trim());
  const has = (id) => page.$(`[data-testid=${id}]`).then((el) => !!el);

  await page.evaluate(() => window.viewport.setSelectedBodies(["body1", "body3"]));
  await page.evaluate(() => window.__fundacad.handleAction("export"));
  await page.waitForTimeout(400);
  check(
    "two selected bodies open on Selected (2 bodies)",
    (await scopeText()) === "Selected (2 bodies)",
    await scopeText(),
  );
  await page.screenshot({ path: path.join(OUT, "01_selected.png") });

  await page.click("[data-testid=export-confirm]");
  for (let i = 0; i < 100 && !fs.existsSync(target); i++) await page.waitForTimeout(200);
  await page.waitForTimeout(500);
  if (fs.existsSync(target)) {
    const { n, xs } = stl(target);
    check("the file holds two boxes", n === 24, `${n} triangles`);
    check(
      "and not the middle one",
      xs.every((x) => x < 20 || x > 40),
      `x ${Math.min(...xs)}..${Math.max(...xs)}`,
    );
    check("but both ends", xs.some((x) => x < 0) && xs.some((x) => x > 60));
  } else {
    check("the export wrote a file", false, target);
  }

  // The export ends on a summary with a Done button, which holds the keyboard.
  const done = await page.$(".choice-btn.choice-primary");
  if (done) {
    await done.click();
    await page.waitForTimeout(300);
  }

  await page.evaluate(() => window.viewport.setSelectedBodies(["body2"]));
  await page.keyboard.press("Control+e");
  await page.waitForTimeout(1000);
  if (process.env.SC_DEBUG)
    console.log(
      await page.evaluate(() => ({
        active: document.activeElement?.outerHTML.slice(0, 120),
        busy: window.store.busyState.active,
      })),
    );
  check(
    "Ctrl+E with one body opens on that body",
    (await has("export-scope")) &&
      (await page.$eval("[data-testid=export-scope]", (el) => el.dataset.value)) === "body2",
    (await has("export-scope")) ? await scopeText() : "no dialog",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.evaluate(() => window.viewport.setSelectedBodies([]));
  await page.evaluate(() => window.__fundacad.handleAction("export"));
  await page.waitForTimeout(400);
  check("nothing selected opens on All in one file", (await scopeText()) === "All in one file", await scopeText());
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
