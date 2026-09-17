// The Fasteners plugin in a real browser, against the real sidecar.
//
// Opens the library, searches M3, selects a socket head cap screw and reads its preview and specs,
// inserts it on a selected face, makes a custom screw from it and inserts that, and drags a nut
// onto the model. Screenshots land in SC_OUT (default: the working directory).
//
// Usage (from the repo root, with vite and the sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chromium or brave> SC_APP_PORT=5199 SC_SIDECAR_PORT=8799 \
//     node e2e/fastener_library.cjs
const { chromium } = require("playwright-core");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const APP_PORT = process.env.SC_APP_PORT || "5173";
const WS_PORT = process.env.SC_SIDECAR_PORT || "8765";
const OUT = process.env.SC_OUT || ".";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const BLOCK = JSON.stringify({
  version: 9, parameters: {}, paramDefs: {},
  features: [{ id: "f1", type: "box", length: 40, width: 40, height: 10 }],
});

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(({ t, ws }) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(":8765", `:${ws}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
    try { localStorage.removeItem("fundacad.screws.library"); } catch { /* fresh profile */ }
  }, { t: TOKEN, ws: WS_PORT });

  await page.goto(`http://localhost:${APP_PORT}/`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.__fundacad, null, { timeout: 60000 });
  await page.evaluate((text) => window.store.load(text), BLOCK);
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length === 1, null, { timeout: 60000 });

  const bodies = () => page.evaluate(() => (window.store.buildState.result?.bodies ?? []).map((b) => b.name));
  const fastenerFeatures = () => page.evaluate(() => window.store.document.features
    .filter((f) => f.type === "import" && f.generatedBy?.plugin === "FundaCAD.Screws")
    .map((f) => ({ name: f.name, geom: f.geom, standard: f.generatedBy.spec.standard })));

  // --- open, search, select ---
  await page.waitForFunction(() => document.querySelector("[data-action='fasteners'], button") !== null);
  await page.evaluate(() => window.__fundacad.handleAction("fasteners"));
  await page.waitForSelector(".scr-library", { timeout: 10000 });
  check("the Fasteners action opens the library", true);
  await page.fill(".scr-search", "M3");
  await page.waitForTimeout(300);
  const sizes = await page.$$eval(".scr-row", (rows) => rows.map((r) => r.getAttribute("data-key")));
  check("searching M3 lists only M3 sizes", sizes.length > 5 && sizes.every((k) => k.split("|")[1] === "M3"), `${sizes.length} rows`);
  await page.click(".scr-row[data-key='iso4762|M3']");
  await page.waitForSelector(".scr-specs .measure-row");
  await page.waitForFunction(() => !document.querySelector(".scr-detail .scr-preview-status"), null, { timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".scr-specs .measure-k")].some((k) => k.textContent.includes("Mass")), null, { timeout: 30000 });
  const name = await page.textContent(".scr-detail .scr-name");
  check("the socket head cap screw is selected with a default length", name.trim() === "ISO 4762 M3x8", name);
  const specs = await page.$$eval(".scr-specs .measure-row", (rows) => rows.map((r) => [...r.children].map((c) => c.textContent.trim()).join(" ")));
  for (const want of ["Standard ISO 4762", "Head diameter 5.5 mm", "Head height 3 mm", "Across flats 2.5 mm", "Pitch 0.5 mm", "Tap drill 2.5 mm"]) {
    check(`the spec table says ${want}`, specs.some((s) => s.includes(want)));
  }
  const mass = specs.find((s) => s.startsWith("Mass"));
  check("a steel mass comes from the measured solid", !!mass && /\d\.\d\d g/.test(mass), mass);
  const shot = await (await page.$(".scr-detail canvas")).screenshot();
  check("the preview canvas has something drawn in it", shot.length > 4000, `${shot.length} bytes of PNG`);
  await (await page.$(".scr-library")).screenshot({ path: path.join(OUT, "fasteners_1_preview_specs.png") });

  // --- insert on the top face of the block ---
  await page.evaluate(() => {
    const v = window.__fundacad.viewport;
    const id = v.faceIdNear([5, 5, 5]);
    v.selectFaces([id]);
  });
  await page.hover(".scr-library");
  await page.mouse.move(700, 120);
  await page.hover(".scr-insert");
  const label = await page.textContent(".scr-insert");
  check("with a face selected Insert says it goes on the face", label.includes("selected face"), label.trim());
  await page.click(".scr-insert");
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length === 2, null, { timeout: 60000 });
  let feats = await fastenerFeatures();
  check("Insert adds an import feature with its geometry stored", feats.length === 1 && /^[0-9a-f]{32}$/.test(feats[0].geom), JSON.stringify(feats));
  const names = await bodies();
  check("the body is named after the item", names.includes("ISO 4762 M3x8"), names.join(", "));
  const placed = await page.evaluate(() => {
    const b = window.store.buildState.result.bodies.find((x) => x.name === "ISO 4762 M3x8");
    return b ? { faceCount: b.faceCount } : null;
  });
  check("the inserted body has faces", !!placed && placed.faceCount > 5, JSON.stringify(placed));

  await page.evaluate(() => { document.querySelector(".scr-close").click(); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "fasteners_2_scene.png") });

  // --- a custom fastener, from the selected one ---
  await page.evaluate(() => window.__fundacad.handleAction("fasteners"));
  await page.waitForSelector(".scr-make-custom");
  await page.click(".scr-make-custom");
  await page.waitForSelector(".scr-form");
  await page.fill(".scr-name", "");
  await page.waitForTimeout(200);
  const refused = await page.$$eval(".scr-problems li", (li) => li.map((x) => x.textContent));
  check("a custom fastener with no name is refused", refused.some((t) => t.includes("a name")), refused.join(" | "));
  await page.fill(".scr-name", "Long M3 cap screw");
  await page.fill(".scr-len-length", "22");
  await page.fill(".scr-len-thread-length", "30");
  await page.waitForTimeout(200);
  const impossible = await page.$$eval(".scr-problems li", (li) => li.map((x) => x.textContent));
  check("a thread longer than the shank is refused", impossible.some((t) => t.includes("thread cannot be longer")), impossible.join(" | "));
  await page.fill(".scr-len-thread-length", "18");
  await page.waitForFunction(() => !document.querySelector(".scr-problems") && !document.querySelector(".scr-form .scr-preview-status"), null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  await (await page.$(".scr-library")).screenshot({ path: path.join(OUT, "fasteners_3_custom_form.png") });
  await page.click(".scr-save");
  await page.waitForSelector(".scr-custom-row");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fundacad.screws.library")).items.map((i) => i.spec.name));
  check("the custom fastener is saved in the settings", saved.includes("Long M3 cap screw"), saved.join(", "));
  await page.click(".scr-tab-catalogue");
  await page.fill(".scr-search", "long");
  await page.waitForTimeout(300);
  const badge = await page.$$eval(".scr-row .scr-badge", (b) => b.length);
  check("it is listed with a Custom badge", badge === 1);
  await page.click(".scr-row .scr-badge");
  await page.evaluate(() => window.__fundacad.viewport.clearSelection?.());
  await page.hover(".scr-insert");
  await page.click(".scr-insert");
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length === 3, null, { timeout: 60000 });
  check("the custom fastener inserts as a body", (await bodies()).includes("Long M3 cap screw"));

  // --- drag a nut onto the block ---
  await page.fill(".scr-search", "M5 hex nut");
  await page.waitForTimeout(300);
  const nutRow = page.locator(".scr-row[data-key='iso4032|M5']");
  check("the M5 hex nut is found", (await nutRow.count()) === 1);
  const canvas = page.locator("#viewport canvas").first();
  const box = await canvas.boundingBox();
  if (box) {
    // The library covers the middle of the window, where the block is: move it down, then aim at
    // the uncovered spot of the block nearest the middle.
    await page.evaluate(() => { document.querySelector(".scr-panel").style.top = "560px"; });
    await page.waitForTimeout(300);
    const aim = await page.evaluate(() => {
      const c = document.querySelector("#viewport canvas");
      const r = c.getBoundingClientRect();
      let best = null;
      for (let y = r.top + 20; y < r.bottom - 20; y += 20) {
        for (let x = r.left + 20; x < r.right - 20; x += 20) {
          if (document.elementFromPoint(x, y) !== c) continue;
          if (window.__fundacad.viewport.hoverFaceAt(x, y) == null) continue;
          const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
          if (!best || d < best.d) best = { x: x - r.left, y: y - r.top, d };
        }
      }
      return best;
    });
    check("part of the block is uncovered to drop on", !!aim, JSON.stringify(aim));
    await page.evaluate(() => {
      const g = window.geometry;
      const real = g.generateShape.bind(g);
      g.generateShape = (name, params, opts) => { window.__lastPlacement = opts?.placement ?? null; return real(name, params, opts); };
    });
    await nutRow.dragTo(canvas, { targetPosition: { x: aim.x, y: aim.y } });
    await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length === 4, null, { timeout: 60000 }).catch(() => {});
    const placement = await page.evaluate(() => window.__lastPlacement);
    check("the drop placed it on the top face, standing up", !!placement && Math.abs(placement.origin[2] - 5) < 1e-3 && Math.abs(placement.zAxis[2] - 1) < 1e-6, JSON.stringify(placement));
    check("dropping the row on the model inserts the nut", (await bodies()).includes("ISO 4032 M5"), (await bodies()).join(", "));
  }
  await page.evaluate(() => { document.querySelector(".scr-close").click(); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "fasteners_4_scene_custom_and_nut.png") });

  // --- the saved document builds from the blobs alone ---
  const doc = await page.evaluate(() => window.store.toJSON());
  const rebuilt = await page.evaluate(async (text) => {
    const r = await window.geometry.rebuild(JSON.parse(text));
    return r.ok ? { bodies: r.result.bodies.length, errors: (r.result.errors ?? []).length } : { error: r.error };
  }, doc);
  check("the document with fasteners rebuilds from its import geometry", rebuilt.bodies >= 3 && rebuilt.errors === 0, JSON.stringify(rebuilt));
  feats = await fastenerFeatures();
  check("every fastener carries its spec", feats.length >= 3, feats.map((f) => f.name).join(", "));

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})();
