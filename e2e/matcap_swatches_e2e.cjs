// Matcap swatches in the browser: the Display popover offers the four spheres
// while Matcap is on, a click changes the look and the saved preference, and the
// body colour toggle turns the tint off. Screenshots go to SC_OUT.
//
//   engine --ws, vite, then SC_TOKEN=<engine token> node e2e/matcap_swatches_e2e.cjs
// SC_URL (default http://localhost:5173/), SC_ENGINE_PORT (default 8765), SC_OUT.

const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const APP = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = process.env.SC_OUT || path.join(os.tmpdir(), "matcap_swatches_e2e");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: process.env.SC_HEADLESS === "1",
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    await page.addInitScript((ws) => {
      const W = window.WebSocket;
      window.WebSocket = class extends W {
        constructor(u, p) {
          super(String(u).replace(":8765", `:${ws}`), p);
        }
      };
    }, ENGINE_PORT);
    await page.goto(`${APP}?token=${TOKEN}`);
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) await modal.click();

    await page.evaluate(async () => {
      const { setRenderPref } = await import("/src/ui/renderPrefs.ts");
      setRenderPref("viewModeModel", "matcap");
      setRenderPref("matcapStyle", "studio");
      setRenderPref("matcapTint", true);
      const s = window.store,
        v = window.viewport;
      s.load(
        JSON.stringify({
          parameters: {},
          features: [
            { id: "a", type: "sphere", radius: 12 },
            { id: "b", type: "cylinder", radius: 7, height: 26 },
            { id: "m", type: "move", bodies: ["body2"], dx: 30, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 },
          ],
        }),
      );
      while (s.buildState.building || v.bodyMeshes.length < 2) await new Promise((r) => setTimeout(r, 200));
      s.setBodiesMaterial(["body1"], s.addMaterial({ name: "red", color: "#d83a3a" }));
      s.setBodiesMaterial(["body2"], s.addMaterial({ name: "blue", color: "#2f6bff" }));
      await new Promise((r) => setTimeout(r, 1500));
      window.__fundacad.handleAction("fit");
      await new Promise((r) => setTimeout(r, 1000));
    });

    await page.click('button[title="Display"]');
    await page.waitForSelector(".matcap-swatch");
    const names = await page.$$eval(".matcap-swatch", (b) => b.map((x) => x.dataset.matcap));
    check(names.join() === "studio,clay,metal,wax", "four swatches", names);
    const mat = () =>
      page.evaluate(() => {
        const t = window.viewport.scene.post.matcap?.mats;
        return t ? [...t.values()].map((x) => x.flat.vertexColors) : null;
      });
    const shot = async (name) => {
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, name) });
    };
    await shot("studio.png");

    await page.click('.matcap-swatch[data-matcap="metal"]');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fundacad.render")).matcapStyle);
    check(saved === "metal", "the choice is saved", saved);
    check(
      (await page.getAttribute('.matcap-swatch[data-matcap="metal"]', "aria-checked")) === "true",
      "the swatch shows active",
    );
    await shot("metal.png");

    await page.click('.matcap-swatch[data-matcap="wax"]');
    await shot("wax.png");

    const before = await mat();
    await page.click("text=Tint with body colors");
    const tint = await page.evaluate(() => JSON.parse(localStorage.getItem("fundacad.render")).matcapTint);
    await shot("plain.png");
    const after = await mat();
    check(tint === false, "tint turned off", tint);
    check(
      before && after && before.every((v) => v === true) && after.every((v) => v === false),
      "plain drops the body colours",
      { before, after },
    );

    await page.reload();
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
    const kept = await page.evaluate(async () => {
      const { renderPrefs } = await import("/src/ui/renderPrefs.ts");
      return [renderPrefs().matcapStyle, renderPrefs().matcapTint];
    });
    check(kept.join() === "wax,false", "kept across a reload", kept);
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
