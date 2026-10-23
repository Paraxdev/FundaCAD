// The circle's second click lands on the floating diameter box at small radii, in a real browser.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<token> SC_PORT=<engine port> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/circle_box_click_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const PORT = process.env.SC_PORT || "8765";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "circle_box_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.goto(`${URL}?token=${TOKEN}&port=${PORT}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.sketch && !!window.viewport, null, { timeout: 60000 });
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(2500);

  const origin = await page.evaluate(() => window.viewport.projectToScreen(window.sketch.plane.to3D(0, 0)));
  // Off the origin and slanted, in screen pixels.
  const start = { x: origin.x + 60, y: origin.y - 40 };
  const dirs = [
    [0.8, 0.6],
    [-0.6, 0.8],
    [0.96, -0.28],
  ];
  let i = 0;
  for (const px of [30, 43, 80]) {
    const [dx, dy] = dirs[i++ % dirs.length];
    await page.evaluate(() => window.sketch.setTool("circle"));
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => window.sketch.entities.length);
    await page.mouse.move(start.x + 3, start.y + 3);
    await page.mouse.move(start.x, start.y, { steps: 3 });
    await page.mouse.click(start.x, start.y);
    const end = { x: start.x + dx * px, y: start.y + dy * px };
    await page.mouse.move(end.x, end.y, { steps: 8 });
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest(".dim-input") !== null,
      [end.x, end.y],
    );
    await page.screenshot({ path: path.join(OUT, `r${px}_before_click.png`) });
    await page.mouse.click(end.x, end.y);
    await page.waitForTimeout(500);
    const circles = await page.evaluate(() => window.sketch.entities.filter((e) => e.type === "circle"));
    const last = circles[circles.length - 1];
    check(`${px}px: the box is not under the cursor for hit testing`, !hit);
    check(`${px}px: one circle was added`, circles.length === before + 1, `count ${circles.length}`);
    const scale = await page.evaluate(
      ([x, y]) => {
        const a = window.viewport.projectToScreen(window.sketch.plane.to3D(0, 0));
        const b = window.viewport.projectToScreen(window.sketch.plane.to3D(10, 0));
        return Math.hypot(b.x - a.x, b.y - a.y) / 10;
      },
      [0, 0],
    );
    if (last) check(`${px}px: radius is about the drag`, Math.abs(last.radius * scale - px) < 6, `r=${last.radius}`);
    await page.keyboard.press("Escape");
  }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
