// Home, the start screen, in a real browser against the real geometry engine.
//
//   1. Startup shows Home over the stage, with its close button.
//   2. Blank closes it and leaves an empty document.
//   3. File > Home and the title bar button bring it back, Escape closes it.
//   4. With unsaved work, Blank asks before discarding it.
//   5. A .funda dropped over Home opens and Home closes.
//
//   engine --ws, vite, then
//   SC_TOKEN=<engine token> node e2e/home_e2e.cjs
// SC_URL (default http://localhost:5173/) and SC_ENGINE_PORT (default 8765) pick the setup.

const { chromium } = require("playwright-core");

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
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    await page.addInitScript((ws) => {
      const W = window.WebSocket;
      window.WebSocket = class extends W {
        constructor(u, p) { super(String(u).replace(":8765", `:${ws}`), p); }
      };
    }, ENGINE_PORT);
    await page.goto(`${APP}?token=${TOKEN}`);
    await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });
    const settle = async () => {
      await page.waitForTimeout(300);
      await page.waitForFunction(() => !window.store.buildState.building && !window.store.busy?.active, null, { timeout: 120000 });
    };
    const homeUp = () => page.evaluate(() => !!document.querySelector("#stage .home"));
    const menu = async (top, item) => {
      await page.click(`.menu-btn:has-text("${top}")`);
      await page.click(`.menu-popup:not(.hidden) .menu-item:has-text("${item}")`);
    };

    console.log("1. startup");
    check("Home is up at startup", await homeUp());
    const label = await page.getAttribute(".home .modal-close", "aria-label");
    check("its close button is .modal-close", label === "Back to the document", label);

    console.log("2. Blank");
    await page.click(".home-new-blank");
    await page.waitForTimeout(300);
    check("Blank closes Home", !(await homeUp()));
    const blank = await page.evaluate(() => window.store.document.features.length);
    check("the document is empty", blank === 0, String(blank));

    console.log("3. File > Home and the title bar button");
    await page.click('#titlebar [title="Home"]');
    await page.waitForTimeout(200);
    check("the title bar button opens it", await homeUp());
    await page.click('#titlebar [title="Home"]');
    await page.waitForTimeout(200);
    check("the button again goes back to the document", !(await homeUp()));
    await menu("File", "Home");
    await page.waitForTimeout(200);
    check("File > Home opens it", await homeUp());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("Escape closes it", !(await homeUp()));

    console.log("4. unsaved work");
    await page.evaluate(() => window.store.addFeature({ id: "b1", type: "box", length: 10, width: 10, height: 10 }));
    await settle();
    await menu("File", "Home");
    await page.click(".home-new-blank");
    await page.waitForSelector("button:has-text('Discard')", { timeout: 5000 });
    check("Blank asks before discarding", true);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const kept = await page.evaluate(() => window.store.document.features.length);
    check("Escape on the question keeps the work and Home", kept === 1 && (await homeUp()), String(kept));

    console.log("5. a drop over Home");
    const doc = JSON.stringify({ parameters: {}, features: [{ id: "f1", type: "box", length: 20, width: 10, height: 5 }] });
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], "dropped.funda"));
      const el = document.querySelector("#stage .home");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    }, doc);
    await page.waitForSelector("button:has-text('Discard')", { timeout: 5000 });
    await page.click("button:has-text('Discard')");
    await settle();
    const dropped = await page.evaluate(() => ({ name: window.store.fileName, n: window.store.document.features.length }));
    check("the dropped document opened", /dropped/.test(dropped.name) && dropped.n === 1, JSON.stringify(dropped));
    check("Home closed", !(await homeUp()));
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
