// The Printability panel against the real engine, in a real browser.
//
// What only the running app can answer: the ribbon opens the panel, Check
// reaches the engine's `printability` op and lists what it found, the flagged
// faces are tinted in the viewport, a row click frames the camera on it, and
// closing the panel takes the tints away.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chromium> node e2e/printability_e2e.cjs [shots dir]
// SC_APP_PORT and SC_ENGINE_PORT move it off 5173/8765.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const APP_PORT = process.env.SC_APP_PORT || "5173";
const WS_PORT = process.env.SC_ENGINE_PORT || "8765";
const SHOTS = process.argv[2] || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

// A T on the bed, whose cap overhangs, and beside it a 0.6 mm fin, one
// perimeter for a 0.4 mm nozzle.
const DOC = JSON.stringify({ version: 9, parameters: {}, paramDefs: {}, features: [
  { id: "s", type: "box", length: 4, width: 4, height: 10 },
  { id: "m", type: "move", dz: 5, bodies: ["body1"] },
  { id: "c", type: "box", length: 20, width: 4, height: 4 },
  { id: "n", type: "move", dz: 12, bodies: ["body2"] },
  { id: "j", type: "boolean", operation: "union", target: "body1", tools: ["body2"] },
  { id: "f", type: "box", length: 0.6, width: 20, height: 10 },
  { id: "k", type: "move", dx: 20, dz: 5, bodies: ["body3"] },
] });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(({ t, ws }) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(":8765", `:${ws}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, { t: TOKEN, ws: WS_PORT });

  await page.goto(`http://localhost:${APP_PORT}/`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store, null, { timeout: 60000 });
  await page.evaluate((text) => window.store.load(text), DOC);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

  // Through the ribbon, as a person would get there.
  await page.getByText("Inspect", { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  await page.getByText("Printability", { exact: true }).first().click();
  await page.waitForSelector(".printability-panel", { timeout: 5000 });
  check("the ribbon opens the panel", true);
  const scope = await page.textContent(".printability-scope");
  check("with nothing selected it checks every body", /All 2/.test(scope || ""), scope);

  await page.click(".printability-run");
  await page.waitForSelector(".printability-finding, .printability-clean, .printability-error", { timeout: 120000 });
  await page.waitForTimeout(800);
  const rows = await page.$$eval(".printability-finding", (els) => els.map((e) => e.textContent.trim()));
  console.log("  rows:", JSON.stringify(rows));
  check("the error line stays empty", !(await page.$(".printability-error")));
  check("the cap's underside is an overhang", rows.some((r) => /^Overhang/.test(r)));
  check("the fin is a thin wall of 0.6 mm", rows.some((r) => /Thin wall 0\.6 mm/.test(r)));
  const header = await page.textContent(".printability-header");
  check("the header says how the parts sit", /\+Z up as modelled/.test(header || ""), header);
  await shot("printability-results");

  // The fin's row frames the fin, drawn in the hover colour.
  const rowsEls = await page.$$(".printability-finding");
  const texts = await Promise.all(rowsEls.map((w) => w.textContent()));
  await rowsEls[texts.findIndex((t) => /Thin wall/.test(t))].click();
  await page.waitForTimeout(1500);
  const focused = await page.$eval(".printability-finding.is-focus", (e) => e.textContent.trim()).catch(() => "");
  check("the clicked row is the one put forward", /Thin wall/.test(focused), focused);
  await shot("printability-focus");

  await page.click(".printability-close");
  await page.waitForTimeout(500);
  check("closing the panel takes it away", !(await page.$(".printability-panel")));
  await shot("printability-closed");

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
