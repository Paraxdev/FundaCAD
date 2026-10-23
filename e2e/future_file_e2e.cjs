// A file from a newer version (tests/fixtures/future/v99.funda) dropped on the
// window, in a real browser against the real geometry engine.
//
//   1. The open notice names the feature this version does not know.
//   2. That feature shows greyed in the history, not as an error, and a feature
//      that needs its body says why it failed.
//   3. Saving writes back what this version does not know.
//   4. The placeholder offers no Edit, and a new document takes the notice down.
//
// Usage (from the repo root, with vite and the engine (`fundacad-engine --ws`) running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] node e2e/future_file_e2e.cjs
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const V99 = fs.readFileSync(path.join(__dirname, "../tests/fixtures/future/v99.funda"), "utf8");

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.addInitScript(
    ({ t, port }) => {
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
    { t: TOKEN, port: PORT },
  );
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const settle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.store.buildState.building && !window.store.busy?.active, null, {
      timeout: 120000,
    });
  };

  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "v99.funda"));
    const el = document.querySelector("canvas") || document.body;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
      }),
    );
  }, V99);
  await page.waitForTimeout(500);
  const discard = await page.$("button:has-text('Discard')");
  if (discard) await discard.click();
  await settle();

  console.log("1. the open notice");
  const toasts = await page.evaluate(() =>
    [...document.querySelectorAll(".toast .toast-msg")].map((e) => e.textContent ?? ""),
  );
  check(
    "one notice names futureWidget",
    toasts.filter((t) => /newer version/.test(t) && /futureWidget/.test(t)).length === 1,
    JSON.stringify(toasts),
  );

  console.log("2. the history");
  const bar = await page.evaluate(() => document.querySelector('.timeline-node[data-id="w1"]')?.className ?? null);
  check(
    "w1 is a greyed placeholder, not an error",
    bar !== null && /placeholder/.test(bar) && !/\berror\b/.test(bar),
    String(bar),
  );
  const fillet = await page.evaluate(
    () => window.store.buildState.result?.featureErrors?.find((e) => e.feature_id === "f1")?.message ?? "",
  );
  check("the fillet on its body says why it failed", /w1 is from a newer version/.test(fillet), fillet);
  const built = await page.evaluate(() => window.store.document.features.map((f) => f.id));
  check(
    "the rest of the history is there",
    JSON.stringify(built) === '["s1","e1","w1","f1","b1"]',
    JSON.stringify(built),
  );

  console.log("3. saving");
  const saved = await page.evaluate(() => JSON.parse(window.store.toJSON()));
  const input = JSON.parse(V99);
  check(
    "futureKey comes back",
    JSON.stringify(saved.futureKey) === JSON.stringify(input.futureKey),
    JSON.stringify(saved.futureKey),
  );
  check(
    "w1 comes back",
    JSON.stringify(saved.features.find((f) => f.id === "w1")) ===
      JSON.stringify(input.features.find((f) => f.id === "w1")),
  );

  console.log("4. moving on");
  await page.click('.timeline-node[data-id="w1"]', { button: "right" });
  await page.waitForTimeout(200);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll(".context-menu .ctx-item")].map((e) => e.textContent?.trim() ?? ""),
  );
  await page.keyboard.press("Escape");
  check(
    "the placeholder's menu offers no Edit",
    items.length > 0 && !items.some((t) => /^Edit/.test(t)),
    JSON.stringify(items),
  );
  await page.evaluate(() => window.store.newDocument());
  await page.waitForTimeout(600);
  const left = await page.evaluate(() =>
    [...document.querySelectorAll(".toast .toast-msg")]
      .map((e) => e.textContent ?? "")
      .filter((t) => /newer version/.test(t)),
  );
  check("a new document takes the notice down", left.length === 0, JSON.stringify(left));

  await browser.close();
  console.log(failures ? `FAILED: ${failures}` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
