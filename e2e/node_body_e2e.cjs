// The node body tool in a real browser: place nodes, link them into a limb,
// move one with the gizmo, pull a linked node out with Alt-drag, add the body,
// bind a radius to a parameter, change the parameter, and cut the body with a
// box. Screenshots of every step land in the out directory.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/]
//   [SC_WS_PORT=<engine port when not 8765>] node e2e/node_body_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const WS_PORT = process.env.SC_WS_PORT || "";
const OUT = path.resolve(process.argv[2] || "node_body_shots");
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
  page.on("console", (m) => { if (m.type() === "error" && !/403/.test(m.text())) console.error("console:", m.text()); });
  page.on("response", (r) => { if (r.status() === 403) console.error("403:", r.url()); });
  if (WS_PORT) {
    await page.addInitScript((port) => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url, protocols) {
          super(String(url).replace(":8765", `:${port}`), protocols);
        }
      };
    }, WS_PORT);
  }
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const idle = async () => {
    await page.waitForTimeout(250);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 90000 });
  };
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });
  const nodeFeature = () => page.evaluate(() => {
    const f = window.store.document.features.find((x) => x.type === "organic");
    return f ? JSON.parse(JSON.stringify(f)) : null;
  });
  const bodies = () => page.evaluate(() => (window.store.buildState.result?.bodies ?? []).map((b) => ({ id: b.id, bbox: b.bbox })));
  const toScreen = (p) => page.evaluate((q) => {
    const v = window.viewport;
    const c = v.cameraTarget();
    const world = c.clone().set(q[0], q[1], q[2]);
    return v.projectToScreen(world);
  }, p);

  // A view with room: iso, framed on a 60 mm span around the origin.
  const lookAt = () => page.evaluate(() => {
    window.viewport.rig.controls.setLookAt(110, -150, 120, 36, 0, 4, false);
    window.viewport.requestRender();
  });
  await lookAt();
  await page.waitForTimeout(600);

  // 1. The tool, from its action.
  await page.evaluate(() => window.__fundacad.handleAction("nodeBody"));
  await page.waitForSelector('[data-panel="node-body"]', { timeout: 10000 });
  check("the node body panel opens", true);

  // 2. Three clicks: the first lands on the ground, the next two extend the
  // chain. Below the last node, clear of the gizmo's value
  // boxes, which sit to its right.
  const origin = await toScreen([0, 0, 0]);
  const clicks = [[0, 0], [40, 150], [170, 250]];
  for (const [dx, dy] of clicks) {
    await page.mouse.click(origin.x + dx, origin.y + dy);
    await idle();
    // The first model a session shows is framed by the app; put the view back.
    await lookAt();
    await page.waitForTimeout(300);
  }
  await idle();
  let f = null;
  const panelText = await page.$eval('[data-panel="node-body"]', (el) => el.textContent);
  check("three nodes are listed", /n1/.test(panelText) && /n2/.test(panelText) && /n3/.test(panelText), panelText.slice(0, 120));
  check("they form one chain", /n1 → n2 → n3/.test(panelText));
  await shot("01_three_nodes.png");

  // 3. Lift n2 through the panel, then drag the gizmo's Z arrow on n3.
  await page.click('[data-node="n2"]');
  await page.waitForTimeout(300);
  const z = await page.$('[data-field="z"]');
  await z.click({ clickCount: 3 });
  await page.keyboard.type("12");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  await idle();
  await page.click('[data-node="n3"]');
  await page.waitForTimeout(400);
  const n3 = await page.evaluate(() => {
    const v = window.viewport;
    const inputs = [...document.querySelectorAll('[data-panel="node-body"] [data-field]')];
    const val = (k) => Number(inputs.find((i) => i.dataset.field === k)?.value);
    const c = v.cameraTarget().clone().set(val("x"), val("y"), val("z"));
    const s0 = v.projectToScreen(c);
    const px = v.pixelWorldSize(c);
    const s1 = v.projectToScreen(c.clone().set(c.x, c.y, c.z + px * 55));
    return { z: val("z"), s0, s1 };
  });
  await page.mouse.move(n3.s1.x, n3.s1.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(n3.s1.x, n3.s1.y - k * 6);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
  await idle();
  const n3After = await page.evaluate(() => {
    const i = document.querySelector('[data-panel="node-body"] [data-field="z"]');
    return Number(i?.value);
  });
  check("the gizmo's Z arrow lifts n3", n3After > n3.z + 1, `${n3.z} -> ${n3After}`);
  await shot("02_moved.png");

  // 4. Alt-drag a linked node out of n3.
  const s3 = await page.evaluate(() => {
    const v = window.viewport;
    const inputs = [...document.querySelectorAll('[data-panel="node-body"] [data-field]')];
    const val = (k) => Number(inputs.find((i) => i.dataset.field === k)?.value);
    return v.projectToScreen(v.cameraTarget().clone().set(val("x"), val("y"), val("z")));
  });
  await page.keyboard.down("Alt");
  await page.mouse.move(s3.x, s3.y);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) {
    await page.mouse.move(s3.x + k * 7, s3.y - k * 4);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(500);
  await idle();
  const text2 = await page.$eval('[data-panel="node-body"]', (el) => el.textContent);
  check("Alt-drag pulled a linked n4 out", /n1 → n2 → n3 → n4/.test(text2), text2.slice(0, 160));
  await shot("03_pulled.png");

  // 5. Add it.
  await page.click('[data-panel="node-body"] [data-action="commit"]');
  await page.waitForTimeout(500);
  await idle();
  f = await nodeFeature();
  check("the feature is in the document", !!f && f.nodes.length === 4, JSON.stringify(f?.chains));
  let b = await bodies();
  check("it built one body", b.length === 1, JSON.stringify(b));
  await lookAt();
  await page.waitForTimeout(600);
  await shot("04_added.png");

  // 6. Bind n1's X radius to a parameter, the way the properties row does.
  const err = await page.evaluate((id) => window.store.setTargetExpr(
    { kind: "feature", feature: id, field: "nodes.n1.sx" }, "blob=8", "length"), f.id);
  await page.waitForTimeout(500);
  await idle();
  const bound = await page.evaluate((id) => window.store.boundExpr({ kind: "feature", feature: id, field: "nodes.n1.sx" }), f.id);
  check("n1 Radius X is bound to blob", !err && bound?.name === "blob" && bound?.value === 8, JSON.stringify({ err, bound }));
  const bbox = () => page.evaluate(() => JSON.stringify(window.store.buildState.result?.bbox));
  const before = await bbox();
  await page.evaluate((id) => window.store.setTargetExpr(
    { kind: "feature", feature: id, field: "nodes.n1.sx" }, "16", "length"), f.id);
  await page.waitForTimeout(500);
  await idle();
  f = await nodeFeature();
  const after = await bbox();
  check("changing the parameter changes the node", Number(f.nodes[0].sx) === 16, String(f.nodes[0].sx));
  check("and the body grows", before !== after, `${before} -> ${after}`);
  await shot("05_parameter.png");

  // 7. Cut it with a box about the origin, through n1's end of the limb.
  await page.evaluate(() => {
    window.store.addFeature({ id: "cut1", type: "box", length: 16, width: 60, height: 60, operation: "cut" });
  });
  await idle();
  const errs = await page.evaluate(() => window.store.buildState.result?.errors ?? []);
  b = await bodies();
  console.log("  after cut:", JSON.stringify(errs), JSON.stringify(b));
  check("the cut builds", !errs.some((e) => e.feature_id === "cut1"), JSON.stringify(errs));
  await page.waitForTimeout(1500);
  await lookAt();
  await page.waitForTimeout(600);
  const cutBox = await page.evaluate(() => window.store.buildState.result?.bbox);
  check("the cut keeps the limb beyond the box", !!cutBox && cutBox.max[0] > 60 && cutBox.min[0] < -8, JSON.stringify(cutBox));
  await shot("06_cut.png");

  // 8. Re-open it by editing, the panel comes back on the committed nodes.
  await page.evaluate((id) => window.__fundacad.editFeature(id), f.id);
  const reopened = await page.waitForSelector('[data-panel="node-body"]', { timeout: 10000 }).then(() => true, () => false);
  check("editing the feature re-opens the node panel", reopened);
  await shot("07_edit.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
