// Face materials through a fillet, in a real browser on a real engine: the
// colours drawn on each face of two turned boxes away from the origin, before a
// fillet on an edge none of the painted faces own, after it, and after its undo.
// A fillet reorders OCCT's whole face list and gives the first body one more
// face, so a material keyed by face number lands elsewhere and the second
// body's reused mesh drew with the first body's numbering.
//
// Usage (from the repo root, with vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] SC_CHROME=<chrome> node e2e/face_materials_fillet_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "face_materials_fillet_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.addInitScript(
    ([port, t]) => {
      const N = window.WebSocket;
      class P extends N {
        constructor(u, p) {
          let s = String(u).replace("127.0.0.1:8765", "127.0.0.1:" + port);
          s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
          super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
        }
      }
      window.WebSocket = P;
    },
    [PORT, TOKEN],
  );

  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  const settled = (bodies) =>
    page.evaluate(async (n) => {
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 300));
      while (Date.now() - t0 < 90000) {
        const b = window.store.buildState;
        if (!b.building && b.result?.bodies?.length >= n && window.viewport.bodyMeshes.length >= n) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 800));
    }, bodies);

  await page.evaluate(() => {
    const s = window.store;
    s.addFeature({ id: s.nextId(), type: "box", length: 30, width: 20, height: 14 });
    s.addFeature({ id: s.nextId(), type: "move", dx: 12, dy: 7, dz: 3, rx: 0, ry: 0, rz: 20, bodies: ["body1"] });
    s.addFeature({ id: s.nextId(), type: "box", length: 16, width: 12, height: 10 });
    s.addFeature({ id: s.nextId(), type: "move", dx: -40, dy: -15, dz: 5, rx: 0, ry: 0, rz: -15, bodies: ["body2"] });
  });
  await settled(2);

  // What is on screen, per body: each face as its rounded normal, curved when
  // its triangles disagree, with the set of colours its vertices are drawn in.
  const drawn = () =>
    page.evaluate(async () => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const c = new THREE.Color();
      const out = {};
      for (const b of window.viewport.bodyMeshes) {
        const g = b.mesh.geometry,
          pos = g.getAttribute("position"),
          col = g.getAttribute("color"),
          idx = g.index;
        const faces = new Map();
        for (let t = 0; t < b.faceIds.length; t++) {
          const f = b.faceIds[t] - b.faceStart;
          const v = [0, 1, 2].map((k) => idx.getX(3 * t + k));
          const p = v.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
          const n = new THREE.Vector3().crossVectors(p[1].clone().sub(p[0]), p[2].clone().sub(p[0]));
          const e = faces.get(f) ?? { n: new THREE.Vector3(), ns: [], colors: new Set() };
          e.n.add(n);
          e.ns.push(n.clone().normalize());
          for (const i of v) e.colors.add("#" + c.fromBufferAttribute(col, i).getHexString(THREE.SRGBColorSpace));
          faces.set(f, e);
        }
        out[b.id] = [...faces].map(([f, e]) => {
          const n = e.n.normalize();
          const curved = e.ns.some((m) => m.dot(n) < 0.999);
          return {
            face: f,
            at: curved
              ? "curved"
              : n
                  .toArray()
                  .map((x) => Math.round(x * 100) / 100 + 0)
                  .join(","),
            colors: [...e.colors].sort(),
          };
        });
      }
      return out;
    });
  const byNormal = (d) =>
    Object.fromEntries(
      Object.entries(d).map(([id, fs]) => [
        id,
        Object.fromEntries(
          fs
            .filter((f) => f.at !== "curved")
            .map((f) => [f.at, f.colors.join(" ")])
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      ]),
    );

  const plain = await drawn();
  const pick = (body, at) => plain[body].find((f) => f.at === at)?.face;
  const cs = Math.round(Math.cos(Math.PI / 9) * 100) / 100,
    sn = Math.round(Math.sin(Math.PI / 9) * 100) / 100;
  const c2 = Math.round(Math.cos(Math.PI / 12) * 100) / 100,
    s2 = Math.round(Math.sin(Math.PI / 12) * 100) / 100;
  const want = {
    body1: { "0,0,1": "m-carpaint", [`${cs},${sn},0`]: "m-brass", [`${sn},${-cs},0`]: "m-copper" },
    body2: { "0,0,1": "m-plastic-black", [`${-c2},${s2},0`]: "m-ceramic" },
  };
  const drops = Object.entries(want).flatMap(([body, m]) =>
    Object.entries(m).map(([at, material]) => ({ body, face: pick(body, at), material, at })),
  );
  check(
    "every face to paint is on screen",
    drops.every((d) => d.face !== undefined),
    JSON.stringify(drops),
  );
  await page.evaluate((ds) => {
    for (const d of ds) window.store.setFacesMaterial([{ body: d.body, face: d.face }], d.material);
  }, drops);
  await page.waitForTimeout(800);
  const painted = await drawn();
  const before = byNormal(painted);
  const base = byNormal(plain);
  const changed = Object.fromEntries(
    Object.entries(before).map(([id, m]) => [
      id,
      Object.keys(m)
        .filter((k) => m[k] !== base[id][k])
        .sort(),
    ]),
  );
  check(
    "exactly the five dropped faces changed colour",
    JSON.stringify(changed) ===
      JSON.stringify({ body1: Object.keys(want.body1).sort(), body2: Object.keys(want.body2).sort() }),
    JSON.stringify(changed),
  );
  await page.locator("#viewport").screenshot({ path: `${OUT}/1-painted.png` });

  // The vertical edge where body1's -X end meets its +Y side, at mid height.
  const edge = [12 + (-15 * cs - 10 * sn), 7 + (-15 * sn + 10 * cs), 3];
  await page.evaluate((p) => {
    const s = window.store;
    s.addFeature({
      id: s.nextId(),
      type: "fillet",
      radius: 3,
      edges: [{ kind: "edge", by: "nearest", point: p, body: "body1" }],
    });
  }, edge);
  await settled(2);
  const filleted = await drawn();
  const after = byNormal(filleted);
  check(
    "the fillet gave body1 one more face",
    filleted.body1.length === painted.body1.length + 1,
    `${painted.body1.length} -> ${filleted.body1.length}`,
  );
  check(
    "every flat face of both bodies wears what it wore before the fillet",
    JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify({ before, after }),
  );
  const round = filleted.body1.filter((f) => f.at === "curved");
  const bare = base.body1["0,0,-1"];
  check(
    "the fillet face is drawn in the body's own colour",
    round.length === 1 && round[0].colors.join(" ") === bare,
    JSON.stringify({ round, bare }),
  );
  await page.locator("#viewport").screenshot({ path: `${OUT}/2-filleted.png` });

  await page.evaluate(() => window.store.undo());
  await settled(2);
  const undone = await drawn();
  check(
    "undoing the fillet puts every face back as it was",
    JSON.stringify(byNormal(undone)) === JSON.stringify(before) && undone.body1.length === painted.body1.length,
    JSON.stringify(byNormal(undone)),
  );

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
