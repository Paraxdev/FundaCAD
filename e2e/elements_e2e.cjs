// Elements, the user's own folders over the bodies, in a real browser.
//
// The component test (tests/components/shell/BrowserPane.spec.ts) covers what
// the panel emits. This covers the two things it structurally cannot:
//
//   1. LAYOUT. happy-dom implements none, so nesting as PIXELS, whether a
//      sub-element is visibly inside its parent in a 232px panel, is only
//      answerable here.
//   2. DRAG AND DROP against a real DragEvent, with a real DataTransfer, in an
//      engine that actually fires dragenter for every child span of a row.
//
// The drag is dispatched rather than mimed with the mouse: HTML5 drag and drop
// is not driven by synthesised pointer events in any browser, so Playwright's
// mouse cannot start one.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> node e2e/elements_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "elements_shots");
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
  await page.waitForFunction(() => !!window.store, null, { timeout: 60000 });

  // Four bodies, so there is something to organise.
  const built = await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) {
      window.store.addFeature({
        id: window.store.nextId(), type: "box",
        length: 10 + i * 4, width: 8, height: 6,
      });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length >= 4) {
        // Distinct names, because every box is called "Box" and this script
        // addresses rows BY LABEL. The first run of it dragged whichever body
        // happened to be painted first, twice, and reported it as a failure of
        // the feature rather than of the script.
        const names = ["Bracket", "Plate", "Motor mount", "Shaft"];
        b.result.bodies.forEach((x, i) => window.store.setBodyName(x.id, names[i]));
        return b.result.bodies.map((x) => x.id);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  });
  check("four bodies built", Array.isArray(built) && built.length === 4, String(built));
  await page.waitForTimeout(500);
  await page.locator("#browser").screenshot({ path: `${OUT}/1-flat.png` });

  // --- make two elements and file bodies into them, through the store -------
  const ids = await page.evaluate(() => {
    const rig = window.store.addElement("Rig");
    const drive = window.store.addElement("Drive", rig);
    const bodies = window.store.buildState.result.bodies.map((b) => b.id);
    window.store.setBodiesElement([bodies[0], bodies[1]], rig);
    window.store.setBodiesElement([bodies[2]], drive);
    return { rig, drive, bodies };
  });
  // Elements are OPEN by default (only imported assembly nodes start collapsed),
  // so nothing is clicked here: what the shot shows is what an element looks
  // like the moment it is made.
  await page.waitForTimeout(600);
  await page.locator("#browser").screenshot({ path: `${OUT}/2-elements.png` });

  const shown = await page.evaluate(() =>
    [...document.querySelectorAll("#browser .tree-folder, #browser .feature-row")].map((el) => {
      const l = el.querySelector(".tree-label");
      const pad = getComputedStyle(el).paddingLeft;
      return `${el.classList.contains("tree-folder") ? "[+] " : "    "}${pad.padStart(6)} ${l ? l.textContent : el.textContent.trim()}`;
    }).join("\n"));
  console.log("\n--- the panel, as painted ---\n" + shown + "\n");
  check("Rig and Drive are folder heads", /\[\+\].*Rig/.test(shown) && /\[\+\].*Drive/.test(shown));
  check("Drive is indented inside Rig",
    (() => {
      const rows = shown.split("\n");
      const rig = rows.find((r) => r.includes("Rig"));
      const drive = rows.find((r) => r.includes("Drive"));
      return rig && drive && parseFloat(drive.match(/([\d.]+)px/)[1]) > parseFloat(rig.match(/([\d.]+)px/)[1]);
    })(), "computed paddingLeft");

  // --- drag the one unfiled body onto "Rig", then back onto "Bodies" -------
  const dragTo = async (rowLabel, headLabel) =>
    page.evaluate(([rl, hl]) => {
      const rowOf = (t) => [...document.querySelectorAll("#browser .feature-row")]
        .find((el) => el.querySelector(".tree-label")?.textContent === t);
      const headOf = (t) => [...document.querySelectorAll("#browser .tree-folder")]
        .find((el) => el.querySelector(".tree-label")?.textContent === t);
      const src = rowOf(rl), dst = headOf(hl);
      if (!src || !dst) return `missing ${src ? "" : "row " + rl} ${dst ? "" : "head " + hl}`;
      const dt = new DataTransfer();
      const ev = (el, type) => el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      ev(src, "dragstart");
      ev(dst, "dragenter");
      ev(dst, "dragover");
      window.__dnd = { dst, src };
      return "held";
    }, [rowLabel, headLabel]);

  /** Finish a held drag: the ring is read AFTER a paint, it is a class Vue puts
   *  on in response to dragenter and there is nothing to see before it renders. */
  const finishDrag = async () => {
    await page.waitForTimeout(120);
    return page.evaluate(() => {
      const { dst, src } = window.__dnd;
      const ringed = dst.classList.contains("drop-into");
      const dt = new DataTransfer();
      const ev = (el, type) => el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      ev(dst, "drop");
      ev(src, "dragend");
      return { ringed };
    });
  };

  const loose = await page.evaluate((b) => ({ id: b, name: window.store.bodyName(b) }), ids.bodies[3]);

  const held = await dragTo(loose.name, "Rig");
  if (held !== "held") { console.error("  drag did not start:", held); failures++; }
  const inRig = await finishDrag();
  await page.waitForTimeout(300);
  check("dragging a body onto an element files it there",
    (await page.evaluate((b) => window.store.bodyElementOf(b), loose.id)) === ids.rig,
    JSON.stringify(inRig));
  check("the target folder lit up while the drag was over it", inRig && inRig.ringed === true);
  await page.locator("#browser").screenshot({ path: `${OUT}/3-dropped.png` });

  await dragTo(loose.name, "Bodies");
  const out = await finishDrag();
  await page.waitForTimeout(300);
  check("dragging it back onto Bodies orphans it again",
    (await page.evaluate((b) => window.store.bodyElementOf(b), loose.id)) === undefined,
    JSON.stringify(out));

  // --- and the whole thing survives a save/load round trip -----------------
  const survived = await page.evaluate(async () => {
    const json = window.store.toJSON();
    window.store.load(json);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      wrote: JSON.parse(json).elements,
      back: window.store.bodyElements,
      held: window.store.bodyElementOf(window.store.buildState.result.bodies[0].id),
    };
  });
  console.log("  saved elements:", JSON.stringify(survived.wrote));
  check("elements round-trip through save and load",
    JSON.stringify(survived.wrote) === JSON.stringify(survived.back)
      && survived.held === ids.rig, JSON.stringify(survived));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
