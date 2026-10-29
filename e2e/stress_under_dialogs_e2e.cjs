// The Stress panel stays under dialogs and clear of the view controls, in a
// real browser where happy-dom has no layout.
//
//   1. With Stress open over a body, Edit > Preferences opens, and the panel
//      covers the Theme select's centre (CONTROL, or the check proves nothing).
//   2. The point there lands in the select, not the panel, and a click opens
//      its list; at the old z 1500 the same point landed in the panel.
//   3. In Render the panel stays open, clear of the view controls and the tool
//      rail, narrowed to the span between them when it would not fit.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] node e2e/stress_under_dialogs_e2e.cjs [shots dir]
const { chromium } = require("playwright-core");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const SHOTS = process.argv[2] || "";
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
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.goto(`${URL}?token=${TOKEN}&engine=${PORT}`, { timeout: 120000 });
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const shot = async (name) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };

  await page.evaluate(async () => {
    window.store.addFeature({ id: "block", type: "box", length: 40, width: 20, height: 10 });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("stress"));
  await page.waitForSelector(".measure-panel.stress-panel", { state: "visible", timeout: 15000 });
  await page.waitForTimeout(400);

  const rect = (sel) =>
    page.evaluate((s) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    }, sel);
  const meets = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const hitAt = (x, y) =>
    page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px, py);
        const inSelect = !!el?.closest("#prefs-theme");
        const inPanel = !!el?.closest(".measure-panel");
        const where = inSelect ? "in #prefs-theme" : inPanel ? "in .measure-panel" : "elsewhere";
        return { inSelect, inPanel, what: el ? `${el.tagName}.${el.className} ${where}` : "nothing" };
      },
      [x, y],
    );

  console.log("\n1. Preferences over Stress");
  await shot("stress_open");
  const clickText = async (sel, text) => {
    const box = await page.evaluate(
      ([s, t]) => {
        const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(t));
        const r = el?.getBoundingClientRect();
        return r ? { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } : null;
      },
      [sel, text],
    );
    if (!box) throw new Error(`no ${sel} reading ${text}`);
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(200);
  };
  await clickText("#menubar .menu-btn", "Edit");
  await clickText(".menu-item", "Preferences");
  await page.waitForSelector("#prefs-theme", { state: "visible", timeout: 15000 });
  await page.waitForTimeout(300);
  await shot("prefs_over_stress");
  const panel = await rect(".measure-panel.stress-panel");
  const select = await rect("#prefs-theme");
  const cx = select ? (select.left + select.right) / 2 : 0;
  const cy = select ? (select.top + select.bottom) / 2 : 0;
  const covers = !!panel && panel.left < cx && cx < panel.right && panel.top < cy && cy < panel.bottom;
  check("CONTROL: the Stress panel covers the Theme select centre", covers, JSON.stringify({ panel, select }));

  console.log("\n2. the Theme select is reachable");
  const hit = await hitAt(cx, cy);
  check("the select centre lands in the select", hit.inSelect && !hit.inPanel, hit.what);
  await page.evaluate(() => {
    const p = document.querySelector(".measure-panel.stress-panel");
    p.dataset.z = p.style.zIndex;
    p.style.zIndex = "1500";
  });
  const old = await hitAt(cx, cy);
  check("CONTROL: at the old z 1500 the same point lands in the panel", old.inPanel, old.what);
  await page.evaluate(() => {
    const p = document.querySelector(".measure-panel.stress-panel");
    p.style.zIndex = p.dataset.z;
  });
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  const list = await rect(".float-popover.select-pop");
  check("a click there opens the Theme list", !!list, JSON.stringify(list));
  if (list) {
    const inList = await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".float-popover.select-pop"),
      [(list.left + list.right) / 2, (list.top + list.bottom) / 2],
    );
    check("the list centre lands in the list", inList);
  }
  await shot("theme_list_open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#prefs-theme", { state: "detached", timeout: 5000 }).catch(() => {});
  check("Preferences closes", !(await page.$("#prefs-theme")));

  console.log("\n3. Stress in Render");
  await page.click('#workspace-toggle [data-workspace="render"]');
  await page.waitForSelector("#renderdock", { timeout: 15000 });
  await page.waitForTimeout(800);
  await shot("stress_in_render");
  const open = await page.$(".measure-panel.stress-panel");
  check("the Stress panel stays open in Render", !!open);
  const inRender = await rect(".measure-panel.stress-panel");
  const modes = await rect("#float-layer .view-modes");
  check("CONTROL: the view modes group is there", !!modes, JSON.stringify(modes));
  check("the panel is clear of the view modes group", !meets(inRender, modes), JSON.stringify({ inRender, modes }));
  const groups = await page.$$eval("#float-layer .float-group", (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  );
  const over = groups.filter((g) => meets(inRender, g));
  check("and clear of every view control group", over.length === 0, `${over.length} of ${groups.length} meet it`);

  // The rail's buttons and groups rather than the rail, whose box runs the full height at its widest label.
  const railHits = () =>
    page.evaluate(() => {
      const p = document.querySelector(".measure-panel.stress-panel").getBoundingClientRect();
      const rail = [
        ...document.querySelectorAll("#float-layer .tool-rail .rail-btn, #float-layer .tool-rail .rail-group"),
      ];
      const hit = rail.filter((e) => {
        const r = e.getBoundingClientRect();
        return p.left < r.right && r.left < p.right && p.top < r.bottom && r.top < p.bottom;
      });
      return { hit: hit.length, of: rail.length, left: Math.round(p.left), width: Math.round(p.width) };
    });
  const railNow = await railHits();
  check("CONTROL: the tool rail is there", railNow.of > 0, `${railNow.of} buttons and groups`);
  check("the panel is clear of the tool rail", railNow.hit === 0, JSON.stringify(railNow));
  const unclamped = await page.evaluate(() => {
    const p = document.querySelector(".measure-panel.stress-panel");
    const kept = p.style.maxWidth;
    p.style.maxWidth = "";
    const width = Math.round(p.getBoundingClientRect().width);
    p.style.maxWidth = kept;
    return width;
  });
  check(
    "CONTROL: without its max-width the panel is wider than the span it gets",
    unclamped > railNow.width,
    `${unclamped} against ${railNow.width}`,
  );
  // Any box in the panel that clips or scrolls sideways, leaving out text that ends in an ellipsis on purpose.
  const spill = await page.evaluate(() => {
    const p = document.querySelector(".measure-panel.stress-panel");
    return [p, ...p.querySelectorAll("*")]
      .filter((e) => {
        const cs = getComputedStyle(e);
        return cs.overflowX !== "visible" && cs.textOverflow !== "ellipsis" && e.scrollWidth > e.clientWidth + 1;
      })
      .map((e) => `${e.tagName}.${[...e.classList].join(".")} ${e.scrollWidth} in ${e.clientWidth}`);
  });
  check("the narrowed panel's content still fits its width", spill.length === 0, spill.join(", "));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
