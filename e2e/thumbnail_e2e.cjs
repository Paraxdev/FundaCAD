// Home's card picture, in a real browser against the real geometry engine.
//
//   1. A built box gives a 480 x 300 JPEG that is not one flat colour.
//   2. The camera, the canvas size and the user's view are as they were.
//   3. An empty document gives no picture.
//
//   engine --ws, vite, then
//   SC_TOKEN=<engine token> node e2e/thumbnail_e2e.cjs [out.jpg]
// SC_URL (default http://localhost:5173/) and SC_ENGINE_PORT (default 8765) pick the setup.

const { chromium } = require("playwright-core");
const fs = require("fs");

const TOKEN = process.env.SC_TOKEN || "";
const APP = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: !process.env.SC_HEADED,
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
    await page.addInitScript((ws) => {
      const W = window.WebSocket;
      window.WebSocket = class extends W {
        constructor(u, p) { super(String(u).replace(":8765", `:${ws}`), p); }
      };
    }, ENGINE_PORT);
    await page.goto(`${APP}?token=${TOKEN}`);
    await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });
    const close = await page.$(".modal-close");
    if (close) await close.click();

    const built = await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 40, width: 30, height: 20 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return s.buildState.result?.bodies?.length ?? 0;
    });
    check("a box built", built === 1, `${built}`);
    await page.evaluate(() => {
      window.viewport.rig.orbitBy(0.7, 0.3);
      window.viewport.rig.zoomBy(0.4);
    });
    await page.waitForTimeout(500);

    const shot = await page.evaluate(async () => {
      const v = window.viewport;
      const canvas = v.canvas;
      const before = { cam: JSON.stringify(v.rig.getState()), w: canvas.width, h: canvas.height };
      const url = v.renderThumbnail(480, 300);
      const after = { cam: JSON.stringify(v.rig.getState()), w: canvas.width, h: canvas.height };
      const img = new Image();
      await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = url; });
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      const colours = new Set();
      for (let i = 0; i < px.length; i += 4 * 37) colours.add((px[i] >> 3) * 1024 + (px[i + 1] >> 3) * 32 + (px[i + 2] >> 3));
      return { url, before, after, w: img.width, h: img.height, colours: colours.size };
    });
    if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from(shot.url.split(",")[1], "base64"));
    check("a JPEG", shot.url.startsWith("data:image/jpeg;base64,"), shot.url.slice(0, 30));
    check("480 x 300", shot.w === 480 && shot.h === 300, `${shot.w} x ${shot.h}`);
    check("not one flat colour", shot.colours > 4, `${shot.colours} colours`);
    check("small", shot.url.length < 200_000, `${shot.url.length}`);
    check("the camera is where the user left it", shot.before.cam === shot.after.cam, `${shot.before.cam} vs ${shot.after.cam}`);
    check("the canvas keeps its size", shot.before.w === shot.after.w && shot.before.h === shot.after.h,
      `${shot.before.w}x${shot.before.h} vs ${shot.after.w}x${shot.after.h}`);

    await page.evaluate(() => window.__fundacad.handleAction("new"));
    const discard = await page.waitForSelector("button:has-text('Discard')", { timeout: 1500 }).catch(() => null);
    if (discard) await discard.click();
    await page.waitForFunction(() => !window.store.buildState.building && !window.store.document.features.length, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const empty = await page.evaluate(() => window.viewport.renderThumbnail(480, 300));
    check("an empty document gives no picture", empty === null, String(empty).slice(0, 30));
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
