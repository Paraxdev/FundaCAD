// The README's screenshots, taken of a real document in a real browser.
//
// Usage (from the repo root, with the sidecar on 8765 and vite on 5173):
//   SC_TOKEN=<token> node e2e/readme_shots.cjs [outDir]
//
// The parts below are the ones in the README: a shelf bracket, a knurled
// control knob and a sensor housing. They are built through the same store the
// UI writes to, so what the screenshots show is the real thing rather than a
// mock-up, and a UI change that breaks one of these shows up as a failed pick
// rather than as a stale picture nobody noticed.
//
// SC_CHROME picks the browser. Any Chromium build works.

// Each part is a list of features in document order, written as plain data.
// Coordinates are mm and Z is up. XZ's normal is -Y, so a sketch meant to be
// centred on Y is given a PlaneDef rather than the base plane.

const P = (origin, normal, xdir) => ({ origin, normal, xdir });

// ---------------------------------------------------------------- bracket ---
// A shelf bracket: 8mm base plate, a 8mm upstand, a triangular gusset between
// them, four M5 clearance holes in the base and two in the upstand.
function bracket() {
  const B = 8; // plate thickness
  return [
    { type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 70, height: 50, x: 0, y: 0 }] },
    { type: "extrude", sketch: 0, distance: B, operation: "new" },

    { type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: B, height: 50, x: -31, y: 0 }] },
    { type: "extrude", sketch: 2, distance: 58, operation: "join" },

    // the gusset, on a plane 3mm to +Y so 6mm of extrude lands centred
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

    // where the plate meets the upstand, and the gusset's leading edge
    { type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [-27, 0, B] }], radius: 4 },

    // base holes
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

    // upstand holes, cut from the outer face inwards
    {
      type: "sketch",
      plane: P([-35, 0, 0], [1, 0, 0], [0, 1, 0]),
      entities: [
        { type: "circle", radius: 2.75, x: 0, y: 22 },
        { type: "circle", radius: 2.75, x: 0, y: 42 },
      ],
    },
    { type: "extrude", sketch: 9, distance: B, operation: "cut" },

    // the plate's free corners, and the top of the upstand
    { type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [35, 25, 4] }], radius: 8 },
    { type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [35, -25, 4] }], radius: 8 },
    { type: "fillet", edges: [
        { kind: "edge", by: "nearest", point: [-35, 0, 58] },
        { kind: "edge", by: "nearest", point: [-27, 0, 58] },
      ], radius: 3 },
  ];
}

// ------------------------------------------------------------------ knob ---
// A knurled control knob: a revolved profile with a waisted grip, a knurl on
// the outside and a D-shaft bore.
function knob() {
  return [
    {
      type: "sketch",
      plane: P([0, 0, 0], [0, -1, 0], [1, 0, 0]),
      entities: [
        { type: "line", x1: 0, y1: 0, x2: 17, y2: 0 },
        { type: "line", x1: 17, y1: 0, x2: 17, y2: 14 },
        { type: "line", x1: 17, y1: 14, x2: 11, y2: 18 },
        { type: "line", x1: 11, y1: 18, x2: 0, y2: 18 },
        { type: "line", x1: 0, y1: 18, x2: 0, y2: 0 },
      ],
    },
    { type: "revolve", sketch: 0, axis: "Z", angle: 360, operation: "new" },
    // the shaft bore
    { type: "sketch", plane: "XY", entities: [{ type: "circle", radius: 3.1, x: 0, y: 0 }] },
    { type: "extrude", sketch: 2, distance: 14, operation: "cut" },
    // aimed at the far side of each rim: the revolve's seam line meets the rim
    // circle at angle 0, and a point there is equally near both.
    { type: "fillet", edges: [
        { kind: "edge", by: "nearest", point: [-17, 0, 14] },
        { kind: "edge", by: "nearest", point: [-11, 0, 18] },
      ], radius: 1.5 },
    // an M3 set screw into the bore, from the side
    {
      type: "sketch",
      plane: P([0, -17, 0], [0, 1, 0], [1, 0, 0]),
      entities: [{ type: "circle", radius: 1.6, x: 0, y: -6 }],
    },
    { type: "extrude", sketch: 5, distance: 20, operation: "cut" },
    // and the grip, which is the whole reason a knob is not a cylinder
    {
      type: "texture",
      kind: "knurl",
      faces: [{ kind: "face", by: "nearest", point: [17, 0, 7] }],
      depth: 0.7,
      scale: 3.2,
    },
  ];
}

// --------------------------------------------------------------- housing ---
// A sensor housing: a rounded shell with a lid lip, four screw bosses and a
// vent grille, which is the case a shell and a pattern are actually for.
function housing() {
  const feats = [
    { type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 76, height: 52, x: 0, y: 0 }] },
    { type: "extrude", sketch: 0, distance: 26, operation: "new" },
  ];
  // round the four uprights before hollowing, so the wall follows them
  for (const [x, y] of [[38, 26], [38, -26], [-38, 26], [-38, -26]]) {
    feats.push({ type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [x, y, 13] }], radius: 6 });
  }
  feats.push({
    type: "shell",
    thickness: 2.4,
    faces: [{ kind: "face", by: "nearest", point: [0, 0, 26] }],
  });

  // screw bosses, pushed into the corners so they merge with the wall
  const BOSS = [[32.5, 20.5], [32.5, -20.5], [-32.5, 20.5], [-32.5, -20.5]];
  feats.push({
    type: "sketch",
    plane: "XY",
    entities: BOSS.map(([x, y]) => ({ type: "circle", radius: 4.5, x, y })),
  });
  feats.push({ type: "extrude", sketch: feats.length - 1, distance: 20, operation: "join" });

  // their pilot holes, cut DOWNWARDS from the boss tops so they stay blind at
  // the floor: a hole open at the bottom is a hole in the case
  feats.push({
    type: "sketch",
    plane: P([0, 0, 20], [0, 0, -1], [1, 0, 0]),
    entities: BOSS.map(([x, y]) => ({ type: "circle", radius: 1.5, x, y: -y })),
  });
  feats.push({ type: "extrude", sketch: feats.length - 1, distance: 15, operation: "cut" });

  // a vent grille in the front wall
  const slots = [];
  for (let i = -2; i <= 2; i++) {
    slots.push({ type: "slot", x1: i * 7, y1: -9, x2: i * 7, y2: -19, width: 3 });
  }
  feats.push({ type: "sketch", plane: P([0, -26, 0], [0, 1, 0], [1, 0, 0]), entities: slots });
  feats.push({ type: "extrude", sketch: feats.length - 1, distance: 5, operation: "cut" });

  return feats;
}

// ----------------------------------------------------------------- scene ---
// All three, laid out on the build plate. Each part is moved clear the moment
// it is finished, so the `nearest` selectors of the NEXT one can only find
// their own body.
function scene() {
  const out = [];
  const take = (feats, dx, dy) => {
    const base = out.length;
    const after = [];
    for (const f of feats) {
      const g = { ...f };
      for (const k of ["sketch", "profile", "path"]) {
        if (typeof g[k] === "number") g[k] = g[k] + base;
      }
      // A texture's faces are resolved TWICE: once at its place in the
      // timeline, and again when the body is tessellated. A move between the
      // two would make one of them wrong whichever coordinates the selector
      // named, so the texture goes AFTER the move and names where the face
      // ends up. Everything else resolves once, in its own order.
      if (g.type === "texture") {
        after.push({
          ...g,
          faces: g.faces.map((sel) => ({
            ...sel,
            point: [sel.point[0] + dx, sel.point[1] + dy, sel.point[2]],
          })),
        });
        continue;
      }
      out.push(g);
    }
    out.push({ type: "move", dx, dy, dz: 0, rx: 0, ry: 0, rz: 0 });
    out.push(...after);
  };
  take(bracket(), -96, -72);
  take(knob(), 78, 62);
  take(housing(), 0, 0);
  return out;
}


// The README's screenshots, taken of a real document in a real browser.
//
//   node shots.cjs [outDir]
//
// Needs the sidecar on 8765 (token `probetoken`) and vite on 5173.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const OUT = path.resolve(process.argv[2] || path.join(__dirname, "..", "assets", "readme"));
const EXE = process.env.SC_CHROME
  || "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
const TOKEN = process.env.SC_TOKEN || "probetoken";
const URL = `http://localhost:5173/?token=${TOKEN}`;

const NAMES = ["Bracket", "Knob", "Housing"];
const ZOOM = Number(process.env.ZOOM || 1);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  const shot = async (name) => {
    // Close whatever feature panel the last commit left open, and park the
    // cursor off the model: a hover highlight left under it reads as a
    // selection nobody made.
    await page.evaluate(() => window.__fundacad.selectFeature(null));
    await page.mouse.move(1540, 880);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("  " + name + ".png");
  };
  const at = (p) => page.evaluate((q) => window.viewport.projectToScreen(q), { x: p[0], y: p[1], z: p[2] });
  // Empty sky, well clear of every part: the way to drop a selection without
  // pressing Escape, which the timeline also listens to.
  const clearSelection = async () => {
    await page.mouse.click(1450, 250);
    // A body picked in the BROWSER is not dropped by a click in the sky, and it
    // stays lit right through the next tool.
    await page.evaluate(() => {
      window.viewport.setSelectedBodies([]);
      window.viewport.clearSelection();
    });
    await page.waitForTimeout(400);
  };

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("sindri.welcomeOnStartup", "false"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.geometry, null, { timeout: 60000 });
  await page.waitForTimeout(1200);

  // ---- build the three parts -----------------------------------------------
  const res = await page.evaluate(async (args) => {
    const { feats, names } = args;
    const store = window.store;
    const ids = [];
    for (const f of feats) {
      const id = store.nextId();
      ids.push(id);
      const out = { ...f, id };
      for (const k of ["sketch", "profile", "path"]) {
        if (typeof out[k] === "number") out[k] = ids[out[k]];
      }
      store.addFeature(out);
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        if (!store.buildState.building && store.buildState.result) break;
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    const bodies = store.buildState.result?.bodies ?? [];
    bodies.forEach((b, i) => { if (names[i]) store.setBodyName(b.id, names[i]); });
    return { error: store.buildState.errorMessage ?? null, bodies: bodies.map((b) => b.id) };
  }, { feats: scene(), names: NAMES });
  console.log("built:", JSON.stringify(res));
  if (res.error) { console.error("BUILD FAILED:", res.error); process.exit(1); }

  const frame = async () => {
    await page.evaluate(() => window.viewport.setStandardView("iso"));
    await page.waitForTimeout(700);
    await page.evaluate(() => window.viewport.fitView());
    await page.waitForTimeout(1600);
    // fitView frames the bounding SPHERE, which a scene laid out flat on the
    // plate overshoots badly. Close the gap the way a user does.
    const canvas = await page.locator("#canvas").boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    for (let i = 0; i < ZOOM; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(150); }
    await page.waitForTimeout(900);
  };
  await frame();

  await shot("ui-overview");

  // ---- a sketch opened on the housing floor --------------------------------
  // Off-centre on purpose: the origin triad is drawn at (0,0,0), which is
  // exactly where this floor's middle is, and it takes the click.
  let gotFace = false;
  for (const p of [[-16, -9, 2.4], [-20, 6, 2.4], [8, -12, 2.4], [16, 8, 2.4]]) {
    const floor = await at(p);
    await page.mouse.click(floor.x, floor.y);
    await page.waitForTimeout(400);
    gotFace = await page.evaluate(() => !!window.viewport.selectedFaceSketchPlane());
    console.log("  floor try", JSON.stringify(p), "at", Math.round(floor.x), Math.round(floor.y), "->", gotFace);
    if (gotFace) break;
  }
  if (!gotFace) { console.error("the floor pick missed"); process.exit(1); }
  await page.keyboard.press("s");
  await page.waitForTimeout(1600);
  // Entering a sketch squares the camera to its plane. Turn back to the
  // isometric: the point of the face overlay is that the model is still there
  // around it, in three dimensions, which a straight-on view cannot show.
  await page.evaluate(() => window.viewport.setStandardView("iso"));
  await page.waitForTimeout(1400);
  await shot("sketch-on-face");
  await page.evaluate(() => window.__fundacad.handleAction("finish"));
  await page.waitForTimeout(1500);
  await clearSelection();
  await frame();

  // ---- the transform gizmo -------------------------------------------------
  // Selected through the browser: Move works on BODIES, and a click in the
  // viewport under the default Faces filter gives it a face, which it cannot
  // use — it falls back to the last body built and the gizmo appears somewhere
  // nobody pointed at.
  // The Housing rather than the Knob: the gizmo's handles are a FIXED number of
  // pixels across, so it only reads at a distance where the part fills a
  // sensible part of the frame — and its value fields open to the right, which
  // runs off the edge on anything near it.
  await page.getByText("Housing", { exact: true }).click();
  await page.waitForTimeout(400);
  await page.keyboard.press("m");
  await page.waitForTimeout(1000);
  await shot("transform-gizmo");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await clearSelection();
  await frame();

  // ---- a crossing box over the housing, seeing through it ------------------
  await page.keyboard.press("x");
  await page.waitForTimeout(400);
  const a = await at([56, 44, 62]);
  const b = await at([-56, -44, -6]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 8 });
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "area-select.png") });
  console.log("  area-select.png");
  await page.mouse.up();
  await page.waitForTimeout(600);

  console.log("errors:", errors.slice(0, 10));
  await browser.close();
})();
