// Plugin settings in the real app: open Preferences > Plugins, expand the
// Navigation and Game Controller rows, change a value in each, check the plugin
// took it, reset, and check the defaults are back. Needs no engine.
//
// Usage (from the repo root, with vite running a development build):
//   node e2e/plugin_settings_e2e.cjs [outDir]
// SC_URL (default http://localhost:5173/) points it at a vite of your own;
// SC_CHROME names the browser.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const URL = process.env.SC_URL || "http://localhost:5173/";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = process.argv[2] || path.join(process.cwd(), "e2e-out", "plugin-settings");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });

  await page.goto(URL);
  await page.waitForTimeout(5000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }

  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true })),
  );
  await page.waitForSelector(".prefs-nav-btn[data-category='plugins']", { timeout: 15000 });
  const cats = await page.$$eval(".prefs-nav-btn", (els) => els.map((e) => e.textContent.trim()));
  check(
    "no plugin has a category of its own",
    !cats.some((c) => ["Mouse and keys", "Game Controller", "Onshape"].includes(c)),
    cats.join(", "),
  );
  await page.click(".prefs-nav-btn[data-category='plugins']");

  const nav = '[data-plugin-row="FundaCAD.Navigation"]';
  const pad = '[data-plugin-row="FundaCAD.Gamepad"]';
  await page.waitForSelector(nav, { timeout: 15000 });
  check("Navigation has a row while it runs from source", true);
  check("its settings are closed until asked", !(await page.$(`${nav} [data-plugin-settings]`)));

  await page.click(`${nav} [data-plugin-settings-toggle]`);
  await page.click(`${pad} [data-plugin-settings-toggle]`);
  await page.waitForSelector(`${nav} [data-setting="preset"] .select-trigger`);
  await page.waitForSelector(`${pad} [data-setting="deadzone"] input`);
  await page.screenshot({ path: path.join(OUT, "expanded.png"), fullPage: true });

  const table = () =>
    page.evaluate(async () => (await import("/src/viewport/navigator/bindings.ts")).pointerBindings());
  const deadzone = () =>
    page.evaluate(async () => (await import("/plugins/FundaCAD.Gamepad/gamepad.ts")).getGamepadConfig().deadzone);
  const stored = (id) =>
    page.evaluate((k) => JSON.parse(localStorage.getItem(`fundacad.pluginSettings.${k}`) || "null"), id);

  await page.click(`${nav} [data-setting="preset"] .select-trigger`);
  await page.click('.select-pop .opt-row:has-text("Alt+left orbits")');
  await page.waitForTimeout(300);
  const t = await table();
  check(
    "Navigation took the preset",
    JSON.stringify(t).includes('"alt":true') && t[0].button === "left",
    JSON.stringify(t[0]),
  );
  check(
    "and it is stored under the plugin's own key",
    (await stored("FundaCAD.Navigation"))?.values?.preset === "alt-left",
  );

  const dz = page.locator(`${pad} [data-setting="deadzone"] input`);
  await dz.fill("abc");
  await dz.press("Enter");
  const err = await page.textContent(`${pad} [data-setting="deadzone"] [role=alert]`).catch(() => "");
  check("text that is not a number says why", !!err && err.length > 0, err);
  await dz.fill("0.3");
  await dz.press("Enter");
  await page.waitForTimeout(200);
  check("Game Controller took the deadzone", (await deadzone()) === 0.3, String(await deadzone()));
  await page.screenshot({ path: path.join(OUT, "changed.png"), fullPage: true });

  await page.click(`${pad} [data-setting="deadzone"] [data-setting-reset]`);
  await page.waitForTimeout(200);
  check("one property resets", (await deadzone()) === 0.15, String(await deadzone()));

  await page.click(`${nav} [data-plugin-settings-reset]`);
  await page.waitForTimeout(300);
  const back = await table();
  check(
    "the whole plugin resets, and the default table is back",
    back[0].button === "right" && !JSON.stringify(back).includes('"alt":true'),
    JSON.stringify(back[0]),
  );

  await page.fill("[data-plugin-settings-search]", "deadzone");
  await page.waitForTimeout(200);
  check(
    "search keeps the rows that match",
    !!(await page.$(`${pad} [data-setting="deadzone"]`)) && !(await page.$(nav)),
  );
  await page.fill("[data-plugin-settings-search]", "");

  await page.screenshot({ path: path.join(OUT, "reset.png"), fullPage: true });
  await browser.close();
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
