// The slim rings and the aim stalk in a real browser: a datum plane's pose
// rings, the Move gizmo's rings on a body, and the key light aimed in Render.
//
// Scene: a 60x40x10 box standing on XY and a datum plane P0 20 mm above XY.
//
// Datum shots (1400x900): 1_iso_idle, 2_iso_hover (on the tilt X ring),
// 3_iso_dragging (tilt X held at 30), 4_top, 5_front, and 0_closeup, a crop
// around the pivot. Move shots: move_1_idle, move_2_hover_ring. Light shots:
// light_1_idle, light_2_hover, light_3_dragging, light_4_aimed.
//
// Tasks, from iso and again from the top: tilt X to 30, on to exactly 45, spin
// 90. The hand presses where the ring is drawn, moves along the circle and lets
// go when the box reads the target (or gives up), so dragPx is what the ring
// asks of a hand. Aimable share: of each handle's drawn pixels, how many a
// press there actually takes that handle.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5951/ SC_ENGINE_PORT=8951 \
//     node e2e/ring_handles_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "ring_handles_shots");
const ONLY_SHOTS = process.env.SC_ONLY_SHOTS === "1";
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
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(2500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });

  const shot = async (name, clip) => page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
  const settle = async () => {
    await page.waitForTimeout(250);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(250);
  };
  const park = async () => { await page.mouse.move(1380, 600); await page.waitForTimeout(250); };
  const pose = () => page.evaluate(() => ({ ...window.__fundacad.datumPose.pose }));
  const active = () => page.evaluate(() => window.__fundacad.datumPose.active);

  await page.evaluate(async () => {
    window.store.addFeature({ id: "B0", type: "box", length: 60, width: 40, height: 10 });
    window.store.addFeature({ id: "M0", type: "move", dx: 0, dy: 0, dz: 5, rx: 0, ry: 0, rz: 0 });
    window.store.addFeature({ id: "P0", type: "datumPlane", plane: "XY", offset: 20, name: "P0" });
    await window.store.rebuildNow();
  });
  await settle();
  // The history panel covers the right of the view; the shots are about the handles.
  const hist = await page.evaluate(() => {
    const h = [...document.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent.trim() === "History");
    let el = h;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      const b = [...(el?.querySelectorAll("button") ?? [])].find((x) => /close/i.test(x.title + x.getAttribute("aria-label")));
      if (b) { b.click(); return true; }
    }
    return false;
  });
  if (!hist) { await page.mouse.click(1362, 74); }
  await page.waitForTimeout(300);

  const view = async (v) => {
    await page.evaluate((v) => window.__fundacad.handleAction(v), v);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const V = window.viewport.camera.position.constructor;
      window.viewport.rig.moveTo(new V(0, 0, 12), false);
      window.viewport.rig.setViewScale(80, false);
      window.viewport.requestRender();
    });
    await page.waitForTimeout(300);
  };

  /** A point on P0's quad that a double-click takes, clear of any body. */
  const grabDatum = () => page.evaluate(() => {
    const f = window.store.document.features.find((x) => x.id === "P0");
    const d = window.__fundacad.datumPlaneDef(f);
    const n = d.normal, u = d.xdir;
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const vp = window.viewport;
    for (const r of [36, 30, 22, 38]) {
      for (let a = 0; a < 360; a += 15) {
        const x = r * Math.cos(a * Math.PI / 180), y = r * Math.sin(a * Math.PI / 180);
        const p = [0, 1, 2].map((i) => d.origin[i] + u[i] * x + v[i] * y);
        const s = vp.projectToScreen({ x: p[0], y: p[1], z: p[2] });
        if (s.x < 300 || s.x > 1050 || s.y < 60 || s.y > 780) continue;
        if (vp.pickDatumAt(s.x, s.y) === "P0" && vp.faceIdAt(s.x, s.y) == null) return s;
      }
    }
    return null;
  });

  const open = async () => {
    if (await active()) return true;
    await page.evaluate(() => window.__fundacad.editFeature("P0"));
    await page.waitForTimeout(400);
    const p = await active() ? null : await grabDatum();
    if (p) { await page.mouse.dblclick(p.x, p.y); await page.waitForTimeout(400); }
    await park();
    return active();
  };
  const close = async () => {
    if (await active()) { await page.keyboard.press("Enter"); await settle(); }
  };
  const resetPose = async () => {
    await close();
    await page.evaluate(async () => {
      window.store.mutate((d) => {
        const f = d.features.find((x) => x.id === "P0");
        for (const k of ["tiltX", "tiltY", "spin", "shiftX", "shiftY"]) delete f[k];
        f.offset = 20;
      });
      await window.store.rebuildNow();
    });
    await settle();
  };

  /** The screen path that drives `g` towards `target`: the ring's grab point
   *  carried round its axis, finely sampled. */
  const pathFor = (g, field, target) => page.evaluate(({ g, field, target }) => {
    const T = window.__fundacad.datumPose;
    const vp = window.viewport;
    const s = T.scene();
    const pr = T.handles.probe(g, s);
    if (!pr) return null;
    const want = target - T.pose[field];
    const sign = want >= 0 ? 1 : -1;
    const axis = s.axes[g].clone().normalize();
    const rel = pr.grabAt.clone().sub(s.pivot);
    const out = [];
    const reach = Math.max(Math.abs(want) * 3, 30);
    for (let d = 0; d <= reach; d += 0.5) {
      out.push(vp.projectToScreen(rel.clone().applyAxisAngle(axis, sign * d * Math.PI / 180).add(s.pivot)));
    }
    return out;
  }, { g, field, target });

  /** Press on the handle, follow `pts` until the box reads `target`, and let go
   *  unless `hold`. */
  const dragTo = async (g, field, target, hold = false, mirror = false) => {
    let pts = await pathFor(g, field, target);
    if (!pts) { check(`${g} has a handle`, false); return { px: 0, got: null, pressed: null, drags: 0 }; }
    if (mirror) pts = pts.map((p) => ({ x: 2 * pts[0].x - p.x, y: 2 * pts[0].y - p.y }));
    const pressed = await page.evaluate((p) => window.__fundacad.datumPose.hit(p.x, p.y), pts[0]);
    const from = (await pose())[field];
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.waitForTimeout(60);
    await page.mouse.down();
    let px = 0, got = from, last = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - last.x, pts[i].y - last.y);
      if (d < 1 && i < pts.length - 1) continue;
      px += d;
      last = pts[i];
      await page.mouse.move(pts[i].x, pts[i].y);
      got = (await pose())[field];
      if (got === target) break;
      // A hand that sees the value run the wrong way stops and tries the other way.
      if (!hold && !mirror && px > 24 && Math.sign(got - from) === -Math.sign(target - from)) break;
    }
    if (hold) return { px: Math.round(px), got, pressed, drags: 1 };
    await page.mouse.up();
    await page.waitForTimeout(250);
    if (got !== target && !mirror) {
      const again = await dragTo(g, field, target, false, true);
      return { px: Math.round(px) + again.px, got: again.got, pressed, drags: 1 + again.drags };
    }
    return { px: Math.round(px), got, pressed, drags: 1 };
  };

  /** Of each handle's drawn pixels, the share whose press takes that handle. */
  const aimable = () => page.evaluate(() => {
    const T = window.__fundacad.datumPose;
    const vp = window.viewport;
    const out = {};
    for (const g of ["offset", "tiltX", "tiltY", "spin"]) {
      const pr = T.handles.probe(g, T.scene());
      if (!pr) continue;
      // Every screen pixel the handle's visible meshes and lines cover.
      const pixels = new Set();
      const put = (x, y) => pixels.add(`${Math.round(x)},${Math.round(y)}`);
      for (const root of pr.drawn) {
        root.updateMatrixWorld(true);
        root.traverseVisible((o) => {
          const mat = o.material;
          if (!mat || mat.visible === false || !o.geometry) return;
          const pos = o.geometry.getAttribute("position");
          if (!pos) return;
          const idx = o.geometry.index;
          const at = (i) => vp.projectToScreen(new window.__THREE_V3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld));
          if (o.isMesh) {
            const n = idx ? idx.count : pos.count;
            for (let i = 0; i + 2 < n; i += 3) {
              const A = at(idx ? idx.getX(i) : i), B = at(idx ? idx.getX(i + 1) : i + 1), C = at(idx ? idx.getX(i + 2) : i + 2);
              const x0 = Math.floor(Math.min(A.x, B.x, C.x)), x1 = Math.ceil(Math.max(A.x, B.x, C.x));
              const y0 = Math.floor(Math.min(A.y, B.y, C.y)), y1 = Math.ceil(Math.max(A.y, B.y, C.y));
              const e = (P, Q, x, y) => (Q.x - P.x) * (y - P.y) - (Q.y - P.y) * (x - P.x);
              const area = e(A, B, C.x, C.y);
              if (Math.abs(area) < 1e-6) { put(A.x, A.y); continue; }
              for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = e(B, C, px, py) / area, w1 = e(C, A, px, py) / area, w2 = e(A, B, px, py) / area;
                if (w0 >= 0 && w1 >= 0 && w2 >= 0) put(x, y);
              }
            }
          } else {
            const step = o.isLineSegments ? 2 : 1;
            for (let i = 0; i + 1 < pos.count; i += step) {
              const A = at(i), B = at(i + 1);
              const len = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.y - A.y)));
              for (let t = 0; t <= len; t++) put(A.x + (B.x - A.x) * t / len, A.y + (B.y - A.y) * t / len);
            }
          }
        });
      }
      let own = 0;
      const total = pixels.size;
      for (const key of pixels) {
        const [x, y] = key.split(",").map(Number);
        if (T.hit(x + 0.5, y + 0.5) === g) own++;
      }
      out[g] = { px: total, share: total ? Math.round((own / total) * 100) : 0 };
    }
    return out;
  });

  // --- shots -------------------------------------------------------------------
  await view("iso");
  check("the handles open on P0", await open());
  await page.evaluate(() => { window.__THREE_V3 = window.viewport.camera.position.constructor; });
  await park();
  await shot("1_iso_idle");
  const piv = await page.evaluate(() => window.viewport.projectToScreen(window.__fundacad.datumPose.scene().pivot));
  const clip = { x: Math.max(0, Math.min(1400 - 600, Math.round(piv.x - 300))), y: Math.max(0, Math.min(900 - 450, Math.round(piv.y - 225))), width: 600, height: 450 };
  await shot("0_closeup", clip);
  const tiltXGrab = "tiltX";
  const hoverAt = await page.evaluate((g) => {
    const pr = window.__fundacad.datumPose.handles.probe(g, window.__fundacad.datumPose.scene());
    return pr ? window.viewport.projectToScreen(pr.grabAt) : null;
  }, tiltXGrab);
  if (hoverAt) {
    await page.mouse.move(hoverAt.x - 3, hoverAt.y - 3);
    await page.mouse.move(hoverAt.x, hoverAt.y);
    await page.waitForTimeout(300);
    const h = await page.evaluate((p) => window.__fundacad.datumPose.hit(p.x, p.y), hoverAt);
    check("the hover lands on the tilt X handle", h === tiltXGrab, String(h));
  }
  await shot("2_iso_hover");
  const held = await dragTo(tiltXGrab, "tiltX", 30, true);
  await page.waitForTimeout(250);
  await shot("3_iso_dragging");
  await page.mouse.up();
  await page.waitForTimeout(250);
  check("the held drag read 30", held.got === 30, JSON.stringify(held));
  await resetPose();
  await view("top");
  await open();
  await shot("4_top");
  await resetPose();
  await view("front");
  await open();
  await shot("5_front");
  await resetPose();
  await view("iso");
  await open();
  const share = await aimable();
  console.log(`  aimable iso: ${JSON.stringify(share)}`);
  await view("top");
  const shareTop = await aimable();
  console.log(`  aimable top: ${JSON.stringify(shareTop)}`);
  await close();

  // --- tasks ---------------------------------------------------------------------
  const tasks = {};
  if (!ONLY_SHOTS) {
    for (const v of ["iso", "top"]) {
      await resetPose();
      await view(v);
      check(`the handles open from ${v}`, await open());
      const run = async (name, g, field, target) => {
        const r = await dragTo(g, field, target);
        await settle();
        const stored = (await pose())[field];
        const ok = stored === target;
        check(`${v}: ${name}`, ok, `pressed ${r.pressed}, read ${r.got}, ${r.px}px`);
        let typed = 0;
        if (!ok) {
          // The hand gives up and types it.
          const idx = await page.evaluate((label) => [...document.querySelectorAll(".dim-input .dim-field .dim-name")]
            .findIndex((n) => (n.textContent || n.title || "").trim() === label), field === "tiltX" ? "Tilt X" : field === "tiltY" ? "Tilt Y" : "Spin");
          const f = (await page.$$(".dim-input .dim-field input"))[idx];
          if (f) { await f.click({ clickCount: 3 }); await page.keyboard.type(String(target)); typed = String(target).length; }
        }
        tasks[`${v} ${name}`] = { drags: r.drags, dragPx: r.px, pressedRight: r.pressed === g, reached: ok, typed, clicks: ok ? 0 : 1 };
      };
      await run("tilt 30", tiltXGrab, "tiltX", 30);
      await run("tilt to 45", tiltXGrab, "tiltX", 45);
      await run("spin 90", "spin", "spin", 90);
      await close();
    }
  }
  const total = Object.values(tasks).reduce((a, t) => ({ drags: a.drags + t.drags, dragPx: a.dragPx + t.dragPx, reached: a.reached + (t.reached ? 1 : 0), clicks: a.clicks + t.clicks, typed: a.typed + t.typed }), { drags: 0, dragPx: 0, reached: 0, clicks: 0, typed: 0 });
  console.log(`\n[datum rings] tasks ${JSON.stringify(tasks, null, 1)}\n  total ${JSON.stringify(total)}`);

  // --- the Move gizmo on the box ---------------------------------------------------
  console.log("\n[move]");
  await resetPose();
  await view("iso");
  const body = await page.evaluate(() => window.viewport.model?.bodies?.[0]?.id ?? null);
  await page.evaluate((id) => window.__fundacad.move.start([id], () => {}), body);
  await page.waitForTimeout(400);
  check("the Move gizmo is up on the box", await page.evaluate(() => window.__fundacad.move.active), String(body));
  await park();
  const idleLook = await page.evaluate(() => window.__fundacad.move.rings.map((r) => r.ring.drawn().material.opacity));
  check("every ring is faint at rest", idleLook.every((o) => o < 1), JSON.stringify(idleLook));
  await shot("move_1_idle");
  /** A point on ring `i` a press takes, and a drag round it by `deg`. */
  const movePath = (i, deg) => page.evaluate(({ i, deg }) => {
    const M = window.__fundacad.move;
    const g = M.gizmo;
    g.updateMatrixWorld();
    const k = g.scale.x;
    const axis = M.frame[i].clone();
    const a = M.frame[(i + 1) % 3].clone(), b = M.frame[(i + 2) % 3].clone();
    let start = null;
    for (let d = 10; d < 360 && !start; d += 7) {
      const c = a.clone().multiplyScalar(Math.cos(d * Math.PI / 180)).add(b.clone().multiplyScalar(Math.sin(d * Math.PI / 180))).multiplyScalar(46 * k);
      const s = window.viewport.projectToScreen(c.clone().add(g.position));
      const h = M.hitHandle(s.x, s.y);
      if (h && h.kind === "ring" && h.index === i) start = c;
    }
    if (!start) return null;
    const out = [];
    for (let s = 0; s <= Math.ceil(Math.abs(deg) / 3); s++) {
      out.push(window.viewport.projectToScreen(start.clone().applyAxisAngle(axis, (deg * Math.PI / 180) * (s / Math.ceil(Math.abs(deg) / 3))).add(g.position)));
    }
    return out;
  }, { i, deg });
  const ringPts = await movePath(2, 90);
  check("a point on the Z ring takes a press", !!ringPts);
  if (ringPts) {
    await page.mouse.move(ringPts[0].x - 2, ringPts[0].y);
    await page.mouse.move(ringPts[0].x, ringPts[0].y);
    await page.waitForTimeout(300);
    const look = await page.evaluate(() => window.__fundacad.move.rings.map((r) => ({ thick: r.ring.drawn().geometry.parameters.tube > 2, opacity: r.ring.drawn().material.opacity })));
    check("only the hovered ring lights and thickens, the others step back",
      look[2].thick && look[2].opacity === 1 && !look[0].thick && !look[1].thick && look[0].opacity < 0.3 && look[1].opacity < 0.3, JSON.stringify(look));
    await shot("move_2_hover_ring");
    await page.mouse.down();
    for (const p of ringPts.slice(1)) { await page.mouse.move(p.x, p.y); await page.waitForTimeout(15); }
    await page.waitForTimeout(200);
    await shot("move_3_turning");
    const deg = await page.evaluate(() => window.__fundacad.move.ringDeg);
    await page.mouse.up();
    check("the ring still turns the body, 90 about Z", deg === 90, String(deg));
  }
  // A released drag commits and the gizmo comes back on the moved box; put the
  // box back so the light shots are of the same scene.
  await settle();
  await page.evaluate(() => window.__fundacad.move.cancel());
  await page.evaluate(async () => {
    window.store.mutate((d) => { d.features = d.features.filter((f) => ["B0", "M0", "P0"].includes(f.id)); });
    await window.store.rebuildNow();
  });
  await settle();
  await page.evaluate(() => window.__fundacad.move.cancel());
  check("the Move gizmo is down", await page.evaluate(() => !window.__fundacad.move.active));

  // --- aiming the key light in Render ------------------------------------------------
  console.log("\n[light]");
  await page.evaluate(() => window.__fundacad.handleAction("materials"));
  await page.waitForTimeout(600);
  await page.click('.rd-tab[data-tab="environment"]');
  await page.waitForTimeout(200);
  if (!(await page.evaluate(() => window.__fundacad.lightAim.angles && document.querySelector('[data-shadows="mode"]')?.getAttribute("aria-pressed") === "true"))) {
    await page.click('[data-shadows="mode"]');
  }
  await view("iso");
  await page.click('[data-key-light="aim"]');
  await page.waitForTimeout(400);
  check("Aim raises the sun on the model", await page.evaluate(() => window.__fundacad.lightAim.active));
  await park();
  await shot("light_1_idle");
  const sun = await page.evaluate(() => window.viewport.projectToScreen(window.__fundacad.lightAim.stalk.tip()));
  await page.mouse.move(sun.x - 3, sun.y);
  await page.mouse.move(sun.x, sun.y);
  await page.waitForTimeout(300);
  await shot("light_2_hover");
  const before = await page.evaluate(() => ({ ...window.__fundacad.lightAim.angles }));
  const sunPath = await page.evaluate(() => {
    const L = window.__fundacad.lightAim;
    const tip = L.stalk.tip();
    const foot = L.foot.clone();
    const V = tip.constructor;
    const out = [];
    for (let d = 0; d <= 70; d += 2) out.push(window.viewport.projectToScreen(tip.clone().sub(foot).applyAxisAngle(new V(0, 0, 1), d * Math.PI / 180).add(foot)));
    return out;
  });
  await page.mouse.down();
  for (const p of sunPath) { await page.mouse.move(p.x, p.y); await page.waitForTimeout(15); }
  await page.waitForTimeout(250);
  await shot("light_3_dragging");
  await page.mouse.up();
  const after = await page.evaluate(() => ({ ...window.__fundacad.lightAim.angles }));
  check("the drag swung the light round, snapped to 5 degrees",
    after.azimuth !== before.azimuth && after.azimuth % 5 === 0 && after.elevation % 5 === 0, JSON.stringify({ before, after }));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check("Enter puts the sun away and keeps the aim", await page.evaluate(() => !window.__fundacad.lightAim.active));
  await park();
  await shot("light_4_aimed");
  const kept = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem("fundacad.render") || "{}");
    return { azimuth: p.keyAzimuth, elevation: p.keyElevation };
  });
  check("the aim is stored in the render settings", kept.azimuth === after.azimuth && kept.elevation === after.elevation, JSON.stringify(kept));

  fs.writeFileSync(`${OUT}/measures.json`, JSON.stringify({ aimable: { iso: share, top: shareTop }, tasks, total, light: { before, after }, failures }, null, 1));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
