// A confirmed section stays on as a view state through orbit, Fillet, Esc and undo, and the Section on chip edits,
// flips and removes it. The model is a tapered block off the origin with a pocket, cut along a slanted side face.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5952/ SC_ENGINE_PORT=8952 [SC_OUT=<dir>] \
//     node e2e/section_view_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || process.env.SC_OUT || path.join(os.tmpdir(), "section_view_shots"));
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

const POLY = [
  [30, -20],
  [118, -12],
  [104, 46],
  [41, 38],
];
const HEIGHT = 40;

function modelDoc() {
  const lines = POLY.map((p, i) => {
    const q = POLY[(i + 1) % POLY.length];
    return { type: "line", x1: p[0], y1: p[1], x2: q[0], y2: q[1] };
  });
  return {
    parameters: {},
    features: [
      { id: "s1", type: "sketch", plane: "XY", entities: lines },
      { id: "e1", type: "extrude", sketch: "s1", distance: HEIGHT, operation: "new", taper: 7 },
      {
        id: "s2",
        type: "sketch",
        plane: { origin: [0, 0, HEIGHT], normal: [0, 0, 1], xdir: [1, 0, 0] },
        entities: [{ type: "circle", radius: 11, x: 70, y: 9 }],
      },
      { id: "e2", type: "extrude", sketch: "s2", distance: -25, operation: "cut" },
    ],
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    const shaderErrors = [];
    page.on("console", (m) => {
      if (/Shader Error|WebGLProgram/.test(m.text())) shaderErrors.push(m.text().slice(0, 300));
    });
    await page.addInitScript((port) => {
      const N = window.WebSocket;
      class P extends N {
        constructor(u, p) {
          super(String(u).replace(":8765", `:${port}`), p);
        }
      }
      window.WebSocket = P;
    }, ENGINE_PORT);

    await page.goto(`${URL}?token=${TOKEN}`);
    await page.waitForTimeout(2500);
    const modal = await page.$(".modal-close");
    if (modal) {
      await modal.click();
      await page.waitForTimeout(400);
    }
    await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.section, null, { timeout: 60000 });

    const settle = async () => {
      await page.waitForTimeout(250);
      await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
      await page.waitForTimeout(300);
    };
    const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
    // A click on bare canvas, clear of every panel and of the model, takes focus from the offset box.
    const clickEmpty = async () => {
      const at = await page.evaluate(() => {
        for (let y = 820; y > 100; y -= 40)
          for (let x = 1000; x > 300; x -= 40) {
            const el = document.elementFromPoint(x, y);
            if (el?.tagName === "CANVAS" && window.viewport.bodyIdAt(x, y) === null) return { x, y };
          }
        return null;
      });
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(200);
    };
    const state = () =>
      page.evaluate(() => {
        const v = window.viewport;
        let handles = 0;
        v.scene.scene.traverse((o) => {
          if (o.userData.handle === "section") handles++;
        });
        const shownBoxes = [...document.querySelectorAll(".dim-input")].filter((b) => b.style.display !== "none");
        const p = v.sectionPlane;
        return {
          phase: window.section.phase,
          sectioned: v.sectioned,
          handles,
          box: shownBoxes.length,
          cross: shownBoxes.some((b) => b.querySelector(".dim-no")),
          plane: [p.normal.x, p.normal.y, p.normal.z, p.constant].map((c) => Math.round(c * 1e4) / 1e4),
          fillet: window.edgeFeature.active,
        };
      });

    await page.evaluate(async (doc) => {
      window.store.loadDocument(doc);
      await window.store.rebuildNow();
    }, modelDoc());
    await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, {
      timeout: 60000,
    });
    await page.evaluate(() => {
      window.__fundacad.handleAction("iso");
      window.__fundacad.handleAction("fit");
    });
    await settle();

    // A point on the front side face (the one from (30,-20) to (118,-12)), found with the app's own picker.
    const findFace = () =>
      page.evaluate(
        ([poly, h]) => {
          const v = window.viewport;
          const V = v.camera.position.constructor;
          const [a, b] = poly;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const inward = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
          for (const t of [0.55, 0.45, 0.65, 0.35])
            for (const z of [h * 0.3, h * 0.5])
              for (const d of [0.6, 1.2, 1.8]) {
                const p = new V(a[0] + (b[0] - a[0]) * t + inward[0] * d, a[1] + (b[1] - a[1]) * t + inward[1] * d, z);
                const s = v.projectToScreen(p);
                const hit = v.pickFaceForPressPull(s.x, s.y);
                if (hit && Math.abs(hit.normal.z) > 0.05 && hit.normal.y < -0.5)
                  return {
                    x: s.x,
                    y: s.y,
                    normal: [hit.normal.x, hit.normal.y, hit.normal.z],
                    point: [hit.anchor.x, hit.anchor.y, hit.anchor.z],
                  };
              }
          return null;
        },
        [POLY, HEIGHT],
      );
    const face = await findFace();
    check("found a point on the tapered front face", !!face, face);
    if (!face) throw new Error("no face point");
    const tile = page.locator('.tool-rail [data-action="section"], [data-action="section"]:visible').first();
    const typeOffset = async (text) => {
      await page.locator(".dim-input input").first().click();
      await page.keyboard.press("Control+A");
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
    };
    // The part 1 cut again, from the iso view: the bulk kept, 9.5 mm in from the front face.
    const makeCut = async () => {
      await page.evaluate(() => {
        window.__fundacad.handleAction("iso");
        window.__fundacad.handleAction("fit");
      });
      await page.waitForTimeout(600);
      const f = await findFace();
      await tile.click();
      await page.waitForTimeout(400);
      await page.locator(".ui-confirm-choice", { hasText: "Face or plane" }).click();
      await page.waitForTimeout(300);
      await page.mouse.click(f.x, f.y);
      await page.waitForTimeout(300);
      await clickEmpty();
      await page.keyboard.press("f");
      await typeOffset("-9.5");
      return f;
    };

    console.log("\n[part 1: confirm keeps the cut on]");
    await tile.click();
    await page.waitForTimeout(400);
    await page.locator(".ui-confirm-choice", { hasText: "Face or plane" }).click();
    await page.waitForTimeout(300);
    check("Section aims after Face or plane", (await state()).phase === "aiming");
    await page.mouse.click(face.x, face.y);
    await page.waitForTimeout(300);
    let s = await state();
    check(
      "a face pick starts editing with the handle and the box, no cross",
      s.phase === "editing" && s.sectioned && s.handles === 1 && s.box === 1 && !s.cross,
      s,
    );
    const dot = (p, n) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
    check("the cut first keeps the side the face points into", dot(s.plane, face.normal) > 0.999, s.plane);

    // The Offset box holds the focus from the start, and F and G still reach the tool until a value is typed.
    const boxText = () =>
      page.evaluate(() => ({
        focused: document.activeElement?.closest(".dim-input") != null,
        value: document.querySelector(".dim-input input")?.value,
      }));
    const before = await boxText();
    await page.keyboard.press("f");
    await page.waitForTimeout(200);
    s = await state();
    const after = await boxText();
    check(
      "F in the Offset box flips and keeps the bulk, and types nothing",
      before.focused &&
        after.focused &&
        after.value === before.value &&
        s.phase === "editing" &&
        dot(s.plane, face.normal) < -0.999,
      { before, after, plane: s.plane },
    );
    await clickEmpty();
    await page.keyboard.press("f");
    await page.keyboard.press("f");
    await page.waitForTimeout(200);
    s = await state();
    check("F on the canvas flips too", s.phase === "editing" && dot(s.plane, face.normal) < -0.999, s.plane);

    await typeOffset("-9.5");
    s = await state();
    check(
      "Enter keeps the cut on with no handle and no box",
      s.phase === "on" && s.sectioned && s.handles === 0 && s.box === 0,
      s,
    );
    const kept = s.plane;

    const eye0 = await page.evaluate(() => window.viewport.camera.position.toArray());
    await page.mouse.move(700, 450);
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 22; i++) {
      await page.mouse.move(700 + i * 10, 450 + i);
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(400);
    const eye1 = await page.evaluate(() => window.viewport.camera.position.toArray());
    s = await state();
    const moved = Math.hypot(eye1[0] - eye0[0], eye1[1] - eye0[1], eye1[2] - eye0[2]);
    check("an orbit turns the camera and the cut stays on", moved > 1 && s.phase === "on" && s.sectioned, {
      moved: Math.round(moved),
      phase: s.phase,
    });

    await clickEmpty();
    await page.keyboard.press("f");
    await page.waitForTimeout(400);
    s = await state();
    check(
      "F starts Fillet over the cut, and does not flip it",
      s.fillet && s.phase === "on" && s.sectioned && JSON.stringify(s.plane) === JSON.stringify(kept),
      s,
    );

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    s = await state();
    check("Esc ends Fillet and the cut stays on", !s.fillet && s.phase === "on" && s.sectioned, s);

    await page.evaluate(() => window.store.updateFeature("e1", { distance: 46 }));
    await settle();
    await clickEmpty();
    await page.keyboard.press("Control+z");
    await settle();
    const dist = await page.evaluate(() => window.store.document.features.find((f) => f.id === "e1").distance);
    s = await state();
    check(
      "undo of a model edit leaves the cut on and where it was",
      dist === HEIGHT && s.phase === "on" && s.sectioned && JSON.stringify(s.plane) === JSON.stringify(kept),
      { dist, s },
    );
    await shot("01_on");

    console.log("\n[part 2: the chip]");
    const chip = () =>
      page.evaluate(() => {
        const c = document.querySelector('[data-testid="section-chip"]');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        const edit = c.querySelector('[data-testid="section-edit"]');
        return {
          text: c.textContent,
          pressed: edit.getAttribute("aria-pressed"),
          box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        };
      });
    const around = (b, pad) => ({
      x: b.left - pad,
      y: b.top - pad,
      width: b.right - b.left + 2 * pad,
      height: b.bottom - b.top + 2 * pad,
    });
    let c = await chip();
    check(
      "the chip says Section on while the cut is on",
      !!c && c.text.includes("Section on") && c.pressed === "false",
      c,
    );
    await shot("02_chip_noir");
    await page.screenshot({ path: `${OUT}/02_chip_noir_close.png`, clip: around(c.box, 24) });

    await page.click('[data-testid="section-edit"]');
    await page.waitForTimeout(300);
    s = await state();
    const shownValue = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none")?.querySelector("input")
            ?.value,
      );
    let value = await shownValue();
    c = await chip();
    check(
      "Edit brings the handle and the box back on the same cut, pressed",
      s.phase === "editing" &&
        s.handles === 1 &&
        Number(value) === -9.5 &&
        c.pressed === "true" &&
        JSON.stringify(s.plane) === JSON.stringify(kept),
      { s, value, pressed: c.pressed },
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    s = await state();
    check("Esc keeps it on again", s.phase === "on" && s.handles === 0 && s.box === 0, s);

    await page.click('[data-testid="section-flip"]');
    await page.waitForTimeout(300);
    s = await state();
    check(
      "Flip reverses the drawn plane and stays on",
      s.phase === "on" && s.plane.slice(0, 4).every((v, i) => Math.abs(v + kept[i]) < 1e-3),
      { plane: s.plane, kept },
    );
    await page.click('[data-testid="section-flip"]');
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      document.documentElement.classList.add("no-glass-blur");
      window.viewport.requestRender();
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/02_chip_blur_off.png`, clip: around(c.box, 24) });
    await page.evaluate(() => {
      document.documentElement.classList.remove("no-glass-blur");
      window.viewport.requestRender();
    });
    await page.evaluate(async () => (await import("/src/ui/theme.ts")).setTheme("solarized-light"));
    await page.waitForTimeout(500);
    await shot("02_chip_solarized");
    await page.screenshot({ path: `${OUT}/02_chip_solarized_close.png`, clip: around(c.box, 24) });
    await page.evaluate(async () => (await import("/src/ui/theme.ts")).setTheme("fundacad"));

    await page.evaluate(() => {
      document.documentElement.dataset.pointer = "touch";
    });
    await page.waitForTimeout(200);
    const hits = await page.evaluate(() =>
      [...document.querySelectorAll(".section-chip .btn")].map((b) => {
        const r = b.getBoundingClientRect();
        const before = getComputedStyle(b, "::before");
        return Math.round(r.height - parseFloat(before.top) - parseFloat(before.bottom));
      }),
    );
    check("each chip button takes a finger of about 40px", hits.length === 3 && hits.every((h) => h >= 38), hits);
    await page.evaluate(() => {
      delete document.documentElement.dataset.pointer;
    });

    // 1000 to 1100 is where the rail's labels and the view controls leave the top row too narrow for the chip.
    for (const [width, height] of [
      [760, 900],
      [900, 800],
      [1000, 800],
      [1024, 768],
      [1100, 800],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(800);
      c = await chip();
      const cards = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "#float-layer .float-left-stack > *, #float-layer .tool-rail .rail-btn, #float-layer .tool-rail .rail-group, #float-layer .float-right > *",
          ),
        ]
          .map((o) => {
            const r = o.getBoundingClientRect();
            return { id: o.id || o.className, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          })
          .filter((r) => r.right > r.left && r.bottom > r.top),
      );
      const hitCards = cards.filter(
        (r) => r.left < c.box.right && r.right > c.box.left && r.top < c.box.bottom && r.bottom > c.box.top,
      );
      const covered = await page.evaluate(() =>
        [...document.querySelectorAll(".section-chip .btn")]
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return !b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
          })
          .map((b) => b.textContent),
      );
      check(
        `at a ${width}x${height} window the chip clears every card and each of its buttons takes a click`,
        hitCards.length === 0 && covered.length === 0,
        { chip: c.box, hitCards, covered },
      );
      await shot(`02_chip_${width}`);
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(500);

    await page.click('[data-testid="section-off"]');
    await page.waitForTimeout(300);
    s = await state();
    c = await chip();
    check("Off removes the cut and the chip", s.phase === "off" && !s.sectioned && c === null, { s, c });

    console.log("\n[part 3: saved with the document]");
    const f3 = await makeCut();
    const savedCut = () =>
      page.evaluate(() => {
        const v = window.store.sectionView;
        return v && JSON.parse(JSON.stringify(v));
      });
    const sv = await savedCut();
    const near = (a, b, tol) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < tol);
    const onPlane =
      sv &&
      Math.abs(
        dot(
          sv.origin.map((x, i) => x - f3.point[i]),
          f3.normal,
        ),
      );
    check(
      "the store holds the cut: the face's plane, 9.5 in, the bulk kept, soft ghost",
      !!sv &&
        near(sv.normal, f3.normal, 1e-4) &&
        onPlane < 1e-3 &&
        sv.offset === -9.5 &&
        sv.side === -1 &&
        sv.ghost === "soft" &&
        Object.keys(sv).sort().join() === "ghost,normal,offset,origin,side",
      { sv, onPlane },
    );
    const json = await page.evaluate(() => window.store.toJSON());
    await page.evaluate(() => window.store.newDocument());
    await settle();
    s = await state();
    check(
      "New turns it off",
      s.phase === "off" && !s.sectioned && (await chip()) === null && (await savedCut()) === null,
      s,
    );
    await page.evaluate((j) => window.store.load(j), json);
    await settle();
    s = await state();
    check(
      "opening the saved file puts the same cut back on, with its chip",
      s.phase === "on" &&
        s.sectioned &&
        (await chip()) !== null &&
        JSON.stringify(await savedCut()) === JSON.stringify(sv) &&
        near(s.plane, kept, 2e-3),
      { s, kept },
    );
    await page.evaluate(async () => {
      window.store.loadDocument({
        parameters: {},
        features: [{ id: "k1", type: "box", length: 30, width: 20, height: 10 }],
      });
      await window.store.rebuildNow();
    });
    await settle();
    s = await state();
    check(
      "opening a document saved without a cut turns it off",
      s.phase === "off" && !s.sectioned && (await chip()) === null,
      s,
    );

    console.log("\n[part 4: picks reach only what the cut keeps]");
    await page.evaluate(async (doc) => {
      window.store.loadDocument(doc);
      await window.store.rebuildNow();
    }, modelDoc());
    await settle();
    const f4 = await makeCut();
    await clickEmpty();
    await page.keyboard.press("f");
    await page.waitForTimeout(400);
    s = await state();
    check("Fillet runs with the cut on", s.fillet && s.phase === "on" && s.sectioned, s);
    const picks = await page.evaluate(
      ([face, h]) => {
        const v = window.viewport;
        const V = v.camera.position.constructor;
        const plane = v.sectionPlane;
        const vec = (p) => new V(p[0], p[1], p[2]);
        const depth = (p) => Math.round(plane.distanceToPoint(vec(p)) * 1e3) / 1e3;
        const at = (p) => v.projectToScreen(vec(p));
        const mid = (e) => {
          const a = e.points[0],
            b = e.points[e.points.length - 1];
          return e.points.length > 2 ? e.points[e.points.length >> 1] : a.map((x, i) => (x + b[i]) / 2);
        };
        const edges = v.visibleEdgeLines();
        // A removed edge the picker returns at its own midpoint once the cut is taken off the picker.
        let gone = null;
        v.picker.setClip(null);
        for (const e of edges.filter((e) => e.points.every((p) => depth(p) < -0.5))) {
          const s = at(mid(e));
          if (v.pickEdgeAt(s.x, s.y)?.edge.id === e.id) {
            gone = { id: e.id, s };
            break;
          }
        }
        v.picker.setClip(plane);
        const goneNow = gone && v.pickEdgeAt(gone.s.x, gone.s.y);
        let back = null;
        for (const e of edges)
          for (const p of e.points)
            if (
              Math.abs(p[2] - h) < 0.05 &&
              Math.abs(Math.hypot(p[0] - 70, p[1] - 9) - 11) < 0.05 &&
              (!back || depth(p) > back.d)
            )
              back = { id: e.id, p, d: depth(p) };
        const bs = back && at(back.p);
        const fh = v.pickFaceForPressPull(face.x, face.y);
        // A click, a hover and Measure go through pickEntity, the Picker's own ray, not bodyRay.
        const en = v.pickEntity(face.x, face.y);
        const entity =
          en &&
          (en.kind === "face"
            ? { kind: "face", d: depth(en.point), sameFace: en.faceId === fh?.faceId }
            : { kind: "edge", d: Math.max(...en.edge.points.map(depth)) });
        return {
          entity,
          gone: gone && {
            id: gone.id,
            now: goneNow ? { id: goneNow.edge.id, d: depth(goneNow.point.toArray()) } : null,
          },
          rim: back && { id: back.id, d: back.d, got: v.pickEdgeAt(bs.x, bs.y)?.edge.id ?? null },
          face: {
            before: depth(face.point),
            now: fh && depth(fh.anchor.toArray()),
            sameAsHover: v.faceIdAt(face.x, face.y) === (fh?.faceId ?? null),
            body: v.bodyIdAt(face.x, face.y),
          },
        };
      },
      [f4, HEIGHT],
    );
    check("without the cut the picker takes an edge of the removed half", !!picks.gone, picks);
    check(
      "with the cut on Fillet does not reach that edge, only kept ones",
      !!picks.gone && (picks.gone.now === null || (picks.gone.now.id !== picks.gone.id && picks.gone.now.d >= -0.01)),
      picks.gone,
    );
    check(
      "a pocket rim edge the cut keeps still picks",
      !!picks.rim && picks.rim.d > 1 && picks.rim.got === picks.rim.id,
      picks.rim,
    );
    // The removed front face sits over the bulk the cut keeps, so the pointer is on the cap: the body, and no face.
    check(
      "a Press/Pull or hover on the removed half over the cap takes no face, and the body is there",
      picks.face.before < -1 && picks.face.now === null && picks.face.sameAsHover && picks.face.body !== null,
      picks.face,
    );
    check("a click on the removed half over the cap picks no face behind it", picks.entity === null, picks.entity);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    s = await state();
    check("Esc ends Fillet and the cut stays on", !s.fillet && s.phase === "on" && s.sectioned, s);
    await shot("04_picks");

    console.log("\n[part 5: the glow stops at the cut]");
    const glow = await page.evaluate((h) => {
      const v = window.viewport;
      const s = v.projectToScreen(new v.camera.position.constructor(88, 22, h));
      v.selectBodyAt(s.x, s.y);
      const glows = [];
      v.scene.scene.traverse((o) => {
        if (o.name === "selection-glow") glows.push(o.material.clippingPlanes);
      });
      return {
        selected: v.highlighter.getSelectedBodies(),
        glows: glows.length,
        clipped: glows.every((p) => p?.length === 1 && p[0] === v.sectionPlane),
      };
    }, HEIGHT);
    await page.waitForTimeout(500);
    check(
      "a selected body's glow is clipped by the cut",
      glow.selected.length === 1 && glow.glows >= 1 && glow.clipped,
      glow,
    );
    check("the clipped glow shader compiles", shaderErrors.length === 0, shaderErrors);
    await shot("05_glow");

    console.log("\n[part 6: the cap from the top]");
    await page.evaluate(() => {
      window.section.stop();
      window.viewport.clearSelection();
      window.__fundacad.handleAction("top");
      window.__fundacad.handleAction("fit");
    });
    await page.waitForTimeout(800);
    const capProbe = () =>
      page.evaluate(() => {
        const v = window.viewport;
        const V = v.camera.position.constructor;
        const out = {};
        // On the cap well clear of the pocket, and on the pocket floor (z 15) seen through the cap's hole.
        for (const [name, p] of [
          ["cap", [80, 20, 20]],
          ["pocket", [70, 9, 20]],
        ]) {
          const s = v.projectToScreen(new V(...p));
          const hit = v.pickEntity(s.x, s.y);
          const pp = v.pickFaceForPressPull(s.x, s.y);
          out[name] = {
            at: s,
            canvas: document.elementFromPoint(s.x, s.y)?.tagName === "CANVAS",
            pick:
              hit &&
              (hit.kind === "face"
                ? { face: hit.faceId, z: Math.round(hit.point[2] * 100) / 100 }
                : { edge: hit.edge.id }),
            pressPull: pp && {
              face: pp.faceId,
              z: Math.round(pp.anchor.z * 100) / 100,
              nz: Math.round(pp.normal.z * 1e3) / 1e3,
            },
            hover: v.faceIdAt(s.x, s.y),
            body: v.bodyIdAt(s.x, s.y),
          };
        }
        return out;
      });
    const open6 = await capProbe();
    check(
      "without a cut the top is picked there",
      open6.cap.pick?.z === HEIGHT && open6.cap.pressPull?.z === HEIGHT && open6.cap.hover === open6.cap.pick?.face,
      open6.cap,
    );
    await page.evaluate(() => {
      window.section.start("Z");
      window.section.flip();
      window.section.confirm();
    });
    await page.waitForTimeout(800);
    const cut6 = await capProbe();
    s = await state();
    check(
      "a Z cut through the middle keeps the bottom",
      s.phase === "on" && s.plane[2] === -1 && s.plane[3] === HEIGHT / 2,
      s.plane,
    );
    check(
      "on the cap a click, hover, Measure and Press/Pull take no face, the body is there",
      cut6.cap.pick === null &&
        cut6.cap.pressPull === null &&
        cut6.cap.hover === null &&
        cut6.cap.body === open6.cap.body &&
        !!cut6.cap.body,
      cut6.cap,
    );
    check(
      "the pocket floor seen past the cap is still picked, facing up",
      cut6.pocket.pick?.z === 15 &&
        cut6.pocket.pressPull?.z === 15 &&
        cut6.pocket.pressPull?.nz === 1 &&
        cut6.pocket.hover === cut6.pocket.pick?.face,
      cut6.pocket,
    );
    await page.mouse.click(cut6.cap.at.x, cut6.cap.at.y);
    await page.waitForTimeout(400);
    const sel6 = await page.evaluate(() => ({
      bodies: window.viewport.getSelectedBodies(),
      faces: window.viewport.getSelectedFaceIds(),
    }));
    check(
      "a click on the cap selects its body",
      cut6.cap.canvas && sel6.bodies.length === 1 && sel6.bodies[0] === cut6.cap.body && sel6.faces.length === 0,
      sel6,
    );
    await shot("06_cap");
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}  (shots in ${OUT})`);
  process.exit(failures);
})();
