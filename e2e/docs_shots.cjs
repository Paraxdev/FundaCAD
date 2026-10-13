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
const OUT = path.resolve(__dirname, "..", "manual", "docs", "img");
const W = 1440;
const H = 900;

// ------------------------------------------------------------------ helpers --

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (origin, normal, xdir) => ({ origin, normal, xdir });

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((ws) => {
    const N = window.WebSocket;
    window.WebSocket = class extends N {
      constructor(u, p) { super(String(u).replace(":8765", `:${ws}`), p); }
    };
    // Items and History open, no welcome window, no tips.
    localStorage.setItem("fundacad.welcomeOnStartup", "false");
    localStorage.setItem("fundacad.shell.items", "1");
    localStorage.setItem("fundacad.shell.history", "1");
  }, ENGINE_PORT);
  await page.goto(`${APP}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.sketch && !!window.geometry, null, { timeout: 60000 });
  // The frame-rate and round-trip readouts are diagnostics, not part of the product.
  await page.addStyleTag({ content: "#fps,.roundtrip{display:none!important}" });
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
    for (let i = 0; i < Math.abs(n); i++) { await page.mouse.wheel(0, n > 0 ? -240 : 240); await sleep(150); }
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
    await page.screenshot({ path: out, ...(clip ? { clip } : {}) });
    ctx.made.push(`${file}.png`);
    console.log(`  ${file}.png`);
  };
  ctx.box = async (selector, pad = 14) => {
    const b = await page.locator(selector).first().boundingBox();
    if (!b) throw new Error(`no ${selector}`);
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
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
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    return { x, y, width: Math.min(1440 - x, b.width + 2 * pad), height: Math.min(900 - y, b.height + 2 * pad) };
  };

  ctx.startRec = (clip) => { ctx.clip = clip; ctx.frames = []; };
  ctx.frame = async (ms = 100) => {
    if (!ctx.clip) return;
    const f = path.join(ctx.dir, `f${String(ctx.frames.length).padStart(4, "0")}.png`);
    await page.screenshot({ path: f, clip: ctx.clip });
    ctx.frames.push({ f, ms });
  };
  ctx.hold = async (ms, n = 1) => { for (let i = 0; i < n; i++) await ctx.frame(ms / n); };
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
      if (kb < 1400 || colors <= 24) { console.log(`  ${file}.gif ${Math.round(kb)} KB, ${ctx.frames.length} frames, ${colors} colours`); break; }
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
    type: "sketch", plane: "XY",
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
      type: "sketch", plane: P([0, 3, 0], [0, -1, 0], [1, 0, 0]),
      entities: [
        { type: "line", x1: -27, y1: B, x2: -27, y2: 46 },
        { type: "line", x1: -27, y1: 46, x2: 6, y2: B },
        { type: "line", x1: 6, y1: B, x2: -27, y2: B },
      ],
    },
    { type: "extrude", sketch: 4, distance: 6, operation: "join" },
    { type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [-27, -14, B] }], radius: 4 },
    {
      type: "sketch", plane: "XY",
      entities: [
        { type: "circle", radius: 2.75, x: 0, y: 17 }, { type: "circle", radius: 2.75, x: 0, y: -17 },
        { type: "circle", radius: 2.75, x: 24, y: 17 }, { type: "circle", radius: 2.75, x: 24, y: -17 },
      ],
    },
    { type: "extrude", sketch: 7, distance: B, operation: "cut" },
    {
      type: "sketch", plane: P([-35, 0, 0], [1, 0, 0], [0, 1, 0]),
      entities: [{ type: "circle", radius: 2.75, x: 0, y: 22 }, { type: "circle", radius: 2.75, x: 0, y: 42 }],
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
  await page.mouse.click(762, 602); // the XY label
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
    for (let dx = -6; dx <= 6; dx += 2) for (let dy = -6; dy <= 6; dy += 2) {
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
    const a = at(20), b = at(60);
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
    await ctx.features([{ type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 30 }] }]);
    await ctx.view("iso", 1);
    await ctx.centre();
    await page.evaluate(() => { window.overlay.selectRegionsByPoints([[0, 0, 0]]); window.__fundacad.handleAction("extrude"); });
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
    await ctx.still("section-handle", { x: 280, y: 60, width: 880, height: 720 });
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
    await page.mouse.click(762, 602);
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
  async "presspull"(ctx) {
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
  async "orbit"(ctx) {
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

// --------------------------------------------------------------------- main --

(async () => {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
  const all = [
    ...Object.keys(STILLS).map((n) => ({ n, kind: "still", fn: STILLS[n] })),
    ...Object.keys(GIFS).map((n) => ({ n, kind: "gif", fn: GIFS[n] })),
  ];
  if (args.includes("--list")) { console.log(all.map((s) => `${s.n} (${s.kind})`).join("\n")); return; }
  if (!TOKEN) { console.error("set SC_TOKEN to the engine token"); process.exit(1); }
  const todo = all.filter((s) =>
    only ? only.includes(s.n)
      : args.includes("--stills") ? s.kind === "still"
        : args.includes("--gifs") ? s.kind === "gif" : true);

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
