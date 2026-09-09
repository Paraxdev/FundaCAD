// The floating selection toolbar, for a picked BODY, in a real browser.
//
// tests/ui/selectionTools.test.ts proves the OFFER is right. It cannot prove
// the bar draws it, and the two have been out of step before: the bar is a
// Teleport onto <body>, it is mounted only while something is selected, and it
// takes itself off screen whenever a tool is busy. So the questions here are
// the ones a pure test structurally cannot ask.
//
//   1. Does a picked body actually GET the new buttons, in the DOM?
//   2. Does the material button open the library itself, and does picking a row
//      reach the THREE material, not just the document?
//   3. Do Hide and Isolate write the visibility overlay, and does Hide take the
//      selection with it so the bar is not left floating over nothing?
//   4. CONTROL: does a face picked with a real click get none of them?
//   5. And the same thing from the other surface: does the body's right-click
//      menu open on a body that is already selected, and do its items run?
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/selection_toolbar_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "seltoolbar_shots");
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
  await page.addInitScript((t) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, TOKEN);

  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  // Three boxes, spread along X, so one can be hidden and the others still seen.
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      window.store.addFeature({ id: window.store.nextId(), type: "box", length: 12, width: 10, height: 8 });
      if (i) {
        window.store.addFeature({
          id: window.store.nextId(), type: "move",
          bodies: [`body${i + 1}`], dx: i * 26, dy: 0, dz: 0,
        });
      }
    }
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length >= 3, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(800);

  const ids = await page.evaluate(() => window.store.buildState.result.bodies.map((b) => b.id));
  console.log("\n  bodies:", JSON.stringify(ids), "\n");

  /** Select bodies and let the bar redraw. It looks once a frame and is woken
   *  by a pointerup, so it is nudged rather than waited on. */
  const select = async (which) => {
    await page.evaluate((w) => {
      window.viewport.setSelectionMode("bodies");
      window.viewport.setSelectedBodies(w);
      window.dispatchEvent(new Event("pointerup"));
    }, which);
    await page.waitForTimeout(400);
  };

  const barButtons = () => page.evaluate(() => ({
    tools: [...document.querySelectorAll(".seltools [data-tool]")].map((b) => b.getAttribute("data-tool")),
    looks: [...document.querySelectorAll(".seltools [data-look]")].map((b) => b.getAttribute("data-look")),
    seps: document.querySelectorAll(".seltools .seltool-sep").length,
  }));

  const menuRows = () => page.evaluate(() =>
    [...document.querySelectorAll(".context-menu .ctx-item .ctx-label")].map((n) => n.textContent.trim()));

  // --- 1. one body: the modelling verbs, the patterns now among them ---------
  await select([ids[0]]);
  let bar = await barButtons();
  console.log("  one body ->", JSON.stringify(bar), "\n");
  check("the bar is drawn for a picked body", bar.tools.length + bar.looks.length > 0);
  check("both patterns are on it, which is the gap this closed",
    bar.tools.includes("pattern-linear") && bar.tools.includes("pattern-circular"),
    JSON.stringify(bar.tools));
  check("Move is still there, and a boolean is not, on one body",
    bar.tools.includes("move") && !bar.tools.includes("boolean-union"), JSON.stringify(bar.tools));
  check("the appearance half is drawn beside them",
    JSON.stringify(bar.looks) === JSON.stringify(["material", "hide", "isolate"]),
    JSON.stringify(bar.looks));
  check("with one rule between the two halves", bar.seps === 1, String(bar.seps));

  await page.screenshot({ path: `${OUT}/bar-one-body.png` });

  // --- 2. Material opens the library, and a row applies it ------------------
  await page.click(".seltools [data-look='material']");
  await page.waitForTimeout(400);
  const rows = await menuRows();
  console.log("\n  menu rows:", JSON.stringify(rows), "\n");
  check("clicking Material opens the library itself",
    rows.length >= 10 && rows.includes("None"), `${rows.length} rows`);
  check("no modal was raised over the model",
    (await page.$(".mats-panel")) === null);
  check("the starter library is what is in it", rows.includes("Copper"), JSON.stringify(rows));

  await page.screenshot({ path: `${OUT}/material-menu.png` });

  if (rows.includes("Copper")) {
    await page.click(".context-menu .ctx-item:has(.ctx-label:text-is('Copper'))");
    await page.waitForTimeout(700);
    // Read the answer off the LIVE THREE material as well as the document: the
    // point of a material is what the renderer does with it.
    const painted = await page.evaluate((id) => {
      const m = window.store.bodyMaterialOf(id);
      const mesh = window.viewport.bodyMeshes.find((b) => b.id === id);
      const mat = mesh && mesh.mesh.material;
      return {
        name: m ? m.name : null,
        metalness: mat ? mat.metalness : null,
        roughness: mat ? mat.roughness : null,
      };
    }, ids[0]);
    console.log("  the body now wears:", JSON.stringify(painted), "\n");
    check("picking a row puts that material on the body", painted.name === "Copper", JSON.stringify(painted));
    check("and the finish reaches the renderer, not just the document",
      painted.metalness !== null && painted.metalness > 0.5, String(painted.metalness));
  }
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(700);
  await page.locator("#viewport").screenshot({ path: `${OUT}/copper-body.png` });

  // --- 3. Isolate, then Hide ------------------------------------------------
  await select([ids[0]]);
  await page.click(".seltools [data-look='isolate']");
  await page.waitForTimeout(500);
  let vis = await page.evaluate((all) => all.map((id) => window.store.isBodyVisible(id)), ids);
  console.log("  after Isolate:", JSON.stringify(vis));
  check("Isolate leaves only the picked body showing",
    vis[0] === true && vis[1] === false && vis[2] === false, JSON.stringify(vis));
  check("and keeps it selected, so the bar is still there",
    (await page.evaluate(() => window.viewport.getSelectedBodies().length)) === 1);
  await page.locator("#viewport").screenshot({ path: `${OUT}/isolated.png` });

  await page.evaluate(() => window.__fundacad.handleAction("show-all-bodies"));
  await page.waitForTimeout(500);

  await select([ids[1], ids[2]]);
  bar = await barButtons();
  check("two bodies bring the booleans in beside the patterns",
    bar.tools.includes("boolean-union") && bar.tools.includes("pattern-linear"),
    JSON.stringify(bar.tools));
  const label = await page.getAttribute(".seltools [data-look='hide']", "title");
  check("the verb says how many it is about", label === "Hide 2 bodies", String(label));

  await page.click(".seltools [data-look='hide']");
  await page.waitForTimeout(500);
  vis = await page.evaluate((all) => all.map((id) => window.store.isBodyVisible(id)), ids);
  const stillSelected = await page.evaluate(() => window.viewport.getSelectedBodies().length);
  const barsLeft = await page.evaluate(() => document.querySelectorAll(".seltools").length);
  console.log("  after Hide:", JSON.stringify(vis), "selected:", stillSelected, "bars:", barsLeft, "\n");
  check("Hide takes both bodies", vis[1] === false && vis[2] === false, JSON.stringify(vis));
  check("and lets go of them, so the bar does not float over nothing",
    stillSelected === 0 && barsLeft === 0, `${stillSelected} selected, ${barsLeft} bars`);

  await page.evaluate(() => window.__fundacad.handleAction("show-all-bodies"));
  await page.waitForTimeout(500);

  // --- 4. CONTROL: a FACE, picked with a real click, gets none of them -------
  // The line the whole split sits on. If this ever reads looks.length > 0 the
  // bar is offering to hide a face, which is not a thing that exists.
  const at = await page.evaluate((id) => {
    window.viewport.setSelectionMode("faces");
    window.viewport.setSelectedBodies([]);
    const c = window.viewport.bodiesCentroid([id]);
    const p = window.viewport.projectToScreen(c);
    return { x: p.x, y: p.y };
  }, ids[0]);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(500);
  const faces = await page.evaluate(() => window.viewport.getSelectedFaceIds().length);
  bar = await barButtons();
  console.log("  one face ->", JSON.stringify(bar), `(${faces} face selected)\n`);
  check("the click actually landed on a face", faces === 1, String(faces));
  check("a picked face is offered no appearance verbs", bar.looks.length === 0, JSON.stringify(bar.looks));
  check("CONTROL: it is still offered its own modelling tools",
    bar.tools.includes("fillet"), JSON.stringify(bar.tools));
  check("and no rule is drawn when only one half is there", bar.seps === 0, String(bar.seps));
  await page.screenshot({ path: `${OUT}/bar-one-face.png` });

  // --- 5. the same gizmo used to make the body's RIGHT-CLICK menu dead too ---
  //
  // Two failures, one cause. Opening it was gated on toolBusy, so a body you
  // had already selected had no menu at all, selecting it is what raised the
  // gizmo. And every item that acts on the body was wrapped in the same test,
  // so on a body you had NOT selected the menu opened and then refused its own
  // offers with "Finish the active tool first".
  await page.evaluate(() => {
    window.viewport.setSelectionMode("bodies");
    window.viewport.setSelectedBodies([]);
  });
  await page.waitForTimeout(300);
  const bodyAt = await page.evaluate((id) => {
    const p = window.viewport.projectToScreen(window.viewport.bodiesCentroid([id]));
    return { x: p.x, y: p.y };
  }, ids[0]);
  await select([ids[0], ids[1]]);
  await page.mouse.click(bodyAt.x, bodyAt.y, { button: "right" });
  await page.waitForTimeout(500);
  const bodyRows = await menuRows();
  console.log("  right-click on an already-selected body ->", JSON.stringify(bodyRows));
  check("a body that is already selected still has a menu",
    bodyRows.includes("Union with…") && bodyRows.includes("Material for 2 bodies"),
    bodyRows.length + " rows");
  await page.screenshot({ path: OUT + "/body-menu.png" });

  const before = await page.evaluate(() => window.store.document.features.length);
  await page.click(".context-menu .ctx-item:has(.ctx-label:text-is('Union with…'))");
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    features: window.store.document.features.length,
    last: window.store.document.features.at(-1)?.type ?? null,
    refused: document.body.innerText.includes("Finish the active tool first"),
  }));
  console.log("  after Union:", JSON.stringify(after), "(was " + before + " features)");
  check("and its items run instead of refusing themselves",
    !after.refused && after.features === before + 1 && after.last === "boolean",
    JSON.stringify(after));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
