// The Navigation plugin in the real app: switch a button preset and drag, read
// the ? sheet, open the radial menu with a drag and with its key.
//
// Usage (from the repo root, with vite and an engine running):
//   SC_TOKEN=<engine token> node e2e/navigation_plugin_e2e.cjs [outDir]
// SC_URL (default http://localhost:5173/) and SC_ENGINE_PORT (default 8765)
// point it at a vite and an engine of your own; SC_CHROME names the browser.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = process.argv[2] || path.join(process.cwd(), "e2e-out", "navigation");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  // Only the engine socket: rewrite its port and token, leave vite's HMR alone.
  await page.addInitScript(
    ([t, port]) => {
      const N = window.WebSocket;
      class P extends N {
        constructor(u, p) {
          let s = String(u);
          if (s.startsWith("ws://127.0.0.1:8765")) {
            s = s.replace("127.0.0.1:8765", `127.0.0.1:${port}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
            if (!s.includes("token=")) s += (s.includes("?") ? "&" : "?") + "token=" + t;
          }
          super(s, p);
        }
      }
      window.WebSocket = P;
    },
    [TOKEN, PORT],
  );

  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: window.store.nextId(), type: "box", length: 20, width: 20, height: 20 });
    await window.store.rebuildNow();
    window.__fundacad.handleAction("fit");
  });
  await page.waitForTimeout(1200);

  const box = await page.$eval("canvas", (c) => {
    const r = c.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  const camera = () =>
    page.evaluate(() => {
      const c = window.viewport.rig.active;
      return [...c.position.toArray(), ...c.quaternion.toArray()].map((v) => Math.round(v * 1000) / 1000).join(",");
    });
  const table = () =>
    page.evaluate(async () => (await import("/src/viewport/navigator/bindings.ts")).pointerBindings());
  const settle = () => page.waitForTimeout(700);
  const drag = async (button, dx, dy) => {
    await page.mouse.move(box.cx, box.cy);
    await page.mouse.down({ button });
    await page.mouse.move(box.cx + dx, box.cy + dy, { steps: 10 });
    await page.mouse.up({ button });
    await settle();
  };
  const config = (patch) =>
    page.evaluate(async (p) => {
      (await import("/plugins/FundaCAD.Navigation/state.ts")).updateConfig(p);
    }, patch);

  // --- on, default preset: nothing changes ---------------------------------------
  const before = await table();
  await page.evaluate(async () => {
    (await import("/src/plugins/registry.ts")).setPluginEnabled("FundaCAD.Navigation", true);
  });
  await page.waitForTimeout(1200);
  await config({ preset: "right", radial: false, keys: [] });
  check("turning the plugin on keeps the default buttons", JSON.stringify(await table()) === JSON.stringify(before));

  // --- Middle orbits, Shift+middle pans --------------------------------------------
  await config({ preset: "middle-shift" });
  const t = await table();
  check(
    "the preset reaches the core table",
    t.some((b) => b.button === "middle" && b.drag === "orbit" && !b.shift),
  );
  let c0 = await camera();
  await drag("right", 160, 0);
  check("a right drag leaves the camera alone", (await camera()) === c0);
  c0 = await camera();
  await drag("middle", 160, 40);
  const c1 = await camera();
  check("a middle drag orbits", c1 !== c0, `${c0} -> ${c1}`);

  await page.evaluate(() => window.__fundacad.handleAction("shortcut-help"));
  await page.waitForTimeout(300);
  const mouseRows = await page.$$eval(".sc-row", (rows) => rows.map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  check(
    "the ? sheet shows the preset",
    mouseRows.some((r) => r.startsWith("Middle drag") && r.includes("Orbit")),
    mouseRows.filter((r) => /drag|click/.test(r)).join(" | "),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  if (await page.$(".shortcuts-panel")) await page.evaluate(() => window.__fundacad.handleAction("shortcut-help"));

  // --- Alt+left orbits, plain left still selects -----------------------------------
  await config({ preset: "alt-left" });
  c0 = await camera();
  await page.keyboard.down("Alt");
  await drag("left", 160, 30);
  await page.keyboard.up("Alt");
  check("an Alt+left drag orbits", (await camera()) !== c0);
  await page.mouse.click(box.cx, box.cy);
  await settle();
  const picked = await page.evaluate(
    () => window.viewport.getSelectedBodies().length + window.viewport.getSelectedFaceIds().length,
  );
  check("a plain left click still selects", picked > 0, `selected ${picked}`);
  await page.keyboard.press("Escape");
  await settle();

  // A body selection raises the Move gizmo, so the app reads as busy here.
  await page.evaluate(() => window.viewport.setSelectionMode("bodies"));
  await page.evaluate(([x, y]) => window.viewport.selectBodyAt(x, y, false), [box.cx, box.cy]);
  await settle();
  const busy = await page.evaluate(() => window.__fundacad.toolBusy());
  c0 = await camera();
  await page.keyboard.down("Alt");
  await drag("left", 160, 30);
  await page.keyboard.up("Alt");
  check("Alt+left orbits with a body selected", (await camera()) !== c0, `toolBusy ${busy}`);
  const kept = await page.evaluate(() => window.viewport.getSelectedBodies().length);
  check("and keeps the selection", kept === 1, `selected ${kept}`);
  await page.keyboard.press("Escape");
  await settle();

  await page.evaluate(() => window.viewport.setSelectionMode("faces"));
  await page.mouse.click(box.cx, box.cy);
  await settle();
  await page.evaluate(() => window.__fundacad.handleAction("sketch"));
  await page.waitForTimeout(2000);
  const inSketch = await page.evaluate(() => !!window.sketch.active);
  check("a sketch opened", inSketch);
  c0 = await camera();
  await page.keyboard.down("Alt");
  await drag("left", 160, 30);
  await page.keyboard.up("Alt");
  check("Alt+left orbits inside a sketch", (await camera()) !== c0);

  // A sketch opens on Rectangle, which offers no menu; Select does.
  await config({ preset: "middle-shift" });
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.mouse.click(box.cx + 40, box.cy + 40, { button: "right" });
  await page.waitForTimeout(400);
  check("a right click opens the sketch menu in a middle orbit preset", !!(await page.$(".ctx-item")));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.evaluate(() => window.sketch.cancel());
  await settle();

  // --- the radial menu ---------------------------------------------------------------
  const ITEMS = ["shortcut-help", "fit", "measure", "toggle-wireframe", "reset-camera", "sketch"];
  await config({ radial: true, radialDrag: "right", items: { model: ITEMS, selection: ITEMS, sketch: ITEMS } });
  await page.mouse.move(box.cx, box.cy);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.cx, box.cy - 20, { steps: 4 });
  await page.waitForTimeout(150);
  const ring = await page.$$eval("[data-radial-menu] .radial-item", (els) => els.map((e) => e.textContent.trim()));
  check("a right drag opens the ring with the chosen items", ring.length === ITEMS.length, ring.join(" | "));
  await page.screenshot({ path: path.join(OUT, "radial.png") });
  await page.mouse.move(box.cx, box.cy - 90, { steps: 6 });
  await page.waitForTimeout(100);
  const hot = await page.$eval("[data-radial-menu] .radial-item.hot", (e) => e.textContent.trim()).catch(() => null);
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(400);
  check("moving up lights the top item", hot !== null && hot.includes("Shortcut"), String(hot));
  check("releasing over it runs it once", !!(await page.$(".shortcuts-panel")));
  check("the ring closes on release", !(await page.$("[data-radial-menu]")));
  check("no context menu after the radial drag", !(await page.$(".ctx-item")));
  await page.evaluate(() => window.__fundacad.handleAction("shortcut-help"));
  await page.waitForTimeout(300);

  await page.mouse.move(box.cx + 100, box.cy);
  await page.keyboard.down("w");
  await page.waitForTimeout(150);
  await page.keyboard.up("w");
  await page.waitForTimeout(150);
  check("tapping W opens the ring and leaves it up", !!(await page.$("[data-radial-menu]")));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape closes it", !(await page.$("[data-radial-menu]")));

  await page.evaluate(async () => {
    (await import("/src/plugins/registry.ts")).setPluginEnabled("FundaCAD.Navigation", false);
  });
  await page.waitForTimeout(1200);
  check(
    "turning the plugin off restores the default buttons",
    JSON.stringify(await table()) === JSON.stringify(before),
  );

  await browser.close();
  if (failures) {
    console.error(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nOK the Navigation plugin switches presets and opens its radial menu");
})().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
