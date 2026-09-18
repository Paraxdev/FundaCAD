// A fillet dragged past what the kernel can build stops at the largest radius
// that worked, in a real browser.
//
// The model is a 5 degree tapered R50 x 60 cylinder with an R40 pocket cut 40
// deep, and the fillet goes on the pocket's floor edge: 39.9 builds, 40 does not.
// Past that the drag carries on, the handle and the value box turn red with a
// plain reason, the model keeps the last radius that built, coming back under
// the limit clears it at once, and confirming commits the last good radius (or
// nothing) rather than the refused one. A typed value is refused the same way,
// and re-editing and the chamfer side behave alike.
//
// Usage (from the repo root, with vite on 5173 + a engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/fillet_refusal_e2e.cjs [outDir]
// SC_APP overrides the page URL, SC_ENGINE_PORT points the page at another sidecar.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const APP = process.env.SC_APP || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "fillet_refusal_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(([t, port]) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace("127.0.0.1:8765", `127.0.0.1:${port}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, [TOKEN, ENGINE_PORT]);

  await page.goto(APP);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.geometry, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }

  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", radius: 50, x: 0, y: 0 }] });
    s.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 60, operation: "new", taper: 5 });
    s.addFeature({ id: "s2", type: "sketch", plane: { origin: [0, 0, 60], normal: [0, 0, 1], xdir: [1, 0, 0] }, entities: [{ type: "circle", radius: 40, x: 0, y: 0 }] });
    s.addFeature({ id: "e2", type: "extrude", sketch: "s2", distance: -40, operation: "cut" });
    await s.rebuildNow();
    // Every document sent to the kernel, as the radius it previews (null for none).
    const g = window.geometry;
    const rebuild = g.rebuild.bind(g);
    window.__sent = [];
    g.rebuild = (doc) => {
      const f = doc.features.at(-1);
      window.__sent.push(f && (f.type === "fillet" || f.type === "chamfer") ? (f.radius ?? f.distance) : null);
      return rebuild(doc);
    };
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0 && !window.store.buildState.building, null, { timeout: 60000 });
  await page.evaluate(() => { window.__fundacad.handleAction("iso"); window.__fundacad.handleAction("fit"); });
  await page.waitForTimeout(800);

  const state = () => page.evaluate(() => {
    const t = window.edgeFeature, s = window.store, b = s.buildState, v = window.viewport;
    const box = [...document.querySelectorAll(".dim-input")].find((x) => x.style.display !== "none");
    return {
      active: t.active, value: Math.round(t.value * 1000) / 1000,
      shown: t.shown, refusal: t.refusalShown, range: t.range,
      handle: t.handle ? t.handle.group.children[1].material.color.getHexString() : null,
      boxBad: box?.classList.contains("dim-bad") ?? null,
      problem: box?.querySelector(".dim-problem")?.textContent ?? null,
      prompt: document.querySelector("#prompt")?.textContent ?? "",
      feats: s.document.features.filter((f) => f.type === "fillet" || f.type === "chamfer").map((f) => `${f.id}:${f.type}=${f.radius ?? f.distance}`),
      onScreen: v.lastResult === b.result, stale: v.stale,
      tris: b.result ? b.result.mesh.indices.length / 3 : null,
      error: b.errorFeatureId, sent: window.__sent.length,
    };
  });
  const settle = async () => {
    await page.waitForTimeout(200);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 30000 });
    await page.waitForTimeout(200);
  };
  const edgePt = await page.evaluate(() => {
    const v = window.viewport;
    const V = v.camera.position.constructor;
    for (let a = 0; a < 360; a += 5) {
      const r = (a * Math.PI) / 180;
      const sp = v.projectToScreen(new V(40 * Math.cos(r), 40 * Math.sin(r), 20));
      const hit = v.pickEdgeAt(sp.x, sp.y);
      if (hit && hit.edge.points.every((p) => Math.abs(p[2] - 20) < 0.5 && Math.abs(Math.hypot(p[0], p[1]) - 40) < 0.5)) return { x: sp.x, y: sp.y };
    }
    return null;
  });
  if (!edgePt) { console.error("the pocket's floor edge is not on screen"); process.exit(1); }
  // Where a handle's grab stem is on screen, which way it points, and mm per pixel.
  const grabOf = (group) => {
    group.updateMatrixWorld(true);
    const v = window.viewport;
    const V = v.camera.position.constructor;
    const o = v.projectToScreen(group.position);
    const p = v.projectToScreen(group.children[3].getWorldPosition(new V()));
    const len = Math.hypot(p.x - o.x, p.y - o.y) || 1;
    return { x: p.x, y: p.y, dx: (p.x - o.x) / len, dy: (p.y - o.y) / len, pw: v.pixelWorldSize(group.position) };
  };
  const armedGrab = () => page.evaluate(`(${grabOf})(window.edgeFeature.gizmo)`);
  const passiveGrab = () => page.evaluate(`(() => {
    let found = null;
    window.viewport.scene.scene.traverse((o) => { if (!found && o.type === "Group" && o.renderOrder === 999 && o.children.length === 4 && o.visible) found = o; });
    return found && (${grabOf})(found);
  })()`);
  const selectEdge = () => page.evaluate(([x, y]) => { const v = window.viewport; v.selectOnlyEdge(v.pickEdgeAt(x, y).edge); }, [edgePt.x, edgePt.y]);
  const along = (g, from) => (mm) => ({ x: g.x + g.dx * ((mm - from) / g.pw), y: g.y + g.dy * ((mm - from) / g.pw) });
  const sweep = async (at, from, to, step, dwell) => {
    for (let mm = from; mm <= to + 1e-9; mm += step) { const p = at(mm); await page.mouse.move(p.x, p.y); await page.waitForTimeout(dwell); }
  };

  // --- 1. the command's own handle, past the limit and back ------------------
  console.log("1. drag past what the pocket can hold, then back");
  await page.evaluate(() => window.__fundacad.handleAction("fillet"));
  await page.waitForTimeout(300);
  await page.mouse.click(edgePt.x, edgePt.y);
  await settle();
  let g = await armedGrab();
  let at = along(g, 2);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await sweep(at, 2, 38, 2, 60);
  await settle();
  const good = await state();
  check("a buildable radius previews normally", good.refusal === null && good.shown === good.value && !good.boxBad, good);
  await sweep(at, 38, 46, 0.5, 90);
  await settle();
  let far = await state();
  check("the drag carries on past the limit", far.value >= 45, far.value);
  check("the handle turns red", far.refusal !== null && far.handle !== good.handle, far.handle);
  check("the value box is refused with a plain reason", far.boxBad && /^Radius too large for the faces around this edge$/.test(far.problem ?? ""), far.problem);
  check("the prompt says what will be kept", /too large.*keeping/i.test(far.prompt), far.prompt);
  check("the model keeps the last radius that built", far.shown !== null && far.shown < 40 && far.onScreen && !far.stale, { shown: far.shown, stale: far.stale });
  check("the refusal starts at 40", far.range.refused >= 39.9 && far.range.refused <= 40.5, far.range);
  await page.screenshot({ path: `${OUT}/1-refused.png` });
  const sentBefore = far.sent;
  await sweep(at, 46, 55, 0.5, 40);
  await settle();
  far = await state();
  check("dragging further past a known refusal asks the kernel nothing", far.sent === sentBefore, `${sentBefore} -> ${far.sent}`);
  const back = at(30);
  await page.mouse.move(back.x, back.y, { steps: 6 });
  const instant = await state();
  check("coming back under the limit clears the refusal at once", instant.refusal === null && !instant.boxBad, instant);
  await settle();
  const backed = await state();
  check("and the preview follows it", backed.shown === backed.value && backed.value < 40, backed);
  await sweep(at, 30, 39.5, 0.5, 80);
  await settle();
  await sweep(at, 39.5, 48, 1, 40);
  await settle();
  await page.mouse.up();
  const beforeEnter = await state();
  await page.keyboard.press("Enter");
  await settle();
  const c1 = await state();
  check("confirming a refused drag commits the last radius that built", !c1.active && c1.feats.length === 1 && c1.feats[0].endsWith(`=${beforeEnter.shown}`) && c1.error === null, c1.feats);
  await page.evaluate(() => window.store.undo());
  await settle();

  // --- 2. the selection handle: press, pull past the limit, release ----------
  console.log("2. select the edge, pull its handle past the limit, release");
  await selectEdge();
  await page.waitForTimeout(500);
  g = await passiveGrab();
  at = along(g, 0);
  await page.mouse.move(g.x, g.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(150);
  check("pressing the selection handle arms the fillet at zero", (await state()).active);
  await sweep(at, 1, 39, 1.5, 60);
  await settle();
  await sweep(at, 39, 50, 1, 60);
  await settle();
  const beforeRelease = await state();
  check("refused before release", beforeRelease.refusal !== null, beforeRelease.refusal);
  await page.screenshot({ path: `${OUT}/2-refused.png` });
  await page.mouse.up();
  await settle();
  const c2 = await state();
  check("releasing commits the last good radius, not the refused one", !c2.active && c2.feats.length === 1 && c2.feats[0].endsWith(`=${beforeRelease.shown}`), c2.feats);
  await page.evaluate(() => window.store.undo());
  await settle();

  // --- 3. a fling released before the kernel has caught up -------------------
  console.log("3. fling to 60 and let go at once");
  await selectEdge();
  await page.waitForTimeout(400);
  g = await passiveGrab();
  at = along(g, 0);
  await page.mouse.move(g.x, g.y);
  await page.waitForTimeout(150);
  const sent0 = (await state()).sent;
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) { const p = at(1.5 * i); await page.mouse.move(p.x, p.y); }
  await page.mouse.up();
  await settle();
  await page.waitForTimeout(500);
  await settle();
  const fling = await state();
  const sent = await page.evaluate((n) => window.__sent.slice(n), sent0);
  check("40 pointermoves do not queue 40 kernel calls", sent.length <= 12, `${sent.length} rebuilds: ${JSON.stringify(sent)}`);
  const flingR = fling.feats.length ? Number(fling.feats[0].split("=")[1]) : null;
  check("what it commits is a radius that built, never 60", !fling.active && (flingR === null || (flingR < 40 && fling.error === null)), fling.feats);
  await page.evaluate(() => window.store.undo());
  await settle();

  // --- 4. typed values --------------------------------------------------------
  console.log("4. type a radius that fits, one that does not, then a smaller one");
  await page.evaluate(() => window.__fundacad.handleAction("fillet"));
  await page.waitForTimeout(300);
  await page.mouse.click(edgePt.x, edgePt.y);
  await settle();
  const input = page.locator(".dim-input:visible input").first();
  const type = async (v) => { await input.fill(v); await page.waitForTimeout(300); await settle(); await page.waitForTimeout(300); await settle(); };
  await type("39.9");
  const fits = await state();
  check("39.9 builds, the largest radius that fits", fits.refusal === null && fits.shown === 39.9, fits);
  await type("45");
  const typed = await state();
  check("a typed 45 is refused the same way and the model keeps 39.9", typed.refusal !== null && typed.boxBad && typed.shown === 39.9 && typed.tris === fits.tris, typed);
  await page.evaluate(() => window.__fundacad.handleAction("top"));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/4-typed-refused-top.png` });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(700);
  await input.press("Enter");
  await settle();
  const stay = await state();
  check("Enter on a refused typed value keeps the tool open and adds nothing", stay.active && stay.feats.length === 0, stay.prompt);
  await input.fill("25");
  await page.waitForTimeout(100);
  check("typing a smaller value clears the refusal", (await state()).refusal === null);
  await input.press("Enter");
  await settle();
  await page.waitForTimeout(300);
  await settle();
  const c4 = await state();
  check("Enter on 25 commits 25", !c4.active && c4.feats.length === 1 && c4.feats[0].endsWith("=25"), c4.feats);

  // --- 5. re-editing, and the chamfer side ------------------------------------
  console.log("5. edit the fillet past the limit, then Tab to a chamfer that does not fit");
  const fid = c4.feats[0].split(":")[0];
  const edit = async () => {
    await page.evaluate((id) => window.__fundacad.editFeature(id), fid);
    await page.waitForTimeout(500);
    await settle();
    await page.waitForTimeout(500);
    await settle();
  };
  await edit();
  g = await armedGrab();
  at = along(g, 25);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await sweep(at, 25, 39, 1, 80);
  await settle();
  await sweep(at, 39, 48, 1, 80);
  await settle();
  const e5 = await state();
  check("editing refuses past the limit the same way", e5.refusal !== null && e5.shown !== null && e5.shown < 40, e5);
  await page.mouse.up();
  await page.keyboard.press("Enter");
  await settle();
  const c5 = await state();
  check("and confirming replaces the fillet with the last good radius", !c5.active && c5.feats.length === 1 && c5.feats[0] === `${fid}:fillet=${e5.shown}`, c5.feats);
  await edit();
  await page.keyboard.press("Tab");
  await settle();
  await type("45");
  const ch = await state();
  check("a chamfer too big for the pocket says Distance", /^Distance too large/.test(ch.refusal ?? ""), ch.refusal);
  await page.keyboard.press("Escape");
  await settle();
  const c6 = await state();
  check("Esc leaves the committed fillet untouched", !c6.active && c6.feats[0] === `${fid}:fillet=${e5.shown}`, c6.feats);

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
