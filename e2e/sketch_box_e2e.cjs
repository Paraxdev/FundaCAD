// Picking inside a sketch, in a real browser.
//
//   1. Clicking a text selects its letters as profiles; Move/Rotate on the rail
//      still opens the gizmo on the text itself.
//   2. A box dragged rightward takes only what lies wholly inside it.
//   3. A box dragged leftward takes whatever it touches.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/sketch_box_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "sketch_box_shots");
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
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [
      { type: "rectangle", id: "r1", x: -20, y: 0, width: 16, height: 12 },
      { type: "circle", id: "c1", x: 15, y: 0, radius: 6 },
      { type: "text", id: "t1", text: "TEXT", x: -10, y: 25, height: 10 },
    ] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(3000);
  const scr = (x, y) => page.evaluate(([x, y]) => {
    const s = window.sketch;
    return window.viewport.projectToScreen(s.plane.to3D(x, y));
  }, [x, y]);
  const sel = () => page.evaluate(() => [...window.sketch.selected].sort());

  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(300);
  // text: click inside a glyph area, then M
  await page.waitForFunction(() => window.sketch.overlay.activeRegions.some((w) => w.entityId === "t1"), null, { timeout: 20000 }).catch(() => check("the text's letters are drawn", false));
  const glyph = await page.evaluate(() => {
    const r = window.sketch.overlay.activeRegions.find((w) => w.entityId === "t1");
    return r ? window.viewport.projectToScreen(r.interior3D) : null;
  });
  await page.mouse.click(glyph.x, glyph.y);
  await page.waitForTimeout(400);
  check("clicking a text selects its letters", (await page.evaluate(() => window.sketch.overlay.selectedActiveTextIds())).join() === "t1");
  await page.locator("#toolrail [data-action='move-sketch']").click();
  await page.waitForTimeout(600);
  check("Move/Rotate opens the gizmo on the text", await page.evaluate(() => window.__fundacad.move.active), JSON.stringify(await sel()));
  await page.screenshot({ path: path.join(OUT, "sk-1-text-gizmo.png") });
  await page.mouse.move(700, 850);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.evaluate(() => window.sketch.setTool("select"));

  // window box around the rectangle only
  let a = await scr(-31, -12), b = await scr(-5, 12);
  await page.mouse.click(700, 800);
  await page.mouse.move(Math.min(a.x, b.x), Math.min(a.y, b.y));
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(Math.max(a.x, b.x), Math.max(a.y, b.y), { steps: 4 });
  await page.screenshot({ path: path.join(OUT, "sk-2-window.png") });
  await page.mouse.up();
  await page.waitForTimeout(300);
  { const s = await sel(); check("a rightward box takes only what is inside", s.join() === "r1", JSON.stringify(s)); }

  // crossing box from right to left clipping the circle and the text
  a = await scr(30, 45); b = await scr(18, 3);
  await page.mouse.click(700, 800);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.screenshot({ path: path.join(OUT, "sk-3-crossing.png") });
  await page.mouse.up();
  await page.waitForTimeout(300);
  { const s = await sel(); check("a leftward box takes what it touches", s.join() === "c1", JSON.stringify(s)); }

  await page.keyboard.press("m");
  await page.waitForTimeout(500);
  check("M opens the gizmo on the boxed selection", await page.evaluate(() => window.__fundacad.move.active));
  await page.screenshot({ path: path.join(OUT, "sk-4-boxed-gizmo.png") });

  console.log(failures ? `\n  ${failures} FAILED\n` : "\n  all passed\n");
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
