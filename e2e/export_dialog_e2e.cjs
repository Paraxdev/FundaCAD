// The Export dialog, in a real browser.
//
//   1. File, Export opens the dialog on the type, unit and refinement.
//   2. Advanced reveals surface deviation, normal deviation and maximum cell size.
//      A preset fills them, editing one turns the refinement to Custom.
//   3. STEP hides the mesh settings.
//   4. Export remembers the choices for the next time the dialog opens.
//
// The file itself is written by the sidecar (sidecar/tests/test_export_options.py),
// a plain browser has no save dialog to give it a path.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/export_dialog_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "export_dialog_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.evaluate(() => localStorage.removeItem("fundacad.exportSettings"));

  await page.evaluate(async () => {
    window.store.addFeature({ id: "b1", type: "box", length: 20, width: 20, height: 20 });
    await window.store.rebuildNow();
  });
  const has = (id) => page.$(`[data-testid=${id}]`).then((el) => !!el);
  const value = (id) => page.$eval(`[data-testid=${id}]`, (el) => el.value);
  const open = async () => {
    await page.evaluate(() => window.__fundacad.handleAction("export"));
    await page.waitForTimeout(400);
  };

  await open();
  check("Export opens the dialog", await has("export-format"));
  check("on type, unit and refinement", (await has("export-unit")) && (await has("export-refinement")));
  check("advanced settings start hidden", !(await has("export-surface-deviation")));

  await page.click("[data-testid=export-advanced]");
  await page.waitForTimeout(200);
  check("the Advanced toggle reveals the three faceting settings",
    (await has("export-surface-deviation")) && (await has("export-normal-deviation")) && (await has("export-max-edge")));

  await page.selectOption("[data-testid=export-refinement]", "high");
  await page.waitForTimeout(150);
  check("a preset fills the values", (await value("export-surface-deviation")) === "0.005" && (await value("export-normal-deviation")) === "5",
    JSON.stringify([await value("export-surface-deviation"), await value("export-normal-deviation")]));

  await page.fill("[data-testid=export-max-edge]", "2");
  await page.press("[data-testid=export-max-edge]", "Tab");
  await page.waitForTimeout(150);
  check("editing one turns the refinement to Custom", (await value("export-refinement")) === "custom", await value("export-refinement"));

  await page.selectOption("[data-testid=export-unit]", "in");
  await page.selectOption("[data-testid=export-binary]", "false");
  await page.screenshot({ path: path.join(OUT, "01_stl_advanced.png") });

  await page.selectOption("[data-testid=export-format]", "step");
  await page.waitForTimeout(150);
  check("STEP hides the mesh settings", !(await has("export-unit")) && !(await has("export-refinement")));
  await page.selectOption("[data-testid=export-format]", "stl");
  await page.waitForTimeout(150);

  await page.click("[data-testid=export-confirm]");
  await page.waitForTimeout(400);
  check("Export closes the dialog", !(await has("export-format")));

  await open();
  const back = await page.evaluate(() => ({
    format: document.querySelector("[data-testid=export-format]")?.value,
    unit: document.querySelector("[data-testid=export-unit]")?.value,
    refinement: document.querySelector("[data-testid=export-refinement]")?.value,
    maxEdge: document.querySelector("[data-testid=export-max-edge]")?.value,
  }));
  check("the next Export remembers the choices", back.format === "stl" && back.unit === "in" && back.refinement === "custom" && back.maxEdge === "2", JSON.stringify(back));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape cancels", !(await has("export-format")));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
