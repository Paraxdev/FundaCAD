// Screenshots of the app shell, for looking at what a UI change actually did.
//
// Not an assertion suite — the other e2e scripts do that. This one exists
// because a stylesheet cannot be reviewed by reading it: the ribbon's overflow
// packing, the panel widths and the side-mounted arrangements are all decided by
// layout, which happy-dom does not implement, so the component tests are blind
// to every one of them.
//
// No sidecar needed. The shell renders with an empty document and a dead
// geometry socket; the status pill just says it cannot connect, which is itself
// worth seeing since it is the widest thing in the title bar.
//
// Usage (from the repo root, with vite on 5173):
//   node e2e/shell_shots.cjs [outDir]
//
// SC_CHROME picks the browser. Any Chromium build works — Brave and Edge are
// Chromium, and this needs no extension or profile.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const OUT = path.resolve(process.argv[2] || "shell_shots");
const URL = process.env.SC_URL || "http://localhost:5173/";
const EXE = process.env.SC_CHROME
  || "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

/** Set a preference the way the app itself stores it, then reload so the
 *  module-level readers pick it up at import time (they read localStorage once). */
async function withPrefs(page, prefs) {
  await page.evaluate((p) => {
    for (const [k, v] of Object.entries(p)) {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    }
  }, prefs);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#main", { timeout: 15000 });
  await page.waitForTimeout(600); // ribbon reflow + first viewport paint
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#main", { timeout: 20000 });
  // The welcome screen opens over the whole shell on a fresh profile, which is
  // exactly what we are here to look at. Turn it off the way its own checkbox
  // does, before the first shot.
  await page.evaluate(() => localStorage.setItem("fundacad.welcomeOnStartup", "false"));

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`  ${name}.png`);
  };

  // Every arrangement layoutPrefs can produce, plus the two panels that changed.
  await withPrefs(page, { "fundacad.layout": null, "fundacad.browserFilter": null });
  await shot("01-default");

  await withPrefs(page, { "fundacad.layout": JSON.stringify({ ribbon: "left", history: "bottom" }) });
  await shot("02-ribbon-left");

  await withPrefs(page, { "fundacad.layout": JSON.stringify({ ribbon: "top", history: "right" }) });
  await shot("03-history-right");

  await withPrefs(page, { "fundacad.layout": JSON.stringify({ ribbon: "left", history: "right" }) });
  await shot("04-both-sides");

  await withPrefs(page, { "fundacad.layout": null });
  await page.evaluate(() => {
    document.querySelector("#browser-filter")?.focus();
  });
  await shot("05-browser-filter");

  // Preferences, opened the way a user does.
  await page.keyboard.press("Control+Comma");
  await page.waitForTimeout(400);
  await shot("06-preferences");
  // Reload rather than press Escape: the dialog is modal and a stray Escape
  // that misses leaves an overlay swallowing every later click.
  await withPrefs(page, {});

  // The rest of the run builds a real document, so the layout is chosen HERE,
  // before anything is drawn: withPrefs reloads, and a reload throws the
  // document away.
  await withPrefs(page, { "fundacad.layout": JSON.stringify({ ribbon: "top", history: "right" }) });

  // The heads-up field, which needs a sketch but NOT the sidecar: drawing is
  // client-side and only the solid build goes to the kernel.
  await page.getByText("XY plane").click();
  await page.waitForTimeout(700);
  await page.keyboard.press("c"); // circle
  await page.waitForTimeout(300);
  const box = await page.locator("#canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  await page.mouse.move(cx + 170, cy - 90, { steps: 8 });
  await page.waitForTimeout(400);
  await shot("07-headsup-tracking");

  // Type a value with a unit the field is not showing.
  await page.keyboard.type("1 inch");
  await page.waitForTimeout(300);
  await shot("08-headsup-typed-inch");

  // ...and the unit chip's menu.
  const chip = page.locator(".dim-unit").first();
  if (await chip.count()) {
    await chip.click({ force: true });
    await page.waitForTimeout(300);
    await shot("09-unit-menu");
  }
  // The history strip's own property rows. Needs a real feature in the document,
  // so start over on a clean one and draw a circle without touching the field:
  // the shots above left a half-typed value and an open menu, and Escape out of
  // that cancels the circle rather than committing it. Still no sidecar, because
  // a sketch is document state and only the SOLID build goes to the kernel.
  await withPrefs(page, {}); // reload; the layout pref set above survives it
  await page.getByText("XY plane").click();
  await page.waitForTimeout(700);
  await page.keyboard.press("c");
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy); // centre
  await page.mouse.move(cx + 150, cy - 80, { steps: 8 });
  await page.mouse.click(cx + 150, cy - 80); // radius, commits the circle
  await page.waitForTimeout(400);
  const finish = page.locator(".ribbon-btn.finish").first();
  if (await finish.count()) await finish.click({ force: true });
  await page.waitForTimeout(700);

  // Click the chip: selecting the feature is what opens its values under it.
  const node = page.locator(".timeline-node").first();
  if (await node.count()) {
    await node.click({ force: true });
    await page.waitForTimeout(400);
  }
  await shot("10-history-props");

  // The same values in the DEFAULT arrangement, where the history is a 52px
  // strip and the rows float above it instead. This is the half that cannot be
  // checked any other way: it is fixed-positioned from a measured chip rect, so
  // "is it on screen, next to the right chip, and inside the window" is a
  // question only a picture answers.
  await withPrefs(page, { "fundacad.layout": null });
  await page.getByText("XY plane").click();
  await page.waitForTimeout(700);
  await page.keyboard.press("c");
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);
  await page.mouse.move(cx + 150, cy - 80, { steps: 8 });
  await page.mouse.click(cx + 150, cy - 80);
  await page.waitForTimeout(400);
  const finish2 = page.locator(".ribbon-btn.finish").first();
  if (await finish2.count()) await finish2.click({ force: true });
  await page.waitForTimeout(700);
  const node2 = page.locator(".timeline-node").first();
  if (await node2.count()) {
    await node2.click({ force: true });
    await page.waitForTimeout(400);
  }
  await shot("11-history-props-floating");

  // The heads-up box on its own, big. Its confirm/cancel marks laid out 0px
  // wide for a release and drew as two empty squares, which no assertion in the
  // suite could see: the markup was right the whole time and only the box was
  // wrong. Shown at 3x so a 13px glyph is actually legible in the shot.
  await page.evaluate(async () => {
    const { DimInput } = await import("/src/sketch/dimInput.ts");
    const d = new DimInput();
    d.show([{ name: "radius", label: "R", kind: "length" }], () => {}, () => {});
    d.seed("radius", 4.592201);
    d.position(60, 60);
  });
  await page.waitForTimeout(300);
  await page.locator(".dim-input").last().screenshot({
    path: path.join(OUT, "12-headsup-buttons.png"), scale: "css",
  });
  console.log("  12-headsup-buttons.png");

  await browser.close();
  if (errors.length) {
    console.log(`\n${errors.length} console error(s):`);
    for (const e of [...new Set(errors)].slice(0, 12)) console.log(`  ${e}`);
  }
  console.log(`\nshots in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
