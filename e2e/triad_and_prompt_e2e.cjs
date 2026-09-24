// The origin triad as a passive marker beside the Move gizmo, and the prompt
// banner kept in the free space between the floating columns.
//
// Shots: triad_alone (dark and light theme), triad_vs_move (the triad at the
// origin, the Move gizmo on a box off to the side), prompt_model,
// prompt_render (Render with the key light's Aim prompt), prompt_render_1000
// and prompt_model_1000 (a 1000px wide window).
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5952/ SC_ENGINE_PORT=8952 \
//     node e2e/triad_and_prompt_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "triad_prompt_shots");
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
  await page.addInitScript((port) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) { super(String(u).replace(":8765", `:${port}`), p); }
    }
    window.WebSocket = P;
  }, ENGINE_PORT);

  const boot = async () => {
    await page.goto(`${URL}?token=${TOKEN}`);
    await page.waitForTimeout(2500);
    const modal = await page.$(".modal-close");
    if (modal) { await modal.click(); await page.waitForTimeout(400); }
    await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });
  };
  await boot();

  const shot = async (name, clip) => page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
  const settle = async () => {
    await page.waitForTimeout(250);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(250);
  };
  const origin = () => page.evaluate(() => window.viewport.projectToScreen({ x: 0, y: 0, z: 0 }));
  const around = (p, r) => ({ x: Math.max(0, p.x - r), y: Math.max(0, p.y - r), width: 2 * r, height: 2 * r });
  const iso = async (target, scale) => {
    await page.evaluate(() => window.__fundacad.handleAction("iso"));
    await page.waitForTimeout(700);
    await page.evaluate(({ target, scale }) => {
      const V = window.viewport.camera.position.constructor;
      window.viewport.rig.moveTo(new V(...target), false);
      window.viewport.rig.setViewScale(scale, false);
      window.viewport.requestRender();
    }, { target, scale });
    await page.waitForTimeout(400);
  };

  // --- the triad on its own --------------------------------------------------------
  console.log("\n[triad]");
  const look = await page.evaluate(() => {
    const t = window.viewport.scene.triad;
    let cones = 0;
    let opaque = 0;
    t.group.traverse((o) => {
      if (o.geometry?.type === "ConeGeometry") cones++;
      const m = o.material;
      if (m && m.visible && (!m.transparent || m.opacity >= 1)) opaque++;
    });
    return { cones, opaque };
  });
  check("the triad draws no arrowheads", look.cones === 0, JSON.stringify(look));
  check("every drawn part of the triad is translucent", look.opaque === 0, JSON.stringify(look));
  await iso([0, 0, 0], 60);
  await page.mouse.move(1380, 600);
  const o0 = await origin();
  await shot("triad_alone", around(o0, 140));
  const hover = await page.evaluate(({ x, y }) => {
    const v = window.viewport;
    const t = v.scene.triad;
    const before = [];
    t.group.traverse((o) => { if (o.material?.color) before.push(o.material.color.getHex()); });
    return { x, y, before };
  }, o0);
  await page.mouse.move(o0.x + 20, o0.y);
  await page.mouse.move(o0.x + 24, o0.y - 2);
  await page.waitForTimeout(200);
  const afterHover = await page.evaluate(() => {
    const out = [];
    window.viewport.scene.triad.group.traverse((o) => { if (o.material?.color) out.push(o.material.color.getHex()); });
    return out;
  });
  check("hovering the triad does not light it", JSON.stringify(afterHover) === JSON.stringify(hover.before));

  // --- the triad beside the Move gizmo -------------------------------------------------
  console.log("\n[triad vs move]");
  await page.evaluate(async () => {
    window.store.addFeature({ id: "B0", type: "box", length: 30, width: 30, height: 10 });
    window.store.addFeature({ id: "M0", type: "move", dx: 45, dy: 0, dz: 5, rx: 0, ry: 0, rz: 0 });
    await window.store.rebuildNow();
  });
  await settle();
  await iso([22, 0, 5], 110);
  const body = await page.evaluate(() => window.viewport.model?.bodies?.[0]?.id ?? null);
  await page.evaluate((id) => window.__fundacad.move.start([id], () => {}), body);
  await page.waitForTimeout(500);
  check("the Move gizmo is up on the box", await page.evaluate(() => window.__fundacad.move.active));
  await page.mouse.move(700, 850);
  await page.waitForTimeout(300);
  const o1 = await origin();
  const g = await page.evaluate(() => window.viewport.projectToScreen(window.__fundacad.move.gizmo.position));
  const x0 = Math.max(0, Math.min(o1.x, g.x) - 150);
  const y0 = Math.max(0, Math.min(o1.y, g.y) - 150);
  await shot("triad_vs_move", { x: x0, y: y0, width: Math.abs(g.x - o1.x) + 300, height: Math.abs(g.y - o1.y) + 300 });

  // --- the prompt, clear of both columns -------------------------------------------------
  const overlaps = () => page.evaluate(() => {
    const p = document.querySelector("#viewport .prompt");
    if (!p || p.classList.contains("hidden")) return { shown: false };
    const r = p.getBoundingClientRect();
    // Every card the user sees. The rail's own box is not one: it runs the full
    // height at the width of its widest label, most of it empty.
    const sel = "#float-layer .float-left-stack > *, #float-layer .tool-rail .rail-btn, #float-layer .tool-rail .rail-group, #float-layer .float-right > *, #renderdock";
    const hits = [];
    for (const el of document.querySelectorAll(sel)) {
      const q = el.getBoundingClientRect();
      if (q.width <= 0 || q.height <= 0) continue;
      const w = Math.min(r.right, q.right) - Math.max(r.left, q.left);
      const h = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
      if (w > 0 && h > 0) hits.push(`${el.id || el.className} ${Math.round(w)}x${Math.round(h)}`);
    }
    const vp = document.querySelector("#viewport").getBoundingClientRect();
    return {
      shown: true,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      inside: r.left >= vp.left && r.right <= vp.right,
      style: p.getAttribute("style"),
      viewport: [Math.round(vp.left), Math.round(vp.right)],
      hits,
    };
  });
  const promptCheck = async (label) => {
    const o = await overlaps();
    check(`${label}: the prompt is up`, o.shown);
    check(`${label}: the prompt stays inside the viewport and clear of every column`, o.shown && o.inside && o.hits.length === 0, JSON.stringify(o));
  };

  console.log("\n[prompt, model]");
  await promptCheck("model");
  await shot("prompt_model");
  await page.evaluate(() => window.__fundacad.move.cancel());

  console.log("\n[prompt, render]");
  await page.evaluate(() => window.__fundacad.handleAction("materials"));
  await page.waitForTimeout(600);
  await page.click('.rd-tab[data-tab="environment"]');
  await page.waitForTimeout(200);
  if (!(await page.evaluate(() => document.querySelector('[data-shadows="mode"]')?.getAttribute("aria-pressed") === "true"))) {
    await page.click('[data-shadows="mode"]');
  }
  await page.click('[data-key-light="aim"]');
  await page.waitForTimeout(400);
  check("Aim raises the sun", await page.evaluate(() => window.__fundacad.lightAim.active));
  await promptCheck("render");
  await shot("prompt_render");

  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(600);
  await promptCheck("render at 1000px");
  await shot("prompt_render_1000");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.click('[data-workspace="model"]');
  await page.waitForTimeout(600);
  check("back in Model, no Render panel", await page.evaluate(() => !document.querySelector("#renderdock")));
  await page.evaluate((id) => window.__fundacad.move.start([id], () => {}), body);
  await page.waitForTimeout(500);
  await promptCheck("model at 1000px");
  await shot("prompt_model_1000");
  await page.evaluate(() => window.__fundacad.move.cancel());

  // --- the triad under a light theme ------------------------------------------------------
  console.log("\n[light theme]");
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(() => localStorage.setItem("fundacad.theme", "solarized-light"));
  await boot();
  await iso([0, 0, 0], 60);
  await page.mouse.move(1380, 600);
  await shot("triad_alone_light", around(await origin(), 140));
  await page.evaluate(() => localStorage.removeItem("fundacad.theme"));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
