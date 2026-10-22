// Loose ends in a real browser: a square whose last line stops short of its
// start, drawn without constraints, beside a lone line. The overlay shows
// amber dots on every untied end and red on the lone line, Tie Loose Ends in
// the ribbon ties the square in one step, the square becomes one profile,
// and Ctrl+Z brings the gap and the dots back in one step.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/loose_ends_e2e.cjs [outDir]
// SC_URL and SC_ENGINE_PORT point it at another vite and engine.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "loose_ends_shots");
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
  const browser = await chromium.launch({
    executablePath: EXE,
    args: (process.env.SC_CHROME_ARGS ?? "--use-angle=swiftshader --no-sandbox").split(" ").filter(Boolean),
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.addInitScript(
    ([t, port]) => {
      const N = window.WebSocket;
      class P extends N {
        constructor(u, p) {
          const s = String(u)
            .replace(":8765", `:${port}`)
            .replace(/([?&])token=[^&]*/, `$1token=${t}`);
          super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
        }
      }
      window.WebSocket = P;
    },
    [TOKEN, ENGINE_PORT],
  );
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({
      id: "s1",
      type: "sketch",
      plane: "XY",
      entities: [
        { type: "line", id: "a", x1: 0, y1: 0, x2: 40, y2: 0 },
        { type: "line", id: "b", x1: 40, y1: 0, x2: 40, y2: 30 },
        { type: "line", id: "c", x1: 40, y1: 30, x2: 0, y2: 30 },
        { type: "line", id: "d", x1: 0, y1: 30, x2: 0.05, y2: 0.2 },
        { type: "line", id: "z", x1: 60, y1: 0, x2: 75, y2: 20 },
      ],
    });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.sketch.setTool("select"));
  const state = () =>
    page.evaluate(() => ({
      dots: { ...window.overlay.looseEndCounts },
      constraints: window.sketch.constraints.length,
      regions: window.overlay.activeRegions.length,
    }));

  let s = await state();
  check(
    "every square end is amber, the lone line's two are red",
    s.dots.untied === 8 && s.dots.open === 2,
    JSON.stringify(s),
  );
  check("the gap leaves no profile", s.regions === 0, JSON.stringify(s));
  await page.screenshot({ path: path.join(OUT, "1_dots.png") });

  const button = page.getByText("Tie Loose Ends", { exact: true }).first();
  if (await button.isVisible().catch(() => false)) await button.click();
  else await page.evaluate(() => window.__fundacad.handleAction("tie-loose-ends"));
  await page.waitForTimeout(2000);
  s = await state();
  check(
    "the tie adds one constraint per pair and clears every amber dot",
    s.constraints === 4 && s.dots.untied === 0,
    JSON.stringify(s),
  );
  check("the lone line stays red", s.dots.open === 2, JSON.stringify(s));
  check("the square is one profile", s.regions === 1, JSON.stringify(s));
  await page.screenshot({ path: path.join(OUT, "2_tied.png") });

  await page.mouse.move(700, 450);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1500);
  s = await state();
  check(
    "one undo brings the gap and the dots back",
    s.constraints === 0 && s.dots.untied === 8 && s.regions === 0,
    JSON.stringify(s),
  );

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
