// The origin planes as three small tiles beside the origin: shown only while a
// tool asks for a plane, a constant size on screen, each picking its own plane,
// in Noir and Solarized Light. SC_VARIANTS=1 also writes the corner comparison
// renders (circular corners against the rho 0.25 profile, close and far).
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5952/ SC_ENGINE_PORT=8952 \
//     [SC_GPU=1] [SC_VARIANTS=1] node e2e/origin_tiles_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.env.SC_OUT || process.argv[2] || "origin_tiles_shots");
const VARIANTS = process.env.SC_VARIANTS === "1";
// A real GPU antialiases the rounded corners the comparison renders are about.
const GPU = process.env.SC_GPU === "1" || VARIANTS;
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const PLANES = ["XY", "XZ", "YZ"];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const args = GPU
    ? ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--no-sandbox"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"];
  const browser = await chromium.launch({ executablePath: EXE, args });
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
    await page.mouse.move(1390, 890);
  };
  const settle = async () => {
    await page.waitForTimeout(250);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(250);
  };
  const frame = () => page.waitForTimeout(250);
  const shot = (name, clip) => page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
  const around = (p, r) => ({ x: Math.max(0, p.x - r), y: Math.max(0, p.y - r), width: 2 * r, height: 2 * r });
  const origin = () => page.evaluate(() => window.viewport.projectToScreen({ x: 0, y: 0, z: 0 }));
  const askPlane = async () => {
    await page.evaluate(() => window.__fundacad.handleAction("sketch"));
    await page.waitForTimeout(500);
  };
  const escape = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  };
  const home = async (target, scale) => {
    await page.evaluate(({ target, scale }) => {
      const v = window.viewport;
      v.resetCamera(false);
      const V = v.camera.position.constructor;
      v.rig.moveTo(new V(...target), false);
      v.rig.setViewScale(scale, false);
      v.requestRender();
    }, { target, scale });
    await frame();
  };
  const top = async (target, scale) => {
    await page.evaluate(({ target, scale }) => {
      const v = window.viewport;
      v.setStandardView("top");
      const V = v.camera.position.constructor;
      v.rig.moveTo(new V(...target), false);
      v.rig.setViewScale(scale, false);
      v.requestRender();
    }, { target, scale });
    await page.waitForTimeout(900);
  };
  const tiles = () => page.evaluate((planes) => {
    const v = window.viewport;
    return Object.fromEntries(planes.map((k) => {
      const m = v.scene.planes[k];
      const c = v.projectToScreen(m.getWorldPosition(m.position.clone()));
      return [k, { visible: m.visible, x: c.x, y: c.y, fill: m.material.opacity }];
    }));
  }, PLANES);
  // On screen length of the XY tile's side, and what the size rule says it should be.
  const xySide = () => page.evaluate(() => {
    const v = window.viewport;
    const m = v.scene.planes.XY;
    m.updateWorldMatrix(true, false);
    const V = m.position.constructor;
    const a = v.projectToScreen(new V(-20, 0, 0).applyMatrix4(m.matrixWorld));
    const b = v.projectToScreen(new V(20, 0, 0).applyMatrix4(m.matrixWorld));
    const pws = v.pixelWorldSize(new V(0, 0, 0));
    const diag = v.modelDiagonal();
    const k = diag == null ? 1 : Math.max(0.6, Math.min(1, (diag / pws) * 0.45 / 46));
    return { px: Math.hypot(b.x - a.x, b.y - a.y), want: 40 * k };
  });

  await boot();

  console.log("\n[shown only while a tool asks for a plane]");
  check("no tile before a plane pick", Object.values(await tiles()).every((t) => !t.visible));
  await home([0, 0, 0], 60);
  await askPlane();
  let t = await tiles();
  check("three tiles while Sketch asks for a plane", PLANES.every((k) => t[k].visible), JSON.stringify(t));
  const picks = await page.evaluate((t) => Object.fromEntries(Object.entries(t).map(([k, p]) => {
    const c = window.viewport.pickConstructionAt(p.x, p.y);
    return [k, { construction: c?.kind === "base" ? c.plane : null, plane: window.viewport.pickPlane(p.x, p.y) }];
  })), t);
  check("each tile's middle picks its own plane", PLANES.every((k) => picks[k].construction === k && picks[k].plane === k), JSON.stringify(picks));
  const o = await origin();
  check("the tiles sit beside the origin, not on it", PLANES.every((k) => Math.hypot(t[k].x - o.x, t[k].y - o.y) > 15),
    JSON.stringify({ o, t }));
  check("the origin itself picks no tile", (await page.evaluate((p) => window.viewport.pickPlane(p.x, p.y), o)) === null);
  await shot("tiles-noir", around(o, 170));

  console.log("\n[hover]");
  await page.mouse.move(t.XZ.x, t.XZ.y);
  await page.waitForTimeout(250);
  let h = await tiles();
  check("the hovered tile brightens above the others", h.XZ.fill > h.XY.fill && h.XZ.fill > h.YZ.fill, JSON.stringify(h));
  await shot("tiles-hover-xz-noir", around(o, 170));
  await page.mouse.move(1390, 890);
  await page.waitForTimeout(250);
  h = await tiles();
  check("off the tiles all three are alike", h.XY.fill === h.XZ.fill && h.XZ.fill === h.YZ.fill, JSON.stringify(h));

  console.log("\n[constant size]");
  for (const scale of [40, 3000]) {
    await top([0, 0, 0], scale);
    const s = await xySide();
    check(`top view at scale ${scale}: the XY tile is 40 px`, Math.abs(s.px - 40) <= 1, JSON.stringify(s));
  }
  await escape();
  check("Escape hides the tiles", Object.values(await tiles()).every((x) => !x.visible));

  console.log("\n[a small part shrinks them, never below 24 px]");
  await page.evaluate(async () => {
    window.store.addFeature({ id: "TB", type: "box", length: 4, width: 4, height: 4 });
    window.store.addFeature({ id: "TM", type: "move", dx: 37, dy: 23, dz: 2, rx: 0, ry: 0, rz: 0 });
    await window.store.rebuildNow();
  });
  await settle();
  await askPlane();
  const sizes = [];
  for (const scale of [30, 40, 120]) {
    await top([18, 11, 0], scale);
    sizes.push({ scale, ...(await xySide()) });
  }
  check("each size follows the rule", sizes.every((s) => Math.abs(s.px - s.want) <= 1), JSON.stringify(sizes));
  check("all between 24 and 40 px", sizes.every((s) => s.px >= 23 && s.px <= 41), JSON.stringify(sizes));
  check("one shrunk below 40 px and above the floor", sizes.some((s) => s.want < 39 && s.want > 25), JSON.stringify(sizes));
  check("one held at the 24 px floor", sizes.some((s) => Math.abs(s.want - 24) < 1e-6), JSON.stringify(sizes));
  await escape();
  await page.evaluate(async () => {
    window.store.removeFeature?.("TM");
    window.store.removeFeature?.("TB");
    await window.store.rebuildNow();
  });
  await settle();

  console.log("\n[a click sketches on the plane]");
  await home([0, 0, 0], 60);
  await askPlane();
  t = await tiles();
  await page.mouse.move(t.XY.x, t.XY.y);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(() => window.sketch.active, null, { timeout: 15000 }).catch(() => {});
  const took = await page.evaluate(() => ({ active: window.sketch.active, plane: window.sketch.plane ?? null }));
  check("clicking the XY tile opens a sketch on XY", took.active && JSON.stringify(took.plane).includes("XY"), JSON.stringify(took));
  check("the tiles hide once the sketch is open", Object.values(await tiles()).every((x) => !x.visible));
  await page.evaluate(() => window.sketch.cancel());
  await page.waitForTimeout(300);

  console.log("\n[Solarized Light]");
  await page.evaluate(() => localStorage.setItem("fundacad.theme", "solarized-light"));
  await boot();
  await home([0, 0, 0], 60);
  await askPlane();
  const lo = await origin();
  await shot("tiles-solarized", around(lo, 170));
  const ink = await page.evaluate(() => {
    const m = window.viewport.scene.planes.XY;
    const label = m.children.find((c) => c.userData.role === "label");
    return label.material.color.getHex().toString(16);
  });
  check("names take the dark text colour on the light ground", ink === "73642", ink);
  t = await tiles();
  await page.mouse.move(t.XZ.x, t.XZ.y);
  await page.waitForTimeout(250);
  await shot("tiles-hover-xz-solarized", around(lo, 170));
  await page.mouse.move(1390, 890);
  await escape();
  await page.evaluate(() => localStorage.removeItem("fundacad.theme"));

  if (VARIANTS) await renders();

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);

  async function renders() {
    console.log("\n[comparison renders]");
    const reshape = (shape) => page.evaluate((s) => {
      window.viewport.scene.originTiles.reshape(s);
      window.viewport.requestRender();
    }, shape);
    const DEFAULT = { sizePx: 40, gapPx: 6, radiusPx: 11, rho: 0.25, octant: { x: 1, y: -1, z: 1 } };
    const CIRCLE = Math.SQRT2 - 1;
    const BIG = { sizePx: 240, radiusPx: 66, gapPx: 36 };
    for (const theme of ["noir", "solarized"]) {
      await page.evaluate((th) => {
        if (th === "solarized") localStorage.setItem("fundacad.theme", "solarized-light");
        else localStorage.removeItem("fundacad.theme");
      }, theme);
      await boot();
      await page.evaluate(async () => {
        window.store.addFeature({ id: "RB", type: "box", length: 30, width: 20, height: 12 });
        window.store.addFeature({ id: "RM", type: "move", dx: 75, dy: 10, dz: 6, rx: 0, ry: 0, rz: 0 });
        await window.store.rebuildNow();
      });
      await settle();
      await home([0, 0, 0], 60);
      await askPlane();
      for (const [name, rho] of [["circle", CIRCLE], ["rho025", 0.25]]) {
        await reshape({ ...DEFAULT, rho });
        await home([0, 0, 0], 60);
        await shot(`corner-${name}-${theme}-close`, around(await origin(), 170));
        await home([0, 0, 0], 1500);
        await shot(`corner-${name}-${theme}-far`, around(await origin(), 170));
      }
      await reshape(DEFAULT);
      await home([0, 0, 0], 60);
      await shot(`full-rho025-${theme}`);
      if (theme === "noir") {
        await page.evaluate(() => { document.documentElement.classList.add("no-glass-blur"); window.viewport.requestRender(); });
        await frame();
        await shot("bluroff-rho025-noir-close", around(await origin(), 170));
        await page.evaluate(() => { document.documentElement.classList.remove("no-glass-blur"); window.viewport.requestRender(); });
      }
      await page.evaluate(() => { window.viewport.hoverPlane("XZ"); });
      await frame();
      await shot(`hover-xz-${theme}`, around(await origin(), 170));
      await page.evaluate(() => { window.viewport.hoverPlane(null); });
      await reshape({ ...DEFAULT, octant: { x: -1, y: 1, z: -1 } });
      await home([0, 0, 0], 60);
      await shot(`octant-outside-${theme}-close`, around(await origin(), 170));
      for (const [name, rho] of [["circle", CIRCLE], ["rho025", 0.25], ["rho060", 0.6]]) {
        await reshape({ ...DEFAULT, ...BIG, rho });
        await top([0, 0, 0], 20);
        const c = await page.evaluate(() => {
          const m = window.viewport.scene.planes.XY;
          return window.viewport.projectToScreen(m.getWorldPosition(m.position.clone()));
        });
        await shot(`detail-${name}-${theme}`, around(c, 150));
      }
      await reshape(DEFAULT);
      await escape();
      await page.evaluate(async () => {
        window.store.removeFeature?.("RM");
        window.store.removeFeature?.("RB");
        await window.store.rebuildNow();
      });
      await settle();
      await home([0, 0, 0], 60);
      const side = await page.evaluate(() => 1.2 * 46 * window.viewport.pixelWorldSize(new (window.viewport.camera.position.constructor)(0, 0, 0)));
      await page.evaluate(async (s) => {
        window.store.addFeature({ id: "DB", type: "box", length: s, width: s, height: s });
        await window.store.rebuildNow();
      }, Math.round(side * 100) / 100);
      await settle();
      await home([0, 0, 0], 60);
      await askPlane();
      await shot(`depth-box-${theme}`, around(await origin(), 170));
      await escape();
    }
    await page.evaluate(() => localStorage.removeItem("fundacad.theme"));
  }
})().catch((e) => { console.error(e); process.exit(1); });
