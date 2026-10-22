// Press/pull after a session of pushes on one engine, in a real browser.
//
// The star pocket ring (crates/fundacad-geom/tests/press_pull/star_pocket_ring.json)
// is opened the way the app opens a .funda, then a side socket sends the engine the
// press/pull previews a session makes over its faces, in and out. After that the
// bottom face and the inner floor are picked with real clicks (body, then face,
// Shift adds), press/pull is started, the arrow is dragged and 2.05 typed in the
// distance box. Every push has to go through, with the volume moving the right way.
// The floor is only pulled out, its inward pull is a known separate hang.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/]
//   [SC_ENGINE_PORT=<engine port, when not 8765>] [SC_ROUNDS=2] node e2e/press_pull_session_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const ROUNDS = Number(process.env.SC_ROUNDS ?? 2);
const OUT = path.resolve(process.argv[2] || "press_pull_session_shots");
const ROOT = path.resolve(__dirname, "..");
const DOC = fs.readFileSync(path.join(ROOT, "crates/fundacad-geom/tests/press_pull/star_pocket_ring.json"), "utf8");
const FACE_LIST = JSON.parse(fs.readFileSync(path.join(__dirname, "press_pull_session_faces.json"), "utf8"));
const FLOOR_INDEX = 61;
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

// The floor ring at z 0.317 faces up and is seen from above, the bottom at z 0 from below.
const FACES = {
  floor: { eye: [10, -40, 90], target: [0, 17.5, 0.317], pts: [] },
  bottom: { eye: [10, -40, -90], target: [0, 20, 0], pts: [] },
};
for (let a = 0; a < 360; a += 15) {
  const r = (a * Math.PI) / 180;
  for (const rad of [17.5, 16.5, 18, 15.5]) FACES.floor.pts.push([rad * Math.cos(r), rad * Math.sin(r), 0.317]);
  for (const rad of [18, 19, 20, 21]) FACES.bottom.pts.push([rad * Math.cos(r), rad * Math.sin(r), 0]);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  if (PORT !== "8765") {
    await page.addInitScript((port) => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(u, p) {
          super(String(u).replace(":8765", `:${port}`), p);
        }
      };
    }, PORT);
  }
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, {
    timeout: 90000,
  });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(300);
  }
  const settle = async () => {
    await page.waitForTimeout(600);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 180000 });
    await page.waitForTimeout(500);
  };
  const volume = () => page.evaluate(() => window.viewport.bodyProperties(null)?.volume ?? null);
  const tool = () =>
    page.evaluate(() => {
      const t = window.pressPull;
      return {
        active: t.active,
        value: t.value,
        faces: t.faces,
        refusal: t.outcomes?.refusal ?? null,
        previewError: window.store.previewError ?? null,
      };
    });

  await page.evaluate((text) => window.store.load(text), DOC);
  await settle();
  const v0 = await volume();
  check(
    "the ring opens with one body",
    (await page.evaluate(() => window.store.buildState.result?.bodies?.length)) === 1 && v0 > 0,
    { v0 },
  );

  const base = JSON.parse(DOC);
  const reqs = [];
  for (let round = 0; round < ROUNDS; round++)
    FACE_LIST.forEach(([index, kind, point], j) => {
      let d = [0.5, 2.05, 1.2][(j + round) % 3];
      if (kind === "P" && index !== FLOOR_INDEX && (j + round) % 2 === 1) d = -d;
      reqs.push({
        ...base,
        features: [
          ...base.features,
          {
            id: "f8",
            type: "press-pull",
            face: { kind: "face", by: "nearest", point },
            distance: d,
            operation: d > 0 ? "join" : "cut",
            body: "body1",
          },
        ],
      });
    });
  const session = await page.evaluate(
    async ([port, token, reqs]) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
      await new Promise((r) => (ws.onopen = r));
      for (let i = 0; i < reqs.length; i++) {
        const id = `session-${i}`;
        const done = new Promise((r) => {
          ws.onmessage = (m) => {
            if (typeof m.data !== "string") return;
            const v = JSON.parse(m.data);
            if (v.id === id && "ok" in v) r(v);
          };
        });
        ws.send(JSON.stringify({ id, op: "rebuild", tolerance: 0.1, document: reqs[i] }));
        await done;
      }
      ws.close();
      return reqs.length;
    },
    [PORT, TOKEN, reqs],
  );
  console.log(`  sent ${session} press/pull previews on a side socket`);

  const select = async (name, additive) => {
    const f = FACES[name];
    await page.evaluate((e) => {
      const v = window.viewport;
      const V = v.camera.position.constructor;
      v.rig.setLookAt(new V(...e), new V(0, 0, 0));
      v.requestRender();
    }, f.eye);
    await page.waitForTimeout(500);
    const s = await page.evaluate(
      ([pts, t]) => {
        const v = window.viewport;
        const V = v.camera.position.constructor;
        const want = v.faceIdNear(t);
        for (const p of pts) {
          const at = v.projectToScreen(new V(...p));
          const hit = v.pickEntity(at.x, at.y);
          if (hit?.kind === "face" && hit.faceId === want) return { x: at.x, y: at.y, faceId: want };
        }
        return null;
      },
      [f.pts, f.target],
    );
    if (!s) return null;
    if (additive) await page.keyboard.down("Shift");
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(400);
    if (!(await page.evaluate(() => window.viewport.highlighter.getSelectedFaces())).includes(s.faceId)) {
      await page.mouse.click(s.x, s.y);
      await page.waitForTimeout(400);
    }
    if (additive) await page.keyboard.up("Shift");
    return s.faceId;
  };

  const drag = async (until) => {
    const grip = await page.evaluate(() => {
      const t = window.pressPull;
      const v = window.viewport;
      const at = t.anchor.clone().addScaledVector(t.axis, t.value);
      const k = v.pixelWorldSize(at);
      const s = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 25 * (t.value < 0 ? -1 : 1)));
      const ahead = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 60));
      const s0 = v.projectToScreen(at);
      return { x: s.x, y: s.y, dx: ahead.x - s0.x, dy: ahead.y - s0.y };
    });
    const len = Math.hypot(grip.dx, grip.dy) || 1;
    const sign = until > (await page.evaluate(() => window.pressPull.value)) ? 1 : -1;
    let [x, y] = [grip.x, grip.y];
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 0; i < 400; i++) {
      x += (grip.dx / len) * 1.5 * sign;
      y += (grip.dy / len) * 1.5 * sign;
      await page.mouse.move(x, y);
      await page.waitForTimeout(40);
      const v = await page.evaluate(() => window.pressPull.value);
      if (sign > 0 ? v >= until : v <= until) break;
    }
    await page.waitForTimeout(800);
    await page.mouse.up();
    await settle();
  };

  const type = async (text) => {
    const input = await page.evaluateHandle(() =>
      [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none")?.querySelector("input"),
    );
    if (!input.asElement()) return false;
    await input.asElement().click({ clickCount: 3 });
    await page.keyboard.type(text);
    await settle();
    await page.waitForTimeout(1500);
    await settle();
    return true;
  };

  const runs = [
    { name: "bottom out", faces: ["bottom"], drag: 1, typed: 2.05 },
    { name: "bottom in", faces: ["bottom"], typed: -0.3 },
    { name: "floor out", faces: ["floor"], drag: 1, typed: 2.05 },
    { name: "bottom and floor out", faces: ["bottom", "floor"], drag: 1, typed: 2.05 },
  ];
  for (const run of runs) {
    for (let i = 0; i < 4 && (await page.evaluate(() => window.pressPull.active)); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.viewport.clearSelection?.());
    await page.waitForTimeout(300);
    const picked = [];
    for (let i = 0; i < run.faces.length; i++) picked.push(await select(run.faces[i], i > 0));
    await page.evaluate(() => window.__fundacad.handleAction("presspull"));
    await page.waitForTimeout(500);
    const armed = await tool();
    check(
      `${run.name}: the faces are picked and press/pull is armed`,
      armed.active && !picked.includes(null) && armed.faces.length === run.faces.length,
      { picked, faces: armed.faces },
    );
    if (run.drag !== undefined) await drag(run.drag);
    const typed = await type(String(run.typed));
    const t = await tool();
    const v = await volume();
    await page.screenshot({ path: path.join(OUT, `${run.name.replace(/ /g, "_")}.png`) });
    check(`${run.name}: ${run.typed} is not refused`, typed && !t.refusal && !t.previewError, {
      refusal: t.refusal,
      previewError: t.previewError,
      value: t.value,
    });
    check(`${run.name}: the volume moves the right way`, v !== null && (run.typed > 0 ? v > v0 : v < v0), { v0, v });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await settle();
  }

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
