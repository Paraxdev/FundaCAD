// A value the kernel refused is never committed, in a real browser.
//
//   1. A draft angle the kernel refuses adds nothing when confirmed, keeps the
//      tool open and says why.
//   2. CONTROL: easing to an angle that builds and confirming commits it.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/refused_commit_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "refused_commit_shots");
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

  const idle = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  const prompt = () => page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "");
  const drafts = () => page.evaluate(() => window.store.document.features.filter((f) => f.type === "draft").length);
  const fields = () => page.$$(".dim-input input");
  const typeInto = async (i, text) => {
    const f = (await fields())[i];
    await f.click({ clickCount: 3 });
    await page.keyboard.type(text);
  };

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 20, height: 20 }] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 30, operation: "new" });
    await window.store.rebuildNow();
  });
  await idle();
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.viewport.selectFaces([window.viewport.faceIdNear([10, 0, 15])]);
    window.__fundacad.handleAction("draft");
  });
  await page.waitForTimeout(500);
  const open = () => page.evaluate(() => window.__fundacad.busyWhy().draft);
  check("draft opened on the selected face", await open());

  await typeInto(0, "45");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  await idle();
  await page.waitForTimeout(400);
  const p1 = await prompt();
  check("confirming a draft the kernel refused adds no draft", (await drafts()) === 0, `${await drafts()} drafts`);
  check("the tool stays open", await open());
  check("and the prompt says it was refused", /refused/i.test(p1), JSON.stringify(p1));
  await page.screenshot({ path: path.join(OUT, "01_refused.png") });

  await typeInto(0, "10");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  await idle();
  await page.waitForTimeout(300);
  check("CONTROL: an angle that builds commits", (await drafts()) === 1, `${await drafts()} drafts`);
  const err = await page.evaluate(() => window.store.buildState.errorMessage ?? null);
  check("and the model builds", err === null, String(err));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
