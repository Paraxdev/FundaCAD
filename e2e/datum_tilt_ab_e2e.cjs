// Tilting a datum plane on the canvas, the two handle designs on the same six
// tasks, in a real browser, counting what each costs the hand.
//
//   arcs: the plane's own offset arrow, tilt arcs and spin arc (create and edit)
//   move: an offset-only create, then the Move gizmo on the selected plane
//
// Tasks, on a parent datum P0 10 mm above XY:
//   1. a plane 10 mm above P0 (20 above XY) tilted 30 degrees about X
//   2. tilt it further to exactly 45 with the snapping
//   3. spin it 90
//   4. sketch a rectangle on it and extrude it
//   5. bind the tilt to a parameter, change the parameter, the body follows
//   6. move P0 up 15, the child plane and the body follow
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5947/ SC_ENGINE_PORT=8947 \
//     node e2e/datum_tilt_ab_e2e.cjs <arcs|move> [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const VARIANT = process.argv[2] === "move" ? "move" : "arcs";
const OUT = path.resolve(process.argv[3] || `datum_tilt_${VARIANT}_shots`);
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

// What each task cost: clicks, drags, drag path in px, keys, typed characters.
const cost = {};
let task = "setup";
const tally = (k, n = 1) => { cost[task] ??= { clicks: 0, drags: 0, dragPx: 0, keys: 0, typed: 0, notes: [] }; cost[task][k] += n; };
const note = (s) => { tally("clicks", 0); cost[task].notes.push(s); console.log(`    note: ${s}`); };

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
  await page.goto(`${URL}?token=${TOKEN}&planeGizmo=${VARIANT}`);
  await page.waitForTimeout(2500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });

  const shot = async (name) => page.screenshot({ path: `${OUT}/${VARIANT}-${name}.png` });
  const settle = async () => {
    await page.waitForTimeout(250);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(250);
  };

  // --- the hand ----------------------------------------------------------------
  const click = async (p) => { if (!p) { check("found a point to click", false); return; } tally("clicks"); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(150); };
  const dblclick = async (p) => { if (!p) { check("found a point to double-click", false); return; } tally("clicks", 2); await page.mouse.dblclick(p.x, p.y); await page.waitForTimeout(300); };
  const key = async (k) => { tally("keys"); await page.keyboard.press(k); await page.waitForTimeout(200); };
  const typeText = async (t) => { tally("typed", t.length); await page.keyboard.type(t); await page.waitForTimeout(200); };
  /** press at `path[0]`, move through the rest, release */
  const drag = async (pts) => {
    tally("drags");
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      await page.mouse.move(pts[i].x, pts[i].y, { steps: 3 });
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
    tally("dragPx", Math.round(len));
    await page.waitForTimeout(250);
  };
  const toScreen = (w) => page.evaluate((w) => window.viewport.projectToScreen({ x: w[0], y: w[1], z: w[2] }), w);

  const feature = (id) => page.evaluate((id) => window.store.document.features.find((f) => f.id === id), id);
  const placed = (id) => page.evaluate((id) => {
    const f = window.store.document.features.find((x) => x.id === id);
    return window.__fundacad.datumPlaneDef(f);
  }, id);
  const engineDatum = (id) => page.evaluate((id) => window.store.buildState.result?.datumPlanes?.[id] ?? null, id);
  const near = (a, b, tol = 1e-3) => a.every((x, i) => Math.abs(x - b[i]) < tol);
  const deg = Math.PI / 180;
  const newestDatum = () => page.evaluate(() => [...window.store.document.features].reverse().find((f) => f.type === "datumPlane")?.id ?? null);

  // --- handle geometry, read off the live gizmo ----------------------------------

  /** Screen path that turns an arc (arcs) about its axis through the pivot by
   *  `degTurn`, starting on the arc's middle. */
  const arcPath = (which, degTurn) => page.evaluate(({ which, degTurn }) => {
    const T = window.__fundacad.datumPose;
    const arc = T.arcs.get(which);
    if (!arc) return null;
    const g = arc.group;
    g.updateMatrixWorld();
    const pivot = g.position.clone();
    const mid = g.localToWorld(g.position.clone().set(0, which === "spin" ? 92 : 64, 0));
    const axis = g.localToWorld(g.position.clone().set(0, 0, 1)).sub(pivot).normalize();
    const out = [];
    const n = Math.max(2, Math.ceil(Math.abs(degTurn) / 5));
    for (let i = 0; i <= n; i++) {
      const a = (degTurn * Math.PI / 180) * (i / n);
      const p = mid.clone().sub(pivot).applyAxisAngle(axis, a).add(pivot);
      out.push(window.viewport.projectToScreen(p));
    }
    return out;
  }, { which, degTurn });

  /** Screen path for the offset arrow (arcs), `mm` along the reference normal. */
  const arrowPath = (mm) => page.evaluate((mm) => {
    const T = window.__fundacad.datumPose;
    const g = T.arrow.group;
    g.updateMatrixWorld();
    const grab = g.localToWorld(g.position.clone().set(0, 30, 0));
    const n = T.src.n.clone();
    const to = grab.clone().addScaledVector(n, mm);
    return [0, 0.5, 1].map((t) => window.viewport.projectToScreen(grab.clone().lerp(to, t)));
  }, mm);

  /** The Move gizmo's ring about frame axis `i`, turned by `degTurn` from a point
   *  between the other two arrows. */
  const ringPath = (i, degTurn) => page.evaluate(({ i, degTurn }) => {
    const M = window.__fundacad.move;
    const g = M.gizmo;
    g.updateMatrixWorld();
    const k = g.scale.x;
    const pivot = g.position.clone();
    const axis = M.frame[i].clone();
    const a = M.frame[(i + 1) % 3].clone(), b = M.frame[(i + 2) % 3].clone();
    // Where a hand would press: the first point round the ring that lights ring i,
    // clear of the arrows, squares and other rings that sit over it in places.
    let start = null;
    for (let d = 10; d < 360 && !start; d += 7) {
      const c = a.clone().multiplyScalar(Math.cos(d * Math.PI / 180)).add(b.clone().multiplyScalar(Math.sin(d * Math.PI / 180))).multiplyScalar(46 * k);
      const s = window.viewport.projectToScreen(c.clone().add(pivot));
      const h = M.hitHandle(s.x, s.y);
      if (h && h.kind === "ring" && h.index === i) start = c;
    }
    if (!start) start = a.clone().multiplyScalar(46 * k);
    const out = [];
    const n = Math.max(2, Math.ceil(Math.abs(degTurn) / 5));
    for (let s = 0; s <= n; s++) {
      const p = start.clone().applyAxisAngle(axis, (degTurn * Math.PI / 180) * (s / n)).add(pivot);
      out.push(window.viewport.projectToScreen(p));
    }
    return out;
  }, { i, degTurn });

  /** The Move gizmo's arrow along frame axis `i`, dragged `mm`. */
  const moveArrowPath = (i, mm) => page.evaluate(({ i, mm }) => {
    const M = window.__fundacad.move;
    const g = M.gizmo;
    g.updateMatrixWorld();
    const k = g.scale.x;
    const dir = M.frame[i].clone();
    const grab = g.position.clone().addScaledVector(dir, 40 * k);
    const to = grab.clone().addScaledVector(dir, mm);
    return [0, 0.5, 1].map((t) => window.viewport.projectToScreen(grab.clone().lerp(to, t)));
  }, { i, mm });

  const arcDrag = async (which, degTurn) => {
    const pts = await arcPath(which, degTurn);
    const h = pts && await page.evaluate((p) => window.__fundacad.datumPose.hit(p.x, p.y), pts[0]);
    check(`the press lands on the ${which} arc`, h === which, String(h));
    if (pts) await drag(pts);
  };
  const ringDrag = async (i, degTurn) => {
    const pts = await ringPath(i, degTurn);
    const h = await page.evaluate((p) => window.__fundacad.move.hitHandle(p.x, p.y), pts[0]);
    check(`the press lands on ring ${i}`, h?.kind === "ring" && h.index === i, JSON.stringify(h));
    await drag(pts);
  };

  /** How much of each rotation handle's drawn path, in screen px, a press lights
   *  that handle rather than a neighbour: the aimable share of the target. */
  const aimable = () => page.evaluate((variant) => {
    const vp = window.viewport;
    const out = {};
    const walk = (pts, want, hit) => {
      let len = 0, good = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        len += d;
        if (hit(pts[i]) === want) good += d;
      }
      return { px: Math.round(len), aimablePx: Math.round(good), share: len ? Math.round((good / len) * 100) : 0 };
    };
    if (variant === "arcs") {
      const T = window.__fundacad.datumPose;
      for (const [t, arc] of T.arcs) {
        const g = arc.group;
        g.updateMatrixWorld();
        const r = t === "spin" ? 92 : 64;
        const pts = [];
        for (let i = 0; i <= 40; i++) {
          const a = Math.PI / 2 - 0.7 + 1.4 * (i / 40);
          pts.push(vp.projectToScreen(g.localToWorld(g.position.clone().set(Math.cos(a) * r, Math.sin(a) * r, 0))));
        }
        out[t] = walk(pts, t, (p) => T.hit(p.x, p.y));
      }
    } else {
      const M = window.__fundacad.move;
      const g = M.gizmo;
      g.updateMatrixWorld();
      const k = g.scale.x;
      for (const i of [0, 1, 2]) {
        const a = M.frame[(i + 1) % 3], b = M.frame[(i + 2) % 3];
        const pts = [];
        for (let s = 0; s <= 120; s++) {
          const t = (s / 120) * Math.PI * 2;
          pts.push(vp.projectToScreen(a.clone().multiplyScalar(Math.cos(t) * 46 * k).add(b.clone().multiplyScalar(Math.sin(t) * 46 * k)).add(g.position)));
        }
        out[`ring${i}`] = walk(pts, `ring${i}`, (p) => { const h = M.hitHandle(p.x, p.y); return h ? `${h.kind}${h.index}` : null; });
      }
    }
    return out;
  }, VARIANT);

  /** Screen point on datum `id`'s quad at plane coords (x, y). */
  const onDatum = async (id, x, y) => {
    const d = await placed(id);
    return page.evaluate(({ d, x, y }) => {
      const n = d.normal, u = d.xdir;
      const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      const p = [0, 1, 2].map((i) => d.origin[i] + u[i] * x + v[i] * y);
      return window.viewport.projectToScreen({ x: p[0], y: p[1], z: p[2] });
    }, { d, x, y });
  };

  /** A point on datum `id` that a click actually lands on: nothing nearer, no
   *  body under it. `picking` asks the construction-plane pick instead. */
  const grabDatum = async (id, picking = false) => {
    const d = await placed(id);
    return page.evaluate(({ d, id, picking }) => {
      const n = d.normal, u = d.xdir;
      const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      const vp = window.viewport;
      for (const r of [30, 22, 34, 15]) {
        for (let a = 0; a < 360; a += 30) {
          const x = r * Math.cos(a * Math.PI / 180), y = r * Math.sin(a * Math.PI / 180);
          const p = [0, 1, 2].map((i) => d.origin[i] + u[i] * x + v[i] * y);
          const s = vp.projectToScreen({ x: p[0], y: p[1], z: p[2] });
          if (s.x < 300 || s.x > 1050 || s.y < 60 || s.y > 780) continue;
          const ok = picking
            ? vp.pickConstructionAt(s.x, s.y)?.id === id
            : vp.pickDatumAt(s.x, s.y) === id && vp.faceIdAt(s.x, s.y) == null;
          if (ok) return s;
        }
      }
      return null;
    }, { d, id, picking });
  };

  const typeField = async (label, value) => {
    const idx = await page.evaluate((label) => [...document.querySelectorAll(".dim-input .dim-field .dim-name")]
      .findIndex((n) => (n.textContent || n.title || "").trim() === label), label);
    if (idx < 0) return false;
    const f = (await page.$$(".dim-input .dim-field input"))[idx];
    tally("clicks");
    await f.click({ clickCount: 3 });
    await typeText(String(value));
    return true;
  };

  // --- setup -------------------------------------------------------------------
  await page.evaluate(async () => {
    window.store.addFeature({ id: "P0", type: "datumPlane", plane: "XY", offset: 10, name: "P0" });
    await window.store.rebuildNow();
    window.__fundacad.handleAction("iso");
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    void 0;
  });
  await page.waitForTimeout(400);
  await shot("0-setup");

  // --- 1. create ----------------------------------------------------------------
  task = "1 create 20 above XY, tilt 30";
  console.log(`\n[${VARIANT}] ${task}`);
  tally("clicks"); // the Datum Plane button
  await page.evaluate(() => window.__fundacad.handleAction("datum-plane"));
  await page.waitForTimeout(300);
  await click(await grabDatum("P0", true));
  await page.waitForTimeout(400);
  let P1 = null;
  if (VARIANT === "arcs") {
    const active = await page.evaluate(() => window.__fundacad.datumPose.active);
    check("the pose handles open on the picked datum", active);
    await drag(await arrowPath(10));
    let off = await page.evaluate(() => window.__fundacad.datumPose.pose.offset);
    if (Math.abs(off - 10) > 1e-6) { note(`arrow drag landed on ${off}, typed 10`); await typeField("Offset", 10); }
    await shot("1a-offset");
    console.log(`    aimable: ${JSON.stringify(await aimable())}`);
    await arcDrag("tiltX", 30);
    const tilt = await page.evaluate(() => window.__fundacad.datumPose.pose.tiltX);
    check("the tilt arc snapped to 30", Math.abs(tilt - 30) < 1e-9, `tiltX ${tilt}`);
    await shot("1b-tilted");
    await key("Enter");
    await settle();
    P1 = await newestDatum();
  } else {
    const active = await page.evaluate(() => window.__fundacad.store && window.__fundacad.busyWhy().planeOffset);
    check("the offset arrow opens on the picked datum", active);
    await typeText("10"); // the Offset box has focus
    await key("Enter");
    await settle();
    P1 = await newestDatum();
    await shot("1a-offset");
    await click(await grabDatum(P1)); // select it, which raises the Move gizmo
    await page.waitForTimeout(400);
    const up = await page.evaluate(() => window.__fundacad.move.active);
    check("picking the plane raises the Move gizmo on it", up);
    if (up) console.log(`    aimable: ${JSON.stringify(await aimable())}`);
    if (up) await ringDrag(0, 30);
    await settle();
    await page.waitForTimeout(300);
    await shot("1b-tilted");
  }
  let f1 = await feature(P1);
  check("the new plane hangs off P0", f1?.planeId === "P0", JSON.stringify(f1));
  check("offset 10 and tiltX 30 are stored relative to P0", Math.abs((f1?.offset ?? 0) - 10) < 1e-6 && Math.abs((f1?.tiltX ?? 0) - 30) < 1e-6,
    JSON.stringify({ offset: f1?.offset, tiltX: f1?.tiltX, tiltY: f1?.tiltY, spin: f1?.spin, shiftX: f1?.shiftX, shiftY: f1?.shiftY }));
  let e1 = await engineDatum(P1);
  check("the engine places it 20 above XY with the normal tipped 30", !!e1 && near(e1.origin, [0, 0, 20]) && near(e1.normal, [0, -Math.sin(30 * deg), Math.cos(30 * deg)]), JSON.stringify(e1));

  // --- 2. tilt to 45 ------------------------------------------------------------
  task = "2 tilt to exactly 45";
  console.log(`\n[${VARIANT}] ${task}`);
  if (VARIANT === "arcs") {
    await dblclick(await grabDatum(P1));
    const active = await page.evaluate(() => window.__fundacad.datumPose.active);
    check("double-clicking the plane opens its handles", active);
    await arcDrag("tiltX", 15);
    await settle();
  } else {
    const up = await page.evaluate(() => window.__fundacad.move.active);
    if (!up) { await click(await grabDatum(P1)); }
    await ringDrag(0, 15);
    await settle();
  }
  await shot("2-tilt45");
  f1 = await feature(P1);
  check("tiltX is exactly 45", f1?.tiltX === 45, `tiltX ${f1?.tiltX}`);

  // --- 3. spin 90 ---------------------------------------------------------------
  task = "3 spin 90";
  console.log(`\n[${VARIANT}] ${task}`);
  if (VARIANT === "arcs") {
    await arcDrag("spin", 90);
    await settle();
    await key("Enter");
  } else {
    await ringDrag(2, 90);
    await settle();
    await key("Escape");
  }
  await settle();
  await shot("3-spin90");
  f1 = await feature(P1);
  check("spin is 90 and the tilt kept its 45", f1?.spin === 90 && f1?.tiltX === 45 && !f1?.tiltY,
    JSON.stringify({ tiltX: f1?.tiltX, tiltY: f1?.tiltY, spin: f1?.spin, shiftX: f1?.shiftX, shiftY: f1?.shiftY, offset: f1?.offset }));

  // --- 4. sketch and extrude ----------------------------------------------------
  task = "4 sketch and extrude";
  console.log(`\n[${VARIANT}] ${task}`);
  const busy = await page.evaluate(() => window.__fundacad.toolBusy());
  if (busy) { note("a tool was still up, Escape"); await key("Escape"); }
  tally("clicks");
  await page.evaluate(() => window.__fundacad.handleAction("sketch"));
  await page.waitForTimeout(300);
  await click(await grabDatum(P1, true));
  await page.waitForTimeout(500);
  const sk = await page.evaluate(() => ({ active: window.__fundacad.sketch.active, planeId: window.__fundacad.sketch.planeId ?? window.__fundacad.sketch.datumId ?? null }));
  check("the sketch opens on the tilted plane", sk.active, JSON.stringify(sk));
  await page.evaluate(() => window.__fundacad.sketch.setTool("rectangle"));
  await click(await onDatum(P1, -10, -6));
  await click(await onDatum(P1, 10, 6));
  tally("clicks");
  await page.evaluate(() => window.__fundacad.handleAction("finish"));
  await settle();
  const skId = await page.evaluate(() => [...window.store.document.features].reverse().find((f) => f.type === "sketch")?.id);
  const skF = await feature(skId);
  check("the sketch is bound to the tilted plane by id", skF?.planeId === P1, JSON.stringify({ planeId: skF?.planeId }));
  const centre = await placed(P1);
  await page.evaluate(({ c }) => { window.overlay.selectRegionsByPoints([c]); }, { c: centre.origin });
  tally("clicks");
  await page.evaluate(() => window.__fundacad.handleAction("extrude"));
  await page.waitForTimeout(500);
  await typeText("8");
  await key("Enter");
  await settle();
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(600);
  await shot("4-extruded");
  const bodyCheck = (id, h) => page.evaluate(({ id, h }) => {
    const r = window.store.buildState.result;
    const d = r?.datumPlanes?.[id];
    const pos = r?.mesh?.positions;
    if (!d || !pos || !pos.length) return { ok: false, why: "no body or plane" };
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const t = (pos[i] - d.origin[0]) * d.normal[0] + (pos[i + 1] - d.origin[1]) * d.normal[1] + (pos[i + 2] - d.origin[2]) * d.normal[2];
      lo = Math.min(lo, t); hi = Math.max(hi, t);
    }
    return { ok: Math.abs(lo) < 1e-3 && Math.abs(hi - h) < 1e-3, lo, hi, normal: d.normal, origin: d.origin };
  }, { id, h });
  let b = await bodyCheck(P1, 8);
  check("the body stands on the tilted plane, 8 deep along its normal", b.ok, JSON.stringify(b));

  // --- 5. parameter drives the tilt ------------------------------------------------
  task = "5 parameter bound tilt";
  console.log(`\n[${VARIANT}] ${task}`);
  tally("clicks");
  await page.evaluate((id) => window.__fundacad.selectFeature(id), P1);
  await page.waitForTimeout(300);
  const bound = await page.evaluate((id) => window.store.setTargetExpr({ kind: "feature", feature: id, field: "tiltX" }, "lean=45", "angle"), P1);
  tally("typed", "lean=45".length);
  await settle();
  check("tiltX binds to a parameter", bound === null && !!(await page.evaluate((id) => window.store.boundExpr({ kind: "feature", feature: id, field: "tiltX" }), P1)), String(bound));
  await page.evaluate(() => window.store.setParamExpr("lean", "60"));
  tally("typed", 2);
  await settle();
  await page.waitForTimeout(500);
  await settle();
  f1 = await feature(P1);
  check("the parameter wrote the tilt", f1?.tiltX === 60, `tiltX ${f1?.tiltX}`);
  const e5 = await engineDatum(P1);
  const nx = [0, -Math.sin(60 * deg), Math.cos(60 * deg)];
  check("the engine re-placed the plane at 60", !!e5 && near(e5.normal, nx), JSON.stringify(e5));
  b = await bodyCheck(P1, 8);
  check("the sketch and extrusion followed onto the 60 degree plane", b.ok, JSON.stringify(b));
  await shot("5-param60");

  // --- 6. move the parent ------------------------------------------------------------
  task = "6 move parent up 15";
  console.log(`\n[${VARIANT}] ${task}`);
  if (VARIANT === "arcs") {
    await dblclick(await grabDatum("P0"));
    const on = await page.evaluate(() => window.__fundacad.datumPose.active);
    check("double-clicking P0 opens its handles", on);
    await drag(await arrowPath(15));
    await settle();
    let off = (await feature("P0"))?.offset;
    if (Math.abs(off - 25) > 1e-6) {
      note(`arrow drag landed on ${off}, typed 25`);
      await typeField("Offset", 25);
      await key("Enter");
    } else {
      await key("Enter");
    }
  } else {
    await click(await grabDatum("P0"));
    await page.waitForTimeout(400);
    const up = await page.evaluate(() => window.__fundacad.move.active);
    check("picking P0 raises the Move gizmo on it", up);
    await drag(await moveArrowPath(2, 15));
    await settle();
    let off = (await feature("P0"))?.offset;
    if (Math.abs(off - 25) > 1e-6) {
      note(`arrow drag landed on ${off}, typed 15 into Move`);
      await page.evaluate(() => { const i = document.querySelector(".dim-input .dim-field input"); i?.focus(); i?.select(); });
      tally("clicks");
      await typeText(String(15 - (off - 10)));
      await key("Enter");
    }
    await settle();
    if (await page.evaluate(() => window.__fundacad.move.active)) await key("Escape");
  }
  await settle();
  const p0 = await feature("P0");
  check("P0 now sits 25 above XY", Math.abs((p0?.offset ?? 0) - 25) < 1e-6 && !p0?.tiltX && !p0?.shiftX && !p0?.shiftY, JSON.stringify(p0));
  const e6 = await engineDatum(P1);
  check("the child followed its parent, 35 above XY", !!e6 && near(e6.origin, [0, 0, 35]), JSON.stringify(e6?.origin));
  b = await bodyCheck(P1, 8);
  check("and the body followed the child", b.ok, JSON.stringify(b));
  await shot("6-parent-moved");

  // --- 7. probe: the same tilt handle seen edge-on --------------------------------
  // From the top, a turn about the plane's x is a ring seen side-on. The tilt is
  // bound to `lean` (a plain value since task 5), so the drag must keep it bound.
  task = "7 probe: tilt -15 from the top";
  console.log(`\n[${VARIANT}] ${task}`);
  await page.evaluate(() => window.__fundacad.handleAction("top"));
  await page.waitForTimeout(700);
  // Seen side-on the handle is a line, so the hand drags along it and watches
  // the readout, stopping when it says -15 (or giving up after 300 px).
  const dragUntil = async (pts, read, want) => {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    tally("drags");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    let moved = 0, got = null;
    for (; moved <= 300; moved += 2) {
      await page.mouse.move(a.x + dx * moved, a.y + dy * moved);
      got = await read();
      if (got === want) break;
    }
    await page.mouse.up();
    tally("dragPx", moved);
    await page.waitForTimeout(250);
    return { moved, got };
  };
  if (VARIANT === "arcs") {
    await dblclick(await grabDatum(P1));
    check("double-clicking the plane opens its handles", await page.evaluate(() => window.__fundacad.datumPose.active));
    const pts = await arcPath("tiltX", -15);
    const h = await page.evaluate((p) => window.__fundacad.datumPose.hit(p.x, p.y), pts[0]);
    check("the press lands on the tiltX arc", h === "tiltX", String(h));
    const r = await dragUntil(pts, () => page.evaluate(() => window.__fundacad.datumPose.pose.tiltX), 45);
    note(`dragged ${r.moved}px along the side-on arc, read ${r.got}`);
    await settle();
    await shot("7-top-edge-on");
    await key("Enter");
  } else {
    await click(await grabDatum(P1));
    await page.waitForTimeout(400);
    check("picking the plane raises the Move gizmo", await page.evaluate(() => window.__fundacad.move.active));
    const pts = await ringPath(0, -15);
    const h = await page.evaluate((p) => window.__fundacad.move.hitHandle(p.x, p.y), pts[0]);
    check("the press lands on ring 0", h?.kind === "ring" && h.index === 0, JSON.stringify(h));
    const r = await dragUntil(pts, () => page.evaluate(() => window.__fundacad.move.ringDeg), -15);
    note(`dragged ${r.moved}px along the side-on ring, read ${r.got}`);
    await settle();
    await shot("7-top-edge-on");
    if (await page.evaluate(() => window.__fundacad.move.active)) await key("Escape");
  }
  await settle();
  await page.waitForTimeout(400);
  await settle();
  f1 = await feature(P1);
  const lean = await page.evaluate((id) => window.store.boundExpr({ kind: "feature", feature: id, field: "tiltX" }), P1);
  check("the edge-on drag took the tilt to 45", f1?.tiltX === 45, JSON.stringify({ tiltX: f1?.tiltX, tiltY: f1?.tiltY, spin: f1?.spin, shiftX: f1?.shiftX, shiftY: f1?.shiftY, offset: f1?.offset }));
  check("and the parameter kept driving it, now 45", lean?.name === "lean" && lean?.value === 45, JSON.stringify(lean));

  console.log(`\n[${VARIANT}] cost per task`);
  const total = { clicks: 0, drags: 0, dragPx: 0, keys: 0, typed: 0 };
  for (const [t, c] of Object.entries(cost)) {
    if (t === "setup") continue;
    console.log(`  ${t.padEnd(32)} clicks ${c.clicks}  drags ${c.drags}  dragPx ${c.dragPx}  keys ${c.keys}  typed ${c.typed}${c.notes.length ? `  (${c.notes.join("; ")})` : ""}`);
    for (const k of Object.keys(total)) total[k] += c[k];
  }
  console.log(`  ${"TOTAL".padEnd(32)} clicks ${total.clicks}  drags ${total.drags}  dragPx ${total.dragPx}  keys ${total.keys}  typed ${total.typed}`);
  fs.writeFileSync(`${OUT}/${VARIANT}-cost.json`, JSON.stringify({ cost, total, failures }, null, 1));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
