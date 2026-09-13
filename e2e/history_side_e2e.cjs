// The history stood on end (Preferences, History: right), in a real browser.
//
// What only layout can answer, and happy-dom has none:
//   1. Every row fits the column: nothing is wider than the list, so there is no
//      sideways overflow to scroll into and no row cut off at the edge.
//   2. The mouse wheel scrolls the column DOWN. The wheel handler that turns a
//      vertical wheel into sideways scrolling belongs to the bottom strip only.
//   3. The last row can be scrolled fully into view, clear of anything floating
//      over the panel's corner.
//   4. The bottom strip still scrolls sideways (the control for 2).
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chromium or brave> node e2e/history_side_e2e.cjs [doc.funda]
// With no document it makes a 60 step one (a long history is the whole point);
// any real part works too, the radio reprod is a good heavy one.
// SC_APP_PORT and SC_SIDECAR_PORT move it off 5173/8765, to run beside a dev
// session (the sidecar then needs FUNDACAD_EXTRA_ORIGINS for that app port).
const { chromium } = require("playwright-core");
const fs = require("fs");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const APP_PORT = process.env.SC_APP_PORT || "5173";
const WS_PORT = process.env.SC_SIDECAR_PORT || "8765";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

function longHistory(pairs) {
  const features = [];
  for (let i = 0; i < pairs; i++) {
    features.push({ id: `sk${i}`, type: "sketch", plane: "XY", entities: [{ id: `c${i}`, type: "circle", radius: 3, x: i * 8, y: 0 }] });
    features.push({ id: `ex${i}`, type: "extrude", sketch: `sk${i}`, distance: 2 + (i % 5) });
  }
  return JSON.stringify({ version: 9, parameters: {}, paramDefs: {}, features });
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  const doc = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : longHistory(30);
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
  const count = await page.evaluate(async (text) => {
    window.store.load(text);
    (await import("/src/ui/layoutPrefs.ts")).setLayoutPref("history", "right");
    return window.store.document.features.length;
  }, doc);
  await page.waitForTimeout(1500);

  const measure = () => page.evaluate(() => {
    const sc = document.querySelector("#timeline .timeline-scroll");
    const r = sc.getBoundingClientRect();
    const nodes = [...sc.querySelectorAll(".timeline-node")];
    const out = nodes.filter((n) => {
      const b = n.getBoundingClientRect();
      return b.left < r.left - 0.5 || b.right > r.left + sc.clientWidth + 0.5;
    }).length;
    return {
      // feature rows only: while a build runs, its progress chip is a row too
      nodes: sc.querySelectorAll(".timeline-node[data-id]").length, clientWidth: sc.clientWidth, scrollWidth: sc.scrollWidth,
      scrollTop: sc.scrollTop, scrollLeft: sc.scrollLeft, maxTop: sc.scrollHeight - sc.clientHeight, outside: out,
      box: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  });

  const m0 = await measure();
  check("the column shows every step", m0.nodes === count, `${m0.nodes} of ${count}`);
  check("a long history overflows the column downward, so it has to scroll", m0.maxTop > 0, `${m0.maxTop}px to scroll`);
  check("no row is wider than the column", m0.scrollWidth <= m0.clientWidth, `scrollWidth ${m0.scrollWidth}, clientWidth ${m0.clientWidth}`);
  check("no row pokes out of the column's sides", m0.outside === 0, `${m0.outside} rows outside`);

  // a real wheel over the list, from the top
  await page.evaluate(() => { const sc = document.querySelector("#timeline .timeline-scroll"); sc.scrollTop = 0; sc.scrollLeft = 0; });
  await page.mouse.move(m0.box.x + m0.box.w / 2, m0.box.y + m0.box.h / 2);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(80); }
  await page.waitForTimeout(400);
  const m1 = await measure();
  check("the wheel scrolls the column down", m1.scrollTop > 0, `scrollTop ${m1.scrollTop}`);
  check("the wheel does not scroll it sideways", m1.scrollLeft === 0, `scrollLeft ${m1.scrollLeft}`);
  check("rows still fit after scrolling", m1.outside === 0, `${m1.outside} rows outside`);

  // the last row, scrolled to the bottom, is fully visible and on top
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(600);
  const last = await page.evaluate(() => {
    const sc = document.querySelector("#timeline .timeline-scroll");
    const r = sc.getBoundingClientRect();
    const nodes = sc.querySelectorAll(".timeline-node");
    const n = nodes[nodes.length - 1];
    const b = n.getBoundingClientRect();
    const probes = [[b.left + 6, b.top + b.height / 2], [b.right - 6, b.top + b.height / 2], [b.left + b.width / 2, b.bottom - 3]];
    const covered = probes.filter(([x, y]) => !n.contains(document.elementFromPoint(x, y))).length;
    return { inside: b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5, covered, atEnd: sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1 };
  });
  check("the wheel reaches the end of the history", last.atEnd);
  check("the last row is fully inside the column", last.inside);
  check("nothing floats over the last row", last.covered === 0, `${last.covered} of 3 points covered`);
  await page.screenshot({ path: "/tmp/history_side.png" }).catch(() => {});

  // control: the strip along the bottom still turns the wheel sideways
  await page.evaluate(async () => (await import("/src/ui/layoutPrefs.ts")).setLayoutPref("history", "bottom"));
  await page.waitForTimeout(800);
  const strip = await page.evaluate(() => {
    const sc = document.querySelector("#timeline .timeline-scroll");
    sc.scrollLeft = 0;
    const r = sc.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, over: sc.scrollWidth > sc.clientWidth };
  });
  await page.mouse.move(strip.x, strip.y);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(80); }
  await page.waitForTimeout(300);
  const left = await page.evaluate(() => document.querySelector("#timeline .timeline-scroll").scrollLeft);
  check("the bottom strip still scrolls sideways under a vertical wheel", !strip.over || left > 0, `scrollLeft ${left}`);

  console.log(failures ? `FAILED (${failures})` : "all history column checks passed");
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
