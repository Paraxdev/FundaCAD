// Sketch Mirror as a tool with a panel, in a real browser.
//
//   0. Two lines selected before the start fill Objects and the tool waits on the mirror line.
//   1. A circle is refused as the mirror line, a construction line is taken, the preview shows
//      the copies, Enter adds exactly the reflected lines and one Ctrl+Z takes both back.
//   2. With nothing selected, Shift clicks pick several, the field icon moves to the line, Esc
//      leaves the sketch as it was.
//   3. A plain click picks one object and moves on by itself, the panel's Mirror button applies.
//
// Usage (from the repo root, with vite and an engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/sketch_mirror_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "sketch_mirror_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= tol;

const AXIS = { x1: 3.5, y1: -2, x2: 9.5, y2: 6.25 };
const ENTITIES = [
  { type: "line", id: "a", x1: 14, y1: 3, x2: 22, y2: 9.5 },
  { type: "line", id: "b", x1: 16, y1: -4, x2: 25, y2: 1.5 },
  { type: "circle", id: "c1", x: 19, y: 14, radius: 2.5 },
  { type: "line", id: "ax", ...AXIS, construction: true },
];
function reflect(x, y) {
  const dx = AXIS.x2 - AXIS.x1;
  const dy = AXIS.y2 - AXIS.y1;
  const t = ((x - AXIS.x1) * dx + (y - AXIS.y1) * dy) / (dx * dx + dy * dy);
  const fx = AXIS.x1 + t * dx;
  const fy = AXIS.y1 + t * dy;
  return [2 * fx - x, 2 * fy - y];
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
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
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.sketch && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async (entities) => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities });
    await window.store.rebuildNow();
  }, ENTITIES);
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(3000);

  const scr = (x, y) =>
    page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const clickAt = async (x, y, mods = []) => {
    const p = await scr(x, y);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.click(p.x, p.y);
    for (const m of mods) await page.keyboard.up(m);
    await page.waitForTimeout(300);
  };
  const awayFromAll = async () => {
    const p = await scr(-40, -35);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.waitForTimeout(200);
  };
  const state = () =>
    page.evaluate(() => {
      const s = window.sketch;
      const panel = document.querySelector(".mirror-panel");
      const field = (k) => {
        const row = panel && panel.querySelector(`.mirror-field[data-field="${k}"]`);
        if (!row) return null;
        return {
          value: row.querySelector(".mirror-field-v").textContent.trim(),
          active: row.classList.contains("active"),
          pressed: row.querySelector("button").getAttribute("aria-pressed"),
          clearable: !row.querySelector(".float-card-close").disabled,
        };
      };
      const apply = panel && panel.querySelector(".mirror-actions .btn-primary");
      return {
        tool: s.tool,
        ids: s.entities.map((e) => e.id),
        selected: [...s.selected].sort(),
        panel: !!panel,
        objects: field("objects"),
        line: field("line"),
        ready: !!apply && !apply.disabled,
        preview: s.overlay.previewGroup.children.length,
      };
    });
  const added = () =>
    page.evaluate(
      (old) => JSON.parse(JSON.stringify(window.sketch.entities.filter((e) => !old.includes(e.id)))),
      ENTITIES.map((e) => e.id),
    );

  // 0 and 1: preselection, a refused circle, a construction line, preview, Enter, one undo
  await page.evaluate(() => window.sketch.setTool("select"));
  await clickAt(18, 6.25);
  await clickAt(20.5, -1.25, ["Shift"]);
  let st = await state();
  check("two lines are selected before the start", st.selected.join() === "a,b", JSON.stringify(st.selected));

  await page.evaluate(() => window.sketch.setTool("mirror"));
  await page.waitForTimeout(300);
  st = await state();
  check("the panel opens", st.panel);
  check("the preselection fills Objects", !!st.objects && /\b2\b/.test(st.objects.value), JSON.stringify(st.objects));
  check(
    "the mirror line is the active field",
    !!st.line && st.line.active && st.line.pressed === "true" && !st.objects.active && st.objects.pressed === "false",
    JSON.stringify([st.objects, st.line]),
  );
  check("Mirror is disabled while the line is empty", !st.ready && st.line && !st.line.clearable);

  await clickAt(21.5, 14);
  st = await state();
  check(
    "a circle is refused as the mirror line, nothing changes",
    st.line && !st.line.clearable && st.selected.join() === "a,b" && st.line.active,
    JSON.stringify(st),
  );

  await clickAt(6.5, 2.125);
  await awayFromAll();
  st = await state();
  check("the construction line is taken", st.line && st.line.clearable && st.ready, JSON.stringify(st.line));
  check("the preview draws two copies and the line", st.preview === 3, `preview ${st.preview}`);
  check("nothing is added before Enter", st.ids.length === 4, JSON.stringify(st.ids));
  await page.screenshot({ path: path.join(OUT, "00_preview.png") });

  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  st = await state();
  const copies = await added();
  check("Enter adds two entities", st.ids.length === 6, JSON.stringify(st.ids));
  const want = [ENTITIES[0], ENTITIES[1]].map((e) => {
    const [x1, y1] = reflect(e.x1, e.y1);
    const [x2, y2] = reflect(e.x2, e.y2);
    return { x1, y1, x2, y2 };
  });
  const got = copies.map((e) => ({ type: e.type, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }));
  check(
    "the copies are the two lines reflected across the slanted axis",
    got.length === 2 &&
      got.every(
        (g, i) =>
          g.type === "line" &&
          near(g.x1, want[i].x1) &&
          near(g.y1, want[i].y1) &&
          near(g.x2, want[i].x2) &&
          near(g.y2, want[i].y2),
      ),
    JSON.stringify({ got, want }),
  );
  check(
    "the tool ends on Select with nothing selected",
    st.tool === "select" && !st.panel && st.selected.length === 0 && st.preview === 0,
    JSON.stringify({ tool: st.tool, panel: st.panel, sel: st.selected, preview: st.preview }),
  );
  await page.screenshot({ path: path.join(OUT, "01_committed.png") });

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
  st = await state();
  check("one Ctrl+Z takes both copies back", st.ids.join() === "a,b,c1,ax", JSON.stringify(st.ids));

  // 2: nothing selected, Shift picks, the field icon, Esc
  await page.evaluate(() => window.sketch.setTool("mirror"));
  await page.waitForTimeout(300);
  st = await state();
  check(
    "with nothing selected Objects is active and empty",
    st.objects && st.objects.active && !st.objects.clearable && st.selected.length === 0,
    JSON.stringify(st.objects),
  );
  await clickAt(18, 6.25, ["Shift"]);
  await clickAt(21.5, 14, ["Shift"]);
  st = await state();
  check(
    "Shift clicks pick two and stay on Objects",
    st.selected.join() === "a,c1" && st.objects.active && /\b2\b/.test(st.objects.value),
    JSON.stringify({ sel: st.selected, objects: st.objects }),
  );
  await page.click('.mirror-field[data-field="line"] button');
  await page.waitForTimeout(200);
  st = await state();
  check("the line icon makes the line field active", st.line.active && !st.objects.active, JSON.stringify(st.line));
  await clickAt(6.5, 2.125);
  st = await state();
  check("the line icon click did not reach the model", st.selected.join() === "a,c1", JSON.stringify(st.selected));
  check("the axis is taken after the icon switch", st.line.clearable && st.ready, JSON.stringify(st.line));
  await page.screenshot({ path: path.join(OUT, "02_shift_picks.png") });

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  st = await state();
  check(
    "Esc leaves nothing behind",
    st.ids.join() === "a,b,c1,ax" && !st.panel && st.preview === 0 && st.tool === "select",
    JSON.stringify(st),
  );
  check("the sketch stays open after Esc", await page.evaluate(() => window.sketch.active));

  // 3: a plain click moves on by itself, the panel button applies
  await page.evaluate(() => window.sketch.setTool("mirror"));
  await page.waitForTimeout(300);
  await clickAt(20.5, -1.25);
  st = await state();
  check(
    "a plain click picks one and moves to the line",
    st.selected.join() === "b" && st.line.active && /\b1\b/.test(st.objects.value),
    JSON.stringify({ sel: st.selected, objects: st.objects, line: st.line }),
  );
  await clickAt(6.5, 2.125);
  await page.click(".mirror-panel .mirror-actions .btn-primary");
  await page.waitForTimeout(500);
  st = await state();
  const one = await added();
  const [x1, y1] = reflect(16, -4);
  check(
    "the Mirror button adds the one copy",
    st.ids.length === 5 && one.length === 1 && near(one[0].x1, x1) && near(one[0].y1, y1) && !st.panel,
    JSON.stringify({ ids: st.ids, one }),
  );

  console.log(`\n${failures === 0 ? "all checks passed" : failures + " check(s) failed"}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})();
