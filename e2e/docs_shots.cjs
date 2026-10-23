// The pictures in the user manual (manual/docs/img), taken of the real app in a
// real browser so a UI change can be followed by a retake instead of a rewrite.
//
//   node e2e/docs_shots.cjs                 every still and every animation
//   node e2e/docs_shots.cjs --only a,b      just those names
//   node e2e/docs_shots.cjs --stills        stills only (or --gifs for the animations)
//   node e2e/docs_shots.cjs --list          the names
//
// Needs the engine on a WebSocket (`fundacad-engine --ws`) and vite:
//   FUNDACAD_EXTRA_ORIGINS=http://localhost:15173 FUNDACAD_ENGINE_PORT=18765 FUNDACAD_ENGINE_TOKEN=docshots FUNDACAD_PLUGIN_DIR=plugins fundacad-engine --ws
//   npx vite --port 15173 --strictPort
//   SC_URL=http://localhost:15173/ SC_ENGINE_PORT=18765 SC_TOKEN=docshots node e2e/docs_shots.cjs
// SC_URL, SC_ENGINE_PORT (default 8765), SC_TOKEN and SC_CHROME (any Chromium
// build) pick the setup. The viewport is always 1440x900, in the app's shipped
// dark theme, and the animations are assembled with Python Pillow (no ffmpeg).
//
// A shot is a function of the page. It builds its own state, calls `ctx.still`
// (a cropped PNG) or records frames with `ctx.frame`, and a fresh browser page
// is opened for each, so one shot cannot leave a dialog open in the next.
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const TOKEN = process.env.SC_TOKEN || "";
const APP = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const EXE = process.env.SC_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.SC_OUT || path.resolve(__dirname, "..", "manual", "docs", "img");
// SC_FULL=1 ignores every crop, to find out where something sits on the screen.
const FULL = !!process.env.SC_FULL;
const W = 1440;
const H = 900;

// ------------------------------------------------------------------ helpers --

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Click the middle of an origin plane tile, which a plane pick shows beside the origin.
async function clickTile(page, plane) {
  const p = await page.evaluate((k) => {
    const m = window.viewport.scene.planes[k];
    return window.viewport.projectToScreen(m.getWorldPosition(m.position.clone()));
  }, plane);
  await page.mouse.click(p.x, p.y);
}
const P = (origin, normal, xdir) => ({ origin, normal, xdir });

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((ws) => {
    const N = window.WebSocket;
    window.WebSocket = class extends N {
      constructor(u, p) {
        super(String(u).replace(":8765", `:${ws}`), p);
      }
    };
    // Items and History open, no welcome window, no tips.
    localStorage.setItem("fundacad.welcomeOnStartup", "false");
    localStorage.setItem("fundacad.shell.items", "1");
    localStorage.setItem("fundacad.shell.history", "1");
  }, ENGINE_PORT);
  await page.goto(`${APP}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.sketch && !!window.geometry, null, {
    timeout: 60000,
  });
  // The frame-rate and round-trip readouts are diagnostics, not part of the product.
  await page.addStyleTag({ content: "#fps,.roundtrip,.perf-warn-group{display:none!important}" });
  await sleep(1500);
  return { page, errors };
}

function makeCtx(page, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docshot-"));
  const ctx = { page, name, frames: [], clip: null, dir };
  const evalIn = (fn, arg) => page.evaluate(fn, arg);

  // Park the pointer on empty card space so no hover or snap marker is left under it.
  ctx.park = async () => {
    await page.mouse.move(150, 840);
    await evalIn(() => window.viewport.clearHover && window.viewport.clearHover());
    await sleep(250);
  };
  ctx.settle = async (ms = 600) => {
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 120000 });
    await sleep(ms);
  };
  ctx.at = (p) => evalIn((q) => window.viewport.projectToScreen({ x: q[0], y: q[1], z: q[2] }), p);
  ctx.sk = (x, y) => evalIn(([a, b]) => window.viewport.projectToScreen(window.sketch.plane.to3D(a, b)), [x, y]);
  ctx.ents = () => evalIn(() => window.sketch.entities.map((e) => ({ ...e })));
  ctx.move = async (x, y, steps = 6, grab = false) => {
    if (!grab) return page.mouse.move(x, y, { steps });
    const from = ctx.last || { x, y };
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps);
      await ctx.frame(100);
    }
    ctx.last = { x, y };
  };
  ctx.hover = async (x, y) => {
    await page.mouse.move(x, y, { steps: 4 });
    await sleep(350);
  };
  ctx.clickAt = async (x, y) => {
    await ctx.hover(x, y);
    await page.mouse.click(x, y);
    await sleep(350);
  };
  ctx.features = async (feats) => {
    await evalIn(async (list) => {
      const s = window.store;
      const ids = [];
      for (const f of list) {
        const id = s.nextId();
        ids.push(id);
        const out = { ...f, id };
        for (const k of ["sketch", "profile", "path"]) if (typeof out[k] === "number") out[k] = ids[out[k]];
        if (out.features) out.features = out.features.map((i) => ids[i]);
        if (out.profiles) out.profiles = out.profiles.map((q) => ({ ...q, sketch: ids[q.sketch] }));
        s.addFeature(out);
        const t0 = Date.now();
        while (Date.now() - t0 < 90000) {
          if (!s.buildState.building && s.buildState.result) break;
          await new Promise((r) => setTimeout(r, 60));
        }
      }
      if (s.buildState.errorMessage) throw new Error(s.buildState.errorMessage);
    }, feats);
    await ctx.settle();
  };
  ctx.view = async (name = "iso", zoom = 0) => {
    await evalIn((n) => window.viewport.setStandardView(n), name);
    await sleep(700);
    await evalIn(() => window.viewport.fitView());
    await sleep(1600);
    await ctx.zoom(zoom);
  };
  ctx.zoom = async (n) => {
    const canvas = await page.locator("#canvas").boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    for (let i = 0; i < Math.abs(n); i++) {
      await page.mouse.wheel(0, n > 0 ? -240 : 240);
      await sleep(150);
    }
    await sleep(900);
  };
  // The canvas runs under the floating cards, so its middle is not the middle of
  // what can be seen. Slide the view until the model sits between rail and right column.
  ctx.centre = async () => {
    await evalIn(() => {
      const vp = window.viewport;
      const rail = document.querySelector("#toolrail").getBoundingClientRect();
      const right = document.querySelector(".float-right").getBoundingClientRect();
      const canvas = document.querySelector("#canvas").getBoundingClientRect();
      const shift = (rail.right + right.left) / 2 - (canvas.left + canvas.width / 2);
      vp.rig.panScreen((-shift * vp.pixelWorldSize(vp.rig.getTarget())) / vp.rig.viewScale(), 0);
      vp.requestRender();
    });
    await sleep(600);
  };
  ctx.clearSelection = async () => {
    await evalIn(() => {
      window.__fundacad.selectFeature(null);
      window.viewport.setSelectedBodies([]);
      window.viewport.clearSelection();
    });
    await sleep(300);
  };
  ctx.pickLabel = async (id, label) => {
    await page.click(`[data-testid=${id}]`);
    await sleep(200);
    await evalIn((l) => {
      const row = [...document.querySelectorAll(".select-pop .opt-row")].find((r) => r.textContent.trim() === l);
      if (row) row.click();
    }, label);
    await sleep(250);
  };

  // clip is {x,y,width,height}; omitted means the whole window.
  ctx.still = async (file, clip) => {
    fs.mkdirSync(OUT, { recursive: true });
    const out = path.join(OUT, `${file}.png`);
    await page.screenshot({ path: out, ...(clip && !FULL ? { clip } : {}) });
    ctx.made.push(`${file}.png`);
    console.log(`  ${file}.png`);
  };
  ctx.box = async (selector, pad = 14) => {
    const b = await page.locator(selector).first().boundingBox();
    if (!b) throw new Error(`no ${selector}`);
    const x = Math.max(0, b.x - pad),
      y = Math.max(0, b.y - pad);
    return { x, y, width: Math.min(W - x, b.width + 2 * pad), height: Math.min(H - y, b.height + 2 * pad) };
  };
  ctx.made = [];
  // The floating box that holds a selector: the nearest positioned ancestor.
  ctx.cardOf = async (selector, pad = 10) => {
    const b = await page.evaluate((sel) => {
      let n = document.querySelector(sel);
      while (n && n.parentElement && !["fixed", "absolute"].includes(getComputedStyle(n).position)) n = n.parentElement;
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector);
    const x = Math.max(0, b.x - pad),
      y = Math.max(0, b.y - pad);
    return { x, y, width: Math.min(1440 - x, b.width + 2 * pad), height: Math.min(900 - y, b.height + 2 * pad) };
  };

  ctx.startRec = (clip) => {
    ctx.clip = clip;
    ctx.frames = [];
  };
  ctx.frame = async (ms = 100) => {
    if (!ctx.clip) return;
    const f = path.join(ctx.dir, `f${String(ctx.frames.length).padStart(4, "0")}.png`);
    await page.screenshot({ path: f, clip: ctx.clip });
    ctx.frames.push({ f, ms });
  };
  ctx.hold = async (ms, n = 1) => {
    for (let i = 0; i < n; i++) await ctx.frame(ms / n);
  };
  ctx.endRec = (file, width = 800) => {
    const list = path.join(ctx.dir, "frames.txt");
    fs.writeFileSync(list, ctx.frames.map((f) => `${f.f}\t${f.ms}`).join("\n"));
    const out = path.join(OUT, `${file}.gif`);
    fs.mkdirSync(OUT, { recursive: true });
    // -I drops the user site where Pillow lives on this machine, so add it back.
    const code = `
import sys, site
sys.path.append(site.getusersitepackages())
from PIL import Image
rows = [l.split("\\t") for l in open(sys.argv[1]).read().split("\\n") if l]
width = int(sys.argv[3])
imgs, durs = [], []
for f, ms in rows:
    im = Image.open(f).convert("RGB")
    h = round(im.height * width / im.width)
    imgs.append(im.resize((width, h), Image.LANCZOS))
    durs.append(int(float(ms)))
# one shared palette keeps the colours from shimmering between frames
strip = Image.new("RGB", (width, imgs[0].height * min(len(imgs), 8)))
for i, im in enumerate(imgs[:: max(1, len(imgs) // 8)][:8]):
    strip.paste(im, (0, i * im.height))
pal = strip.quantize(colors=int(sys.argv[4]), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
frames = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in imgs]
frames[0].save(sys.argv[2], save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=True, disposal=1)
`;
    let colors = 96;
    for (;;) {
      const r = spawnSync("python", ["-I", "-c", code, list, out, String(width), String(colors)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`gif assembly failed: ${r.stderr}`);
      const kb = fs.statSync(out).size / 1024;
      if (kb < 1400 || colors <= 24) {
        console.log(`  ${file}.gif ${Math.round(kb)} KB, ${ctx.frames.length} frames, ${colors} colours`);
        break;
      }
      colors = Math.max(24, Math.round(colors * 0.7));
    }
    ctx.made.push(`${file}.gif`);
    ctx.clip = null;
  };
  return ctx;
}

// ------------------------------------------------------------------- parts ---

// The mounting plate of the first-part tutorial, 40 x 20 x 5 with a 6 mm hole.
const plate = () => [
  {
    type: "sketch",
    plane: "XY",
    entities: [
      { type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 20 },
      { type: "circle", id: "c1", x: -10, y: 0, radius: 3 },
    ],
  },
  { type: "extrude", sketch: 0, distance: 5, operation: "new", regions: [[10, 0, 0]] },
];

// A shelf bracket: base plate, upstand, gusset, four holes, rounded corners.
const bracket = () => {
  const B = 8;
  return [
    { type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 70, height: 50, x: 0, y: 0 }] },
    { type: "extrude", sketch: 0, distance: B, operation: "new" },
    { type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: B, height: 50, x: -31, y: 0 }] },
    { type: "extrude", sketch: 2, distance: 58, operation: "join" },
    {
      type: "sketch",
      plane: P([0, 3, 0], [0, -1, 0], [1, 0, 0]),
      entities: [
        { type: "line", x1: -27, y1: B, x2: -27, y2: 46 },
        { type: "line", x1: -27, y1: 46, x2: 6, y2: B },
        { type: "line", x1: 6, y1: B, x2: -27, y2: B },
      ],
    },
    { type: "extrude", sketch: 4, distance: 6, operation: "join" },
    { type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [-27, -14, B] }], radius: 4 },
    {
      type: "sketch",
      plane: "XY",
      entities: [
        { type: "circle", radius: 2.75, x: 0, y: 17 },
        { type: "circle", radius: 2.75, x: 0, y: -17 },
        { type: "circle", radius: 2.75, x: 24, y: 17 },
        { type: "circle", radius: 2.75, x: 24, y: -17 },
      ],
    },
    { type: "extrude", sketch: 7, distance: B, operation: "cut" },
    {
      type: "sketch",
      plane: P([-35, 0, 0], [1, 0, 0], [0, 1, 0]),
      entities: [
        { type: "circle", radius: 2.75, x: 0, y: 22 },
        { type: "circle", radius: 2.75, x: 0, y: 42 },
      ],
    },
    { type: "extrude", sketch: 9, distance: B, operation: "cut" },
    { type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [35, 25, 4] }], radius: 8 },
    { type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [35, -25, 4] }], radius: 8 },
  ];
};

// ------------------------------------------------------------------- shots ---

// Drives the tutorial's own steps, with the mouse and keys the text names.
async function drawPlate(ctx, { stills }) {
  const { page } = ctx;
  await page.mouse.move(800, 500);
  await page.keyboard.press("s");
  await sleep(700);
  await clickTile(page, "XY");
  await page.waitForFunction(() => window.sketch.active, null, { timeout: 15000 });
  await sleep(2000);
  await page.keyboard.press("r");
  await ctx.clickAt(640, 400);
  await ctx.move(880, 520, 8);
  await page.mouse.click(880, 520);
  await sleep(400);
  if (stills) {
    await ctx.move(1000, 760);
    await sleep(300);
    await ctx.still("first-part-rectangle", { x: 280, y: 40, width: 890, height: 850 });
  }
  await page.keyboard.press("d");
  let r = (await ctx.ents())[0];
  let p = await ctx.sk(r.x, r.y - r.height / 2);
  await ctx.clickAt(p.x, p.y);
  await page.keyboard.type("40");
  await page.keyboard.press("Enter");
  await sleep(500);
  r = (await ctx.ents())[0];
  p = await ctx.sk(r.x + r.width / 2, r.y);
  await ctx.clickAt(p.x, p.y);
  await page.keyboard.type("20");
  await page.keyboard.press("Enter");
  await sleep(500);
  r = (await ctx.ents())[0];
  await page.keyboard.press("c");
  const a = await ctx.sk(r.x - 10, r.y);
  const b = await ctx.sk(r.x - 6, r.y);
  await ctx.clickAt(a.x, a.y);
  await ctx.move(b.x, b.y, 6);
  await sleep(250);
  await page.keyboard.type("6");
  await page.keyboard.press("Enter");
  await sleep(500);
  await page.keyboard.press("Escape");
  await sleep(300);
}

// A 40 x 30 x 20 block, and a bolt-on part beside it, for the tool shots.
const block = () => [
  { type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 30 }] },
  { type: "extrude", sketch: 0, distance: 20, operation: "new", regions: [[0, 0, 0]] },
];

// Three separate bodies, for the Items card.
const trio = () => [
  { type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: -30, y: 0, width: 40, height: 30 }] },
  { type: "extrude", sketch: 0, distance: 12, operation: "new", regions: [[-30, 0, 0]] },
  { type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 20, y: 0, radius: 9 }] },
  { type: "extrude", sketch: 2, distance: 24, operation: "new", regions: [[20, 0, 0]] },
  { type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c2", x: 50, y: 0, radius: 6 }] },
  { type: "extrude", sketch: 4, distance: 16, operation: "new", regions: [[50, 0, 0]] },
];

// Pick the face holding a model point, the way two clicks do (body, then face).
async function pickFace(ctx, pt) {
  await ctx.page.evaluate((p) => {
    const v = window.viewport;
    v.selectOnlyFace(v.faceIdNear(p));
    v.onSelectionChange?.();
  }, pt);
  await sleep(500);
}

// Pick the edge nearest a model point by clicking it, with the Fillet tool already armed.
async function edgeScreen(ctx, pt) {
  return ctx.page.evaluate((pt) => {
    const v = window.viewport;
    const V = v.camera.position.constructor;
    const sp = v.projectToScreen(new V(pt[0], pt[1], pt[2]));
    for (let dx = -6; dx <= 6; dx += 2)
      for (let dy = -6; dy <= 6; dy += 2) {
        if (v.pickEdgeAt(sp.x + dx, sp.y + dy)) return { x: sp.x + dx, y: sp.y + dy };
      }
    return null;
  }, pt);
}

// The round handle that stands off a selected face along its normal.
async function nudgeHandle(page) {
  return page.evaluate(() => {
    const w = window.__fundacad.nudge.want;
    const k = window.viewport.pixelWorldSize(w.anchor);
    const ax = w.axis(window.viewport);
    const at = (n) => window.viewport.projectToScreen(w.anchor.clone().addScaledVector(ax, k * n));
    const a = at(20),
      b = at(60);
    return { x: a.x, y: a.y, dx: b.x - a.x, dy: b.y - a.y };
  });
}

const STILLS = {
  // The tutorial in one session: rectangle, extrude arrow, finished plate, export.
  async tutorial(ctx) {
    const { page } = ctx;
    await drawPlate(ctx, { stills: true });
    await page.keyboard.press("e");
    await sleep(1500);
    await ctx.view("iso", 2);
    const [cx, cy] = [15, 0];
    let q = await ctx.at([cx, cy, 0]);
    await ctx.clickAt(q.x, q.y);
    q = await ctx.at([cx, cy, 5]);
    await ctx.move(q.x + 150, q.y - 70, 6);
    await ctx.move(q.x + 150, q.y - 6, 8);
    await sleep(500);
    await page.keyboard.type("5");
    await sleep(900);
    await ctx.still("first-part-extrude", { x: 280, y: 100, width: 880, height: 780 });
    await page.keyboard.press("Enter");
    await ctx.settle(1200);
    await ctx.clearSelection();

    await openExport(ctx);
    await ctx.still("first-part-export", await ctx.box(".export-dialog"));
  },

  async "items-list"(ctx) {
    await ctx.features(trio());
    await ctx.page.evaluate(() => {
      const st = window.store;
      const ids = st.buildState.result.bodies.map((b) => b.id);
      st.setBodyName(ids[0], "Base");
      st.setBodyName(ids[1], "Post");
      st.setBodyName(ids[2], "Pin");
      const f = st.addElement("Hardware");
      st.setBodiesElement([ids[1], ids[2]], f);
      st.setBodyVisibility(ids[2], false);
    });
    await ctx.settle(900);
    await ctx.view("iso", 0);
    await ctx.centre();
    await ctx.park();
    const card = await ctx.box("#browser", 6);
    await ctx.still("items-list", { ...card, height: 440 });
  },

  async "history-card"(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await ctx.view("iso", 0);
    await ctx.park();
    await page.getByText("Extrude", { exact: true }).last().click();
    await sleep(1000);
    await ctx.park();
    await ctx.still("history-card", await ctx.box("#timeline", 6));
  },

  async "fillet-edge"(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await ctx.view("iso", 0);
    await ctx.centre();
    await page.evaluate(() => window.__fundacad.handleAction("fillet"));
    await sleep(400);
    const e = await edgeScreen(ctx, [0, -15, 20]);
    if (!e) throw new Error("no edge under the point");
    await ctx.hover(e.x, e.y);
    await page.mouse.click(e.x, e.y);
    await ctx.settle(900);
    const input = await page.$(".dim-input:not([style*='display: none']) input[type=text]");
    await input.fill("5");
    await sleep(1200);
    await ctx.settle(500);
    await ctx.still("fillet-edge", { x: 290, y: 210, width: 860, height: 600 });
    await page.keyboard.press("Escape");
  },

  async "extrude-taper"(ctx) {
    const { page } = ctx;
    await ctx.features([
      { type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 30 }] },
    ]);
    await ctx.view("iso", 1);
    await ctx.centre();
    await page.evaluate(() => {
      window.overlay.selectRegionsByPoints([[0, 0, 0]]);
      window.__fundacad.handleAction("extrude");
    });
    await sleep(600);
    const typeInto = async (i, text) => {
      const f = (await page.$$(".dim-input input"))[i];
      await f.click({ clickCount: 3 });
      await page.keyboard.type(text);
      await page.mouse.move(1200, 780);
      await page.mouse.move(1210, 785);
      await sleep(1500);
    };
    await typeInto(0, "25");
    await typeInto(1, "12");
    await ctx.still("extrude-taper", { x: 400, y: 200, width: 760, height: 600 });
    await page.keyboard.press("Escape");
  },

  async "extrude-thin"(ctx) {
    await ctx.features([
      {
        type: "sketch",
        plane: "XY",
        entities: [
          { type: "line", id: "a", x1: -20, y1: -15, x2: 20, y2: -15 },
          { type: "line", id: "b", x1: 20, y1: -15, x2: 20, y2: 15 },
        ],
      },
      {
        type: "extrude",
        sketch: 0,
        distance: 20,
        operation: "new",
        thin: true,
        curves: ["a", "b"],
        thickness: 2,
        side: "inside",
      },
    ]);
    await showModel(ctx, -1);
    await sleep(800);
    await ctx.still("extrude-thin", { x: 420, y: 220, width: 640, height: 520 });
  },

  async "presspull-face"(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await ctx.view("iso", 0);
    await ctx.centre();
    await pickFace(ctx, [0, 0, 20]);
    const h = await nudgeHandle(page);
    await page.mouse.move(h.x, h.y);
    await sleep(300);
    await page.mouse.down();
    const len = Math.hypot(h.dx, h.dy) || 1;
    for (let i = 1; i <= 14; i++) {
      await page.mouse.move(h.x + (h.dx / len) * i * 5, h.y + (h.dy / len) * i * 5);
      await sleep(40);
    }
    await sleep(500);
    await page.keyboard.type("9");
    await sleep(1500);
    await ctx.still("presspull-face", { x: 300, y: 70, width: 840, height: 740 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
  },

  async "sketch-overview"(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await ctx.view("iso", 0);
    await page.keyboard.press("Escape");
    await pickFace(ctx, [0, 0, 20]);
    await page.keyboard.press("s");
    await page.waitForFunction(() => window.sketch.active, null, { timeout: 15000 });
    await sleep(2000);
    await ctx.park();
    await ctx.still("sketch-overview");
  },

  async "parameters-dialog"(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await page.evaluate(async () => {
      const st = window.store;
      st.setParamExpr("width", "40", "mm");
      st.setParamExpr("depth", "30", "mm");
      st.setParamExpr("wall", "width / 10", "mm");
      st.setParamExpr("holes", "4", "count");
    });
    await sleep(500);
    await page.evaluate(() => window.__fundacad.handleAction("change-parameters"));
    await sleep(1200);
    await ctx.still("parameters-dialog", await ctx.cardOf(".params-body"));
  },

  async "section-handle"(ctx) {
    const { page } = ctx;
    await ctx.features(bracket());
    await ctx.view("iso", 0);
    await ctx.centre();
    await page.evaluate(() => window.__fundacad.handleAction("section"));
    await sleep(800);
    await page.getByText("horizontal cut").click();
    await sleep(2000);
    await ctx.park();
    await ctx.still("section-handle", { x: 280, y: 40, width: 880, height: 740 });
  },

  async "section-chip"(ctx) {
    const { page } = ctx;
    await ctx.features(bracket());
    await ctx.view("iso", 0);
    await ctx.centre();
    await page.evaluate(() => window.__fundacad.handleAction("section"));
    await sleep(800);
    await page.getByText("horizontal cut").click();
    await sleep(1200);
    await page.keyboard.press("Enter");
    await sleep(1500);
    await ctx.park();
    await ctx.still("section-chip", { x: 280, y: 40, width: 880, height: 740 });
  },

  async "properties-panel"(ctx) {
    const { page } = ctx;
    await ctx.features(bracket());
    await ctx.view("iso", 0);
    await page.evaluate(() => window.__fundacad.handleAction("properties"));
    await sleep(1500);
    await ctx.still("properties-panel", await ctx.cardOf(".properties-panel .measure-title"));
  },

  async "hole-dialog"(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await page.click("#timeline .float-card-close");
    await ctx.view("iso", 0);
    await ctx.centre();
    await page.evaluate(() => window.__fundacad.handleAction("hole"));
    await sleep(800);
    const pt = await ctx.at([5, 5, 20]);
    await ctx.hover(pt.x, pt.y);
    await page.mouse.click(pt.x, pt.y);
    await sleep(1500);
    await ctx.still("hole-dialog", { x: 200, y: 100, width: 960, height: 700 });
  },

  async "render-camera-tab"(ctx) {
    const { page } = ctx;
    await ctx.features(bracket());
    await ctx.view("iso", 0);
    await page.getByText("Render", { exact: true }).first().click();
    await sleep(2500);
    await page.getByText("Camera", { exact: true }).first().click();
    await sleep(1500);
    await ctx.park();
    await ctx.still("render-camera-tab", { x: 1120, y: 40, width: 320, height: 580 });
  },

  async "printability-panel"(ctx) {
    const { page } = ctx;
    await ctx.features(bracket());
    await ctx.view("iso", 0);
    await page.click('#toolrail [data-family="cat:PRINT"]');
    await sleep(500);
    await page.click('[data-pick="print-printability"]');
    await sleep(800);
    await page.click(".printability-run");
    await sleep(4000);
    await ctx.still("printability-panel", await ctx.cardOf(".printability-run", 6));
  },

  async "export-dialog"(ctx) {
    const { page } = ctx;
    await ctx.features(plate());
    await ctx.view("iso", 1);
    await openExport(ctx);
    await ctx.still("export-dialog", await ctx.box(".export-dialog"));
  },
};

// STL at Medium, the setting the tutorial and the export page talk about.
async function openExport(ctx) {
  await ctx.page.evaluate(() => window.__fundacad.handleAction("export"));
  await ctx.page.waitForSelector(".export-dialog", { timeout: 10000 });
  await ctx.pickLabel("export-format", "STL (*.stl)");
  await ctx.pickLabel("export-refinement", "Medium");
  await sleep(500);
}

const GIFS = {
  // Draw a rectangle, then pull it up into a plate.
  async "rectangle-extrude"(ctx) {
    const { page } = ctx;
    const clip = { x: 280, y: 90, width: 880, height: 720 };
    await page.mouse.move(800, 500);
    await page.keyboard.press("s");
    await sleep(700);
    await clickTile(page, "XY");
    await page.waitForFunction(() => window.sketch.active, null, { timeout: 15000 });
    await sleep(2000);
    await page.keyboard.press("r");
    await ctx.hover(620, 380);
    ctx.startRec(clip);
    ctx.last = { x: 620, y: 380 };
    await ctx.hold(500, 3);
    await page.mouse.click(620, 380);
    await ctx.move(900, 540, 12, true);
    await page.mouse.click(900, 540);
    await sleep(300);
    await ctx.move(1000, 700, 3, true);
    await ctx.hold(600, 3);
    await page.keyboard.press("Escape");
    await sleep(300);
    const r = (await ctx.ents())[0];
    await page.keyboard.press("e");
    await sleep(1500);
    await ctx.view("iso", 1);
    await ctx.centre();
    const base = await ctx.at([r.x, r.y, 0]);
    await ctx.clickAt(base.x, base.y);
    const top = await ctx.at([r.x, r.y, 12]);
    ctx.last = { x: base.x + 120, y: base.y - 10 };
    await page.mouse.move(ctx.last.x, ctx.last.y);
    await ctx.hold(500, 3);
    await ctx.move(top.x + 120, top.y - 20, 12, true);
    await ctx.hold(900, 3);
    ctx.endRec("rectangle-extrude");
  },

  // Grab the arrow on the top face and pull it out.
  async presspull(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await ctx.view("iso", -2);
    await ctx.centre();
    await pickFace(ctx, [0, 0, 20]);
    await ctx.park();
    const h = await nudgeHandle(page);
    const len = Math.hypot(h.dx, h.dy) || 1;
    const [ux, uy] = [h.dx / len, h.dy / len];
    await page.mouse.move(h.x, h.y);
    await sleep(300);
    ctx.startRec({ x: 300, y: 80, width: 840, height: 740 });
    await ctx.hold(600, 3);
    await page.mouse.down();
    ctx.last = { x: h.x, y: h.y };
    await ctx.move(h.x + ux * 100, h.y + uy * 100, 14, true);
    await ctx.hold(500, 2);
    await ctx.move(h.x + ux * 60, h.y + uy * 60, 8, true);
    await ctx.hold(900, 3);
    await page.mouse.up();
    ctx.endRec("presspull");
    await page.keyboard.press("Escape");
  },

  // The radius growing on one edge.
  async "fillet-drag"(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await ctx.view("iso", 0);
    await ctx.centre();
    await page.evaluate(() => window.__fundacad.handleAction("fillet"));
    await sleep(400);
    const e = await edgeScreen(ctx, [0, -15, 20]);
    await ctx.hover(e.x, e.y);
    await page.mouse.click(e.x, e.y);
    await ctx.settle(900);
    const input = await page.$(".dim-input:not([style*='display: none']) input[type=text]");
    ctx.startRec({ x: 290, y: 210, width: 860, height: 600 });
    await ctx.hold(600, 3);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 7, 6]) {
      await input.fill(String(v));
      await ctx.settle(250);
      await ctx.hold(220, 2);
    }
    await ctx.hold(700, 2);
    ctx.endRec("fillet-drag");
    await page.keyboard.press("Escape");
  },

  // A finished part turning in the viewport.
  async orbit(ctx) {
    const { page } = ctx;
    await ctx.features(bracket());
    await ctx.view("iso", 0);
    await ctx.centre();
    await ctx.park();
    const c = await ctx.at([0, 0, 10]);
    await page.mouse.move(c.x, c.y);
    ctx.startRec({ x: 340, y: 90, width: 760, height: 700 });
    await ctx.hold(400, 1);
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(c.x + i * 13, c.y + Math.sin(i / 4) * 6);
      await ctx.frame(140);
    }
    await page.mouse.up({ button: "right" });
    await ctx.hold(500, 1);
    ctx.endRec("orbit");
  },
};

// ---------------------------------------------------- model, sketch pages ---

const VIEW = { x: 410, y: 150, width: 660, height: 620 };
const SKETCH = { x: 410, y: 100, width: 660, height: 700 };

// Iso view of whatever is built, centred between the rail and the right column.
async function showModel(ctx, zoom = -1) {
  await ctx.view("iso", zoom);
  await ctx.centre();
  await ctx.clearSelection();
  await ctx.park();
}

// Open a sketch on the XY plane the way the tutorial does.
async function startSketch(ctx) {
  const { page } = ctx;
  await page.mouse.move(800, 500);
  await page.keyboard.press("s");
  await sleep(700);
  await clickTile(page, "XY");
  await page.waitForFunction(() => window.sketch.active, null, { timeout: 15000 });
  await sleep(2000);
}

// A rectangle drawn with the mouse, tool back on select.
async function drawRect(ctx, a = [640, 400], b = [880, 520]) {
  const { page } = ctx;
  await page.keyboard.press("r");
  await ctx.clickAt(a[0], a[1]);
  await ctx.move(b[0], b[1], 8);
  await page.mouse.click(b[0], b[1]);
  await sleep(400);
  await page.keyboard.press("Escape");
  await sleep(300);
}

// Click the history row named `label` so its value rows open.
async function openStep(ctx, label) {
  await ctx.page.getByText(label, { exact: true }).last().click();
  await sleep(1000);
  await ctx.park();
}

Object.assign(STILLS, {
  async "combine-subtract"(ctx) {
    await ctx.features([
      { type: "box", length: 40, width: 30, height: 20, operation: "new" },
      { type: "cylinder", radius: 8, height: 40, operation: "cut" },
    ]);
    await showModel(ctx);
    await ctx.still("combine-subtract", VIEW);
  },

  async "primitive-cylinder"(ctx) {
    await ctx.features([{ type: "cylinder", radius: 12, height: 30, operation: "new" }]);
    await showModel(ctx, -2);
    await openStep(ctx, "Cylinder");
    await ctx.still("primitive-cylinder", { x: 540, y: 40, width: 890, height: 720 });
  },

  async "construct-planes"(ctx) {
    await ctx.features([
      ...block(),
      { type: "datumPlane", plane: "XY", offset: 32, name: "Plane 1" },
      { type: "datumAxis", origin: [0, 0, 0], dir: [0, 0, 1], name: "Axis 1" },
    ]);
    await showModel(ctx, -1);
    await ctx.still("construct-planes", VIEW);
  },

  async "loft-adapter"(ctx) {
    await ctx.features([
      { type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: 14 }] },
      {
        type: "sketch",
        plane: P([0, 0, 30], [0, 0, 1], [1, 0, 0]),
        entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 36, height: 36 }],
      },
      {
        type: "loft",
        profiles: [
          { sketch: 0, region: [0, 0, 0] },
          { sketch: 1, region: [0, 0, 30] },
        ],
        operation: "new",
      },
    ]);
    await showModel(ctx);
    await ctx.still("loft-adapter", VIEW);
  },

  async "revolve-profile"(ctx) {
    await ctx.features([
      {
        type: "sketch",
        plane: "XZ",
        entities: [
          { type: "line", x1: 0, y1: 0, x2: 14, y2: 0 },
          { type: "line", x1: 14, y1: 0, x2: 20, y2: 15 },
          { type: "line", x1: 20, y1: 15, x2: 10, y2: 40 },
          { type: "line", x1: 10, y1: 40, x2: 14, y2: 50 },
          { type: "line", x1: 14, y1: 50, x2: 0, y2: 50 },
          { type: "line", x1: 0, y1: 50, x2: 0, y2: 0 },
        ],
      },
      { type: "revolve", sketch: 0, axis: "Z", angle: 360, operation: "new", regions: [[5, 0, 20]] },
    ]);
    await showModel(ctx);
    await ctx.still("revolve-profile", VIEW);
  },

  async "mirror-half"(ctx) {
    await ctx.features([
      { type: "sketch", plane: "XY", entities: [{ type: "rectangle", x: 20, y: 0, width: 24, height: 30 }] },
      { type: "extrude", sketch: 0, distance: 14, operation: "new", regions: [[20, 0, 0]] },
      { type: "sketch", plane: "XY", entities: [{ type: "rectangle", x: 12, y: 0, width: 8, height: 30 }] },
      { type: "extrude", sketch: 2, distance: 34, operation: "join", regions: [[12, 0, 0]] },
      { type: "mirror", plane: "YZ" },
    ]);
    await showModel(ctx);
    await ctx.still("mirror-half", VIEW);
  },

  async "shell-mug"(ctx) {
    await ctx.features([
      { type: "cylinder", radius: 20, height: 36, operation: "new" },
      { type: "shell", thickness: 3, faces: { kind: "face", by: "normal", dir: [0, 0, 1] } },
    ]);
    await showModel(ctx);
    await ctx.still("shell-mug", VIEW);
  },

  async "split-body"(ctx) {
    await ctx.features([...block(), { type: "split", plane: "XZ", keep: "both" }]);
    await showModel(ctx);
    await ctx.still("split-body", VIEW);
  },

  async "offset-face"(ctx) {
    await ctx.features([
      ...block(),
      { type: "offsetFace", faces: { kind: "face", by: "nearest", point: [20, 0, 10] }, distance: 10 },
    ]);
    await showModel(ctx);
    await ctx.still("offset-face", VIEW);
  },

  async "pattern-holes"(ctx) {
    await ctx.features([
      { type: "sketch", plane: "XY", entities: [{ type: "rectangle", x: 0, y: 0, width: 80, height: 30 }] },
      { type: "extrude", sketch: 0, distance: 6, operation: "new", regions: [[0, 0, 0]] },
      {
        type: "sketch",
        plane: P([0, 0, 6], [0, 0, 1], [1, 0, 0]),
        entities: [{ type: "circle", x: -28, y: 0, radius: 3.5 }],
      },
      { type: "extrude", sketch: 2, distance: -6, operation: "cut" },
      { type: "patternLinear", count: 5, spacing: 14, axis: "X", features: [3] },
    ]);
    await showModel(ctx);
    await ctx.still("pattern-holes", VIEW);
  },

  async "picking-face"(ctx) {
    await ctx.features(block());
    await showModel(ctx);
    const p = await ctx.at([0, 0, 20]);
    await ctx.hover(p.x, p.y);
    await ctx.still("picking-face", VIEW);
  },

  async "move-gizmo"(ctx) {
    await ctx.features(block());
    await showModel(ctx, -2);
    await ctx.page.evaluate(() => {
      const ids = window.store.buildState.result.bodies.map((b) => b.id);
      window.viewport.setSelectedBodies(ids);
      window.__fundacad.handleAction("move");
    });
    await sleep(1200);
    await ctx.park();
    await ctx.still("move-gizmo", { x: 420, y: 200, width: 900, height: 580 });
  },
});

Object.assign(STILLS, {
  async "sketch-typed-size"(ctx) {
    const { page } = ctx;
    await startSketch(ctx);
    await page.keyboard.press("r");
    await ctx.clickAt(640, 400);
    await ctx.move(880, 520, 8);
    await sleep(300);
    await page.keyboard.type("40");
    await sleep(700);
    await ctx.still("sketch-typed-size", { x: 540, y: 340, width: 640, height: 260 });
    await page.keyboard.press("Escape");
  },

  async "sketch-dimension"(ctx) {
    const { page } = ctx;
    await startSketch(ctx);
    await drawRect(ctx);
    await page.keyboard.press("d");
    const r = (await ctx.ents())[0];
    const p = await ctx.sk(r.x, r.y - r.height / 2);
    await ctx.hover(p.x, p.y);
    await ctx.clickAt(p.x, p.y);
    await sleep(500);
    await ctx.still("sketch-dimension", { x: 520, y: 360, width: 640, height: 260 });
    await page.keyboard.press("Escape");
  },

  async "sketch-constraints"(ctx) {
    await startSketch(ctx);
    await drawRect(ctx);
    const { page } = ctx;
    await page.keyboard.press("d");
    let r = (await ctx.ents())[0];
    let p = await ctx.sk(r.x, r.y - r.height / 2);
    await ctx.clickAt(p.x, p.y);
    await page.keyboard.type("40");
    await page.keyboard.press("Enter");
    await sleep(500);
    r = (await ctx.ents())[0];
    p = await ctx.sk(r.x + r.width / 2, r.y);
    await ctx.clickAt(p.x, p.y);
    await page.keyboard.type("20");
    await page.keyboard.press("Enter");
    await sleep(500);
    await page.keyboard.press("Escape");
    await ctx.park();
    await ctx.still("sketch-constraints", { x: 560, y: 70, width: 860, height: 600 });
  },

  // An outline drawn with Ctrl held (no snap) that stops 4 px short of its
  // start, beside a lone line: amber at the gap, red at the lone ends.
  async "sketch-loose-ends"(ctx) {
    const { page } = ctx;
    await startSketch(ctx);
    await page.keyboard.press("l");
    await page.keyboard.down("Control");
    for (const [x, y] of [
      [640, 400],
      [880, 400],
      [880, 520],
      [640, 520],
      [640, 404],
    ]) {
      await ctx.move(x, y, 6);
      await page.mouse.click(x, y);
      await sleep(150);
    }
    await page.keyboard.press("Escape");
    await ctx.move(940, 420, 6);
    await page.mouse.click(940, 420);
    await ctx.move(1000, 500, 6);
    await page.mouse.click(1000, 500);
    await page.keyboard.up("Control");
    await page.keyboard.press("Escape");
    await sleep(300);
    await page.keyboard.press("Escape");
    await ctx.park();
    await sleep(500);
    await ctx.still("sketch-loose-ends", { x: 560, y: 300, width: 520, height: 300 });
  },

  async "sketch-trim"(ctx) {
    const { page } = ctx;
    await startSketch(ctx);
    await page.keyboard.press("l");
    await ctx.clickAt(600, 520);
    await ctx.move(900, 520, 6);
    await page.mouse.click(900, 520);
    await page.keyboard.press("Escape");
    await page.keyboard.press("l");
    await ctx.clickAt(760, 360);
    await ctx.move(760, 640, 6);
    await page.mouse.click(760, 640);
    await page.keyboard.press("Escape");
    await sleep(300);
    await page.keyboard.press("t");
    await ctx.hover(830, 520);
    await ctx.still("sketch-trim", { x: 540, y: 300, width: 640, height: 400 });
    await page.keyboard.press("Escape");
  },

  async "sketch-pattern"(ctx) {
    const { page } = ctx;
    await startSketch(ctx);
    await page.evaluate(() => window.sketch.setTool("boltCircle"));
    await sleep(400);
    await ctx.clickAt(760, 500);
    await ctx.move(900, 500, 8);
    await sleep(600);
    await ctx.still("sketch-pattern", { x: 540, y: 300, width: 520, height: 440 });
    await page.keyboard.press("Escape");
  },

  async "sketch-pattern-rect"(ctx) {
    const { page } = ctx;
    await startSketch(ctx);
    await drawRect(ctx, [600, 420], [680, 480]);
    console.log("  ents", JSON.stringify(await ctx.ents()).slice(0, 120));
    const r = (await ctx.ents())[0];
    const top = await ctx.sk(r.x, r.y + r.height / 2);
    await page.keyboard.press("Control+a");
    await sleep(300);
    await page.evaluate(() => window.sketch.setTool("patternRect"));
    await sleep(400);
    await ctx.clickAt(top.x, top.y);
    await ctx.move(760, 520, 8);
    await sleep(600);
    await ctx.still("sketch-pattern-rect", SKETCH);
    await page.keyboard.press("Escape");
  },

  async "sketch-project"(ctx) {
    const { page } = ctx;
    await ctx.features(block());
    await ctx.view("iso", -1);
    await ctx.centre();
    await pickFace(ctx, [0, 0, 20]);
    await page.keyboard.press("s");
    await page.waitForFunction(() => window.sketch.active, null, { timeout: 15000 });
    await sleep(2500);
    await page.keyboard.press("p");
    await sleep(500);
    await ctx.clickAt(720, 470);
    await sleep(800);
    await page.keyboard.press("Enter");
    await sleep(1500);
    await ctx.park();
    await ctx.still("sketch-project", { x: 420, y: 200, width: 700, height: 520 });
  },

  async "sketch-palette"(ctx) {
    await startSketch(ctx);
    await ctx.park();
    await ctx.still("sketch-palette", { x: 1150, y: 60, width: 290, height: 620 });
  },
});

Object.assign(STILLS, {
  async "suppress-step"(ctx) {
    const { page } = ctx;
    await ctx.features([...block(), { type: "cylinder", radius: 6, height: 40, operation: "cut" }]);
    await showModel(ctx);
    const row = () => page.locator("#timeline").getByText("Cylinder", { exact: true }).last();
    await row().click({ button: "right" });
    await sleep(600);
    await page.getByText("Suppress", { exact: true }).first().click();
    await ctx.settle(900);
    await row().click({ button: "right" });
    await sleep(700);
    await ctx.still("suppress-step", { x: 1060, y: 20, width: 380, height: 520 });
    await page.keyboard.press("Escape");
  },
});

// ------------------------------------------------------------------ pass 2 --

async function openPrefs(ctx, category) {
  await ctx.page.keyboard.press("Control+Comma");
  await ctx.page.waitForSelector(".prefs-panel", { timeout: 10000 });
  await sleep(500);
  if (category) {
    await ctx.page.click(`.prefs-nav-btn[data-category="${category}"]`);
    await sleep(600);
  }
  await ctx.page.mouse.move(700, 880);
}

Object.assign(STILLS, {
  async "prefs-appearance"(ctx) {
    await openPrefs(ctx, "appearance");
    await ctx.still("prefs-appearance", await ctx.box(".prefs-panel", 6));
  },
  async "ai-live-document"(ctx) {
    await openPrefs(ctx, "mcp");
    await ctx.page.locator(".prefs-pane:visible .select-trigger, .prefs-pane:visible [role=combobox]").first().click();
    await sleep(500);
    await ctx.still("ai-live-document", { x: 230, y: 90, width: 980, height: 330 });
  },
  async "prefs-gamepad"(ctx) {
    await openPrefs(ctx, "plugins");
    await ctx.page.click('[data-plugin-row="FundaCAD.Gamepad"] [data-plugin-settings-toggle]');
    await ctx.page.locator('[data-plugin-row="FundaCAD.Gamepad"]').scrollIntoViewIfNeeded();
    await sleep(600);
    await ctx.still("prefs-gamepad", await ctx.box(".prefs-panel", 6));
  },
  async "shortcuts-overlay"(ctx) {
    await ctx.page.keyboard.press("Shift+Slash");
    await sleep(900);
    await ctx.still("shortcuts-overlay", await ctx.box(".shortcuts-panel", 6));
  },
});

// ------------------------------------------------------------ panels (pass 2) --

async function railPick(ctx, family, id) {
  await ctx.page.click(`#toolrail [data-family="${family}"]`);
  await sleep(500);
  await ctx.page.click(`[data-pick="${id}"]`);
  await sleep(1000);
}

// A block with a peg through it that is its own body.
const overlapPair = () => [
  { type: "box", length: 40, width: 30, height: 20, operation: "new" },
  { type: "cylinder", radius: 8, height: 40, operation: "new" },
];

// A T shape: the cap hangs 15 mm out on both sides, so its underside needs support.
const tee = () => [
  { type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 20, height: 20 }] },
  { type: "extrude", sketch: 0, distance: 20, operation: "new", regions: [[0, 0, 0]] },
  {
    type: "sketch",
    plane: P([0, 0, 20], [0, 0, 1], [1, 0, 0]),
    entities: [{ type: "rectangle", id: "r2", x: 0, y: 0, width: 50, height: 20 }],
  },
  { type: "extrude", sketch: 2, distance: 8, operation: "join", targets: ["body1"], regions: [[20, 0, 0]] },
];

async function closeHistory(ctx, keepToasts = false) {
  await ctx.page.click("#timeline .float-card-close").catch(() => {});
  if (!keepToasts) await ctx.page.addStyleTag({ content: ".toast-stack,.prompt{display:none!important}" });
  await sleep(500);
}

async function hideRail(ctx) {
  await ctx.page.addStyleTag({ content: "#toolrail{visibility:hidden!important}" });
  await sleep(300);
}

// Slide the model sideways by dx screen pixels (negative is left).
async function slide(ctx, dx) {
  await ctx.page.evaluate((d) => {
    const vp = window.viewport;
    vp.rig.panScreen((-d * vp.pixelWorldSize(vp.rig.getTarget())) / vp.rig.viewScale(), 0);
    vp.requestRender();
  }, dx);
  await sleep(600);
}

async function orbitDown(ctx, dy) {
  const { page } = ctx;
  await page.mouse.move(760, 450);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(760, 450 + dy, { steps: 10 });
  await page.mouse.up({ button: "right" });
  await sleep(900);
}

// A stout L bracket, small enough that the stress mesh stays fine.
const smallBracket = () => [
  { type: "sketch", plane: "XY", entities: [{ type: "rectangle", x: 0, y: 0, width: 40, height: 30 }] },
  { type: "extrude", sketch: 0, distance: 8, operation: "new" },
  {
    type: "sketch",
    plane: P([-20, 0, 0], [1, 0, 0], [0, 1, 0]),
    entities: [{ type: "rectangle", x: 0, y: 19, width: 30, height: 22 }],
  },
  { type: "extrude", sketch: 2, distance: 8, operation: "join", targets: ["body1"] },
  {
    type: "sketch",
    plane: "XY",
    entities: [
      { type: "circle", radius: 2.5, x: 8, y: 9 },
      { type: "circle", radius: 2.5, x: 8, y: -9 },
    ],
  },
  { type: "extrude", sketch: 4, distance: 8, operation: "cut", targets: ["body1"] },
];

async function runStress(ctx) {
  const { page } = ctx;
  await ctx.features(smallBracket());
  await closeHistory(ctx);
  await ctx.view("iso", 0);
  await slide(ctx, -100);
  await railPick(ctx, "cat:INSPECT", "stress");
  await page.getByRole("button", { name: "Click on body" }).first().click();
  const a = await ctx.at([10, 9, 8]);
  await ctx.clickAt(a.x, a.y);
  await sleep(700);
  await page.getByRole("button", { name: "Click on body" }).nth(1).click();
  const l = await ctx.at([-12, 0, 24]);
  await ctx.clickAt(l.x, l.y);
  await sleep(700);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page
    .waitForFunction(() => /safety|peak|Peak/i.test(document.body.innerText), null, { timeout: 90000 })
    .catch(async (e) => {
      await page.screenshot({ path: path.join(OUT, "debug-stress.png") });
      throw e;
    });
  await sleep(2500);
  await page.getByRole("button", { name: "True size", exact: true }).click();
  await ctx.park();
  await sleep(800);
}

Object.assign(STILLS, {
  async "interference-list"(ctx) {
    await ctx.features(overlapPair());
    await closeHistory(ctx);
    await ctx.view("iso", 0);
    await railPick(ctx, "cat:INSPECT", "interference");
    await sleep(6000);
    await ctx.park();
    await hideRail(ctx);
    await ctx.still("interference-list", { x: 440, y: 120, width: 750, height: 640 });
  },
  async "bed-fit-result"(ctx) {
    await ctx.features(bracket());
    await closeHistory(ctx, true);
    await ctx.view("iso", 0);
    await railPick(ctx, "cat:PRINT", "print-bed-fit-check");
    await ctx.page.click("text=220 x 220 x 250");
    await sleep(1500);
    await ctx.park();
    await hideRail(ctx);
    await ctx.still("bed-fit-result", { x: 400, y: 150, width: 640, height: 700 });
  },
  async "overhang-red"(ctx) {
    await ctx.features(tee());
    await closeHistory(ctx);
    await ctx.view("iso", 0);
    await orbitDown(ctx, -140);
    await ctx.page.evaluate(() => window.viewport.fitView());
    await sleep(1500);
    await ctx.centre();
    await ctx.zoom(-2);
    await railPick(ctx, "cat:INSPECT", "draft-analysis");
    await sleep(2500);
    await ctx.park();
    await hideRail(ctx);
    await ctx.still("overhang-red", { x: 330, y: 120, width: 850, height: 440 });
  },
  async "measure-two-holes"(ctx) {
    await ctx.features(bracket());
    await closeHistory(ctx);
    await ctx.view("iso", 0);
    await railPick(ctx, "cat:INSPECT", "measure");
    const a = await ctx.at([2.75, 17, 8]);
    await ctx.clickAt(a.x, a.y);
    const b = await ctx.at([26.75, 17, 8]);
    await ctx.clickAt(b.x, b.y);
    await sleep(800);
    await ctx.park();
    await hideRail(ctx);
    await ctx.still("measure-two-holes", { x: 400, y: 120, width: 790, height: 640 });
  },
  async "stress-bracket"(ctx) {
    await runStress(ctx);
    await ctx.page.addStyleTag({ content: ".measure-panel,#toolrail,.toolrail-hint{visibility:hidden!important}" });
    await sleep(400);
    await ctx.still("stress-bracket", { x: 280, y: 150, width: 580, height: 600 });
  },
  async "stress-results"(ctx) {
    await runStress(ctx);
    await hideRail(ctx);
    await ctx.still("stress-results", { x: 290, y: 120, width: 900, height: 740 });
  },
});

Object.assign(STILLS, {
  async "save-as-dialog"(ctx) {
    await ctx.features(plate());
    await ctx.view("iso", 1);
    await ctx.page.evaluate(() => window.__fundacad.handleAction("saveas"));
    await sleep(1500);
    await ctx.still("save-as-dialog", { x: 0, y: 0, width: W, height: H });
  },
  async "insert-document"(ctx) {
    await ctx.features(plate());
    await ctx.view("iso", 1);
    await ctx.page.evaluate(() => window.__fundacad.handleAction("insert-document"));
    await sleep(1500);
    await ctx.still("insert-document", { x: 0, y: 0, width: W, height: H });
  },
  async "import-step"(ctx) {
    await ctx.page.evaluate(() => window.__fundacad.handleAction("import"));
    await sleep(1500);
    await ctx.still("import-step", { x: 0, y: 0, width: W, height: H });
  },
  async "versions-panel"(ctx) {
    const { page } = ctx;
    await ctx.features(plate());
    await ctx.view("iso", 1);
    await closeHistory(ctx);
    await page.click('[title^="Versions"]');
    await sleep(800);
    await page.fill('input[placeholder="What changed"]', "first plate");
    await page.getByRole("button", { name: /Save version/ }).click();
    await sleep(1200);
    await ctx.features([{ type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [20, 10, 5] }], radius: 3 }]);
    await page.fill('input[placeholder="What changed"]', "rounded a corner");
    await page.getByRole("button", { name: /Save version/ }).click();
    await sleep(1500);
    await ctx.park();
    await ctx.still("versions-panel", { x: 1000, y: 290, width: 420, height: 280 });
  },
  // Three cards with real pictures: each template is built and drawn as a save would,
  // then Home reads them from the dev fake library.
  async home(ctx) {
    const { page } = ctx;
    const pics = [];
    for (const id of ["plate", "wall-bracket", "pinned-lever"]) {
      await page.evaluate(async (t) => {
        const { templateText } = await import("/src/templates/index.ts");
        window.store.load(await templateText(t));
      }, id);
      await sleep(400);
      await ctx.settle(800);
      pics.push(await page.evaluate(() => window.viewport.renderThumbnail(480, 300)));
    }
    await page.evaluate((thumbs) => {
      window.store.newDocument();
      const now = Date.now();
      const files = [
        { path: "D:/Projects/shelf/mounting plate.funda", mtimeMs: now - 40 * 60_000, thumb: thumbs[0] },
        { path: "D:/Projects/shelf/wall bracket.funda", mtimeMs: now - 26 * 3600_000, thumb: thumbs[1] },
        { path: "D:/Projects/press/lever arm.fundab", mtimeMs: now - 4 * 86400_000, thumb: thumbs[2] },
      ];
      localStorage.setItem(
        "fundacad.recentFiles",
        JSON.stringify(files.map((f, i) => ({ path: f.path, openedAt: now - i * 1000 }))),
      );
      localStorage.setItem("fundacad.home.folders", JSON.stringify([{ path: "D:/Projects/shelf", addedAt: now }]));
      localStorage.setItem("fundacad.welcomeOnStartup", "true");
      window.__fundacad.home.useFakeLibrary(files);
      window.__fundacad.handleAction("welcome");
    }, pics);
    await sleep(1500);
    await page.mouse.move(W - 40, H - 40);
    await sleep(300);
    await ctx.still("home", { x: 0, y: 0, width: W, height: H });
  },
  async "fasteners-window"(ctx) {
    await ctx.features(plate());
    await ctx.view("iso", 1);
    await railPick(ctx, "cat:INSERT", "fasteners");
    await sleep(1000);
    await ctx.page.locator("text=M3").first().click();
    await sleep(2500);
    await ctx.park();
    await ctx.still("fasteners-window", { x: 280, y: 120, width: 900, height: 720 });
  },
  async "printing-menu"(ctx) {
    await ctx.features(plate());
    await ctx.view("iso", 1);
    await ctx.page.click('#toolrail [data-family="cat:PRINT"]');
    await sleep(800);
    await ctx.still("printing-menu", { x: 280, y: 290, width: 480, height: 600 });
  },
  async "texture-knurl"(ctx) {
    await ctx.features([{ type: "cylinder", radius: 12, height: 20, operation: "new" }]);
    await ctx.view("iso", 0);
    await railPick(ctx, "cat:MODIFY", "texture");
    await ctx.page.getByText("Whole Body", { exact: true }).click();
    await sleep(500);
    await ctx.clickAt(600, 480);
    await sleep(500);
    await ctx.page.getByText("Add", { exact: true }).click();
    await sleep(6000);
    await ctx.park();
    await ctx.still("texture-knurl", { x: 440, y: 40, width: 1000, height: 840 });
  },
  async "render-material-sliders"(ctx) {
    const { page } = ctx;
    await ctx.features(bracket());
    await ctx.view("iso", 0);
    await page.getByText("Render", { exact: true }).first().click();
    await sleep(2500);
    await page.getByText("Steel", { exact: true }).click();
    await sleep(1500);
    await page.getByText("Metalness").first().scrollIntoViewIfNeeded();
    await ctx.park();
    await sleep(600);
    await ctx.still("render-material-sliders", { x: 1125, y: 40, width: 315, height: 850 });
  },
});

Object.assign(STILLS, {
  async "parameter-setup"(ctx) {
    const { page } = ctx;
    await ctx.features(plate());
    await page.evaluate(() => {
      const s = window.store;
      s.addParam("width", "40");
      s.addParam("gap", "0.4");
      s.addParam("solidCore", "1", "count");
    });
    await sleep(2500);
    await page.getByText("Edit", { exact: true }).first().click();
    await sleep(500);
    await page.getByText("Parameter Setup").click();
    await sleep(1500);
    await ctx.still("parameter-setup", { x: 570, y: 120, width: 620, height: 430 });
  },
  async "spacemouse-settings"(ctx) {
    const { page } = ctx;
    await page.getByText("View", { exact: true }).first().click();
    await sleep(600);
    await page.getByText("3D Mouse Settings").click();
    await sleep(1500);
    await ctx.still("spacemouse-settings", await ctx.box(".prefs-panel", 6));
  },
  async "expression-value"(ctx) {
    const { page } = ctx;
    await ctx.features([
      { type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 30 }] },
    ]);
    await page.evaluate(() => window.store.addParam("width", "40"));
    await ctx.view("iso", 0);
    await page.evaluate(() => window.__fundacad.handleAction("extrude"));
    await sleep(1000);
    const c = await ctx.at([0, 0, 0]);
    await ctx.clickAt(c.x, c.y);
    await sleep(1500);
    await page.keyboard.type("rib = width / 4", { delay: 40 });
    await sleep(800);
    await ctx.still("expression-value", { x: 600, y: 330, width: 480, height: 240 });
  },
});

Object.assign(STILLS, {});

// --------------------------------------------------------------------- main --

(async () => {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
  const all = [
    ...Object.keys(STILLS).map((n) => ({ n, kind: "still", fn: STILLS[n] })),
    ...Object.keys(GIFS).map((n) => ({ n, kind: "gif", fn: GIFS[n] })),
  ];
  if (args.includes("--list")) {
    console.log(all.map((s) => `${s.n} (${s.kind})`).join("\n"));
    return;
  }
  if (!TOKEN) {
    console.error("set SC_TOKEN to the engine token");
    process.exit(1);
  }
  const todo = all.filter((s) =>
    only
      ? only.includes(s.n)
      : args.includes("--stills")
        ? s.kind === "still"
        : args.includes("--gifs")
          ? s.kind === "gif"
          : true,
  );

  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  let failed = 0;
  for (const s of todo) {
    console.log(`${s.n}`);
    const { page, errors } = await openPage(browser);
    const ctx = makeCtx(page, s.n);
    try {
      await s.fn(ctx);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${s.n}: ${e.message.split("\n")[0]}`);
    }
    if (errors.length) console.log(`  page errors: ${errors.slice(0, 2).join(" | ").slice(0, 200)}`);
    fs.rmSync(ctx.dir, { recursive: true, force: true });
    await page.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
