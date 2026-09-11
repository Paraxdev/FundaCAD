// A selected datum axis feeds Revolve, in a real browser.
//
// startSplit already lets a selected datum PLANE be the cut plane; this is the
// same idea for the datum AXIS and Revolve: with a datum axis selected, the
// "which line to spin about" step is already answered, so Revolve uses it and
// skips the interactive axis pick. A pure test cannot see this: the short
// circuit lives in an interactive picker (pickAxisInteractive) that only runs in
// front of a live viewport and a live selection.
//
// The signal: with a datum axis selected, running Revolve ADDS a revolve feature
// immediately, carrying that axis's baked origin/dir. Without one selected, it
// does not, it opens the axis pick and waits (the CONTROL).
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/revolve_datum_axis_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "revolve_datum_axis_shots");
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

  const prompt = () => page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "");
  const revolveCount = () => page.evaluate(() =>
    window.store.document.features.filter((f) => f.type === "revolve").length);
  const bodies = () => page.evaluate(() => (window.store.buildState.result?.bodies ?? []).length);

  // A profile coplanar with the spin axis and offset from it (a rectangle on XZ
  // at world X 15..25), plus a datum axis along Z. Revolving the profile about Z
  // makes a ring, a valid solid of revolution.
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s", type: "sketch", plane: "XZ", entities: [{ type: "rectangle", width: 10, height: 10, x: 20, y: 0 }] });
    window.store.addFeature({ id: "da", type: "datumAxis", origin: [0, 0, 0], dir: [0, 0, 1], name: "Spin" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => window.__fundacad.overlay.regions.length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(400);

  // --- CONTROL: nothing selected, Revolve opens the axis pick and waits -------
  await page.evaluate(() => window.__fundacad.selectFeature(null));
  const before = await revolveCount();
  await page.evaluate(() => window.__fundacad.handleAction("revolve"));
  await page.waitForTimeout(500);
  const p1 = await prompt();
  check("CONTROL: with nothing selected, Revolve adds no feature yet",
    (await revolveCount()) === before, `${await revolveCount()} revolves`);
  check("CONTROL: it opens the interactive axis pick instead",
    /axis arrow|straight edge|spin/i.test(p1), JSON.stringify(p1));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // --- select the datum axis, then Revolve uses it --------------------------
  await page.evaluate(() => window.__fundacad.selectFeature("da"));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__fundacad.handleAction("revolve"));
  await page.waitForFunction(() =>
    window.store.document.features.some((f) => f.type === "revolve"), null, { timeout: 60000 });
  await page.evaluate(async () => { await window.store.rebuildNow(); });
  await page.waitForTimeout(600);

  const rev = await page.evaluate(() =>
    window.store.document.features.find((f) => f.type === "revolve"));
  check("selecting the datum axis makes Revolve add a revolve", !!rev);
  const ax = rev && rev.axis;
  const axOk = ax && typeof ax === "object"
    && JSON.stringify(ax.origin) === JSON.stringify([0, 0, 0])
    && JSON.stringify(ax.dir) === JSON.stringify([0, 0, 1]);
  check("the revolve spins about the datum axis's own line", !!axOk, JSON.stringify(ax));
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(400);
  check("and it builds a body", (await bodies()) > 0, `${await bodies()} bodies`);
  await page.screenshot({ path: `${OUT}/revolve-about-datum-axis.png` });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
