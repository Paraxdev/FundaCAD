// Versions of a document, driven through the Versions popover in a real browser.
//
//   1. Save a version, change the part, and the popover counts the change.
//   2. Save again; both versions are listed newest first, with what each changed.
//   3. Restore the first one: the history goes back, and undo returns.
//   4. Branch from the first version, save on the branch, and switching back to
//      main brings main's newest version back.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/versions_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "versions_shots");
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
  const ids = () => page.evaluate(() => window.store.document.features.map((f) => f.id));
  const openPanel = async () => {
    if (!(await page.$(".versions-pop"))) await page.locator('#viewcontrols [title="Versions"]').click();
    await page.waitForTimeout(300);
  };
  const saveVersion = async (msg) => {
    await openPanel();
    await page.fill(".versions-pop .versions-save .versions-input", msg);
    await page.click(".versions-pop .versions-save-btn");
    await page.waitForTimeout(300);
  };

  await page.evaluate(async () => {
    window.store.addFeature({ id: "b1", type: "box", length: 30, width: 20, height: 10 });
    await window.store.rebuildNow();
  });

  console.log("\n  1. save and count changes");
  await openPanel();
  check("the popover opens with nothing saved yet", (await page.textContent(".versions-pop .pop-note")).includes("No versions yet"));
  await saveVersion("Base block");
  await page.evaluate(() => window.store.addFeature({ id: "c1", type: "cylinder", radius: 4, height: 30 }));
  await page.waitForTimeout(300);
  const note = await page.textContent(".versions-pop .pop-note");
  check("one change is counted since the version", note.includes('1 change since "Base block"'), note.trim());

  console.log("\n  2. two versions");
  await saveVersion("Add a peg");
  const rows = await page.$$eval(".versions-pop .versions-msg", (els) => els.map((e) => e.textContent.trim()));
  check("listed newest first", JSON.stringify(rows) === JSON.stringify(["Add a peg", "Base block"]), JSON.stringify(rows));
  await page.click(".versions-pop .versions-row.head .versions-main");
  await page.waitForTimeout(200);
  const changes = await page.$$eval(".versions-pop .versions-changes li", (els) => els.map((e) => e.textContent.trim()));
  check("the newest version says what it added", changes.some((c) => c.startsWith("added")), JSON.stringify(changes));
  await page.screenshot({ path: path.join(OUT, "versions.png") });

  console.log("\n  3. restore");
  await page.click(".versions-pop .versions-row.head .versions-main");
  await page.locator(".versions-pop .versions-row").nth(1).locator(".versions-main").click();
  await page.locator(".versions-pop .versions-row").nth(1).getByText("Restore").click();
  await page.waitForTimeout(500);
  check("the history is back at the first version", JSON.stringify(await ids()) === JSON.stringify(["b1"]), JSON.stringify(await ids()));
  await page.evaluate(() => window.store.undo());
  await page.waitForTimeout(300);
  check("undo brings back what was there", JSON.stringify(await ids()) === JSON.stringify(["b1", "c1"]), JSON.stringify(await ids()));

  console.log("\n  4. branches");
  await openPanel();
  const first = page.locator(".versions-pop .versions-row").nth(1);
  if (!(await first.evaluate((el) => el.classList.contains("open")))) await first.locator(".versions-main").click();
  await first.getByText("Branch from here").click();
  await page.fill(".versions-pop .versions-detail .versions-input", "wide variant");
  await page.locator(".versions-pop .versions-detail").getByText("Create").click();
  await page.waitForTimeout(500);
  const onBranch = await page.evaluate(() => window.store.versionRepo.current);
  check("moved onto the new branch", onBranch === "wide-variant", onBranch);
  check("at the version it branched from", JSON.stringify(await ids()) === JSON.stringify(["b1"]), JSON.stringify(await ids()));
  await page.evaluate(() => window.store.updateFeature("b1", { width: 60 }));
  await saveVersion("Wider");
  await openPanel();
  await page.selectOption(".versions-pop .versions-branch", "main");
  await page.waitForTimeout(500);
  check("switching to main brings main's newest version back", JSON.stringify(await ids()) === JSON.stringify(["b1", "c1"]), JSON.stringify(await ids()));
  const width = await page.evaluate(() => window.store.document.features.find((f) => f.id === "b1").width);
  check("with main's own values", width === 20, String(width));

  console.log(failures ? `\n  ${failures} FAILED\n` : "\n  all passed\n");
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
