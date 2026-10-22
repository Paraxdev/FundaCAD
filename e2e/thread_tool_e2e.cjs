// Threads in a real browser, against the real engine.
//
// Threads a bore with the Screws plugin's Standard Thread panel (nearest size
// and how far off it is, hand, print fit), threads a shaft with the core Thread
// tool, edits hand and starts, reopens the panel on the bore thread, and edits
// the hole diameter so the bore is threaded again at the new size.
//
// Usage (from the repo root, with vite and the engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] \
//     node e2e/thread_tool_e2e.cjs [outdir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "thread_tool_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

// A 30 mm block with a 5.1 bore through it (an M6 tap drill, 0.1 over), and a
// free 6 mm shaft beside it. Both sit clear of the origin planes.
const OFF = 100;
const DOC = {
  version: 10,
  parameters: { holeR: 2.55 },
  features: [
    { id: "b", type: "box", length: 30, width: 30, height: 10 },
    { id: "h", type: "cylinder", radius: "holeR", height: 14, operation: "cut", targets: ["body1"] },
    { id: "s", type: "cylinder", radius: 3, height: 16, operation: "new" },
    { id: "ms", type: "move", dx: 30, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, bodies: ["body2"] },
    { id: "mv", type: "move", dx: OFF, dy: OFF, dz: OFF, rx: 0, ry: 0, rz: 0, bodies: ["body1", "body2"] },
  ],
};
const at = (x, y, z) => [x + OFF, y + OFF, z + OFF];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.addInitScript(
    ([t, port]) => {
      const N = window.WebSocket;
      window.WebSocket = class extends N {
        constructor(u, p) {
          let s = String(u)
            .replace(":8765", `:${port}`)
            .replace(/([?&])token=[^&]*/, `$1token=${t}`);
          if (!s.includes("token=")) s += (s.includes("?") ? "&" : "?") + "token=" + t;
          super(s, p);
        }
      };
    },
    [TOKEN, PORT],
  );

  await page.goto(URL);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, {
    timeout: 90000,
  });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }

  await page.evaluate(async (d) => {
    window.store.load(JSON.stringify(d));
    await window.store.rebuildNow();
    window.viewport.setStandardView("iso");
    window.viewport.fitView();
  }, DOC);
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length === 2, null, {
    timeout: 120000,
  });

  const state = () =>
    page.evaluate(() => {
      const r = window.store.buildState.result;
      const vol = (id) => window.viewport.bodyProperties([id])?.volume ?? null;
      return {
        block: vol("body1"),
        shaft: vol("body2"),
        errors: (r.featureErrors || []).map((e) => `${e.feature_id}: ${e.message}`),
        threads: window.store.document.features.filter((f) => f.type === "thread"),
      };
    });
  const settle = async () => {
    await page.waitForTimeout(500);
    await page.evaluate(async () => {
      await window.store.rebuildNow();
    });
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 300000 }).catch(() => {});
  };
  const selectFace = (p) =>
    page.evaluate((pt) => {
      window.__fundacad.selectFeature(null);
      const v = window.viewport;
      const id = v.faceIdNear(pt);
      if (id != null) v.selectFaces([id]);
      return id;
    }, p);

  const base = await state();
  check(
    "the block and the shaft build",
    base.block > 0 && base.shaft > 0 && base.errors.length === 0,
    JSON.stringify(base),
  );

  // --- the bore, through the plugin panel ---
  const bore = await selectFace(at(2.55, 0, 0));
  check("the bore wall is picked", bore != null);
  await page.evaluate(() => window.__fundacad.handleAction("standardThread"));
  await page.waitForSelector("[data-testid=thread-panel]", { timeout: 15000 });
  const offBy = (await page.textContent("[data-testid=thread-offby]"))?.trim();
  check(
    "the panel opens on the nearest size and says how far off it is",
    offBy === "M6, 0.10 mm over tap drill",
    offBy,
  );
  check("a bore opens on a tap drill bore", (await page.inputValue("[data-testid=thread-faceis]")) === "tap");
  await page.selectOption("[data-testid=thread-hand]", "left");
  await page.check("[data-testid=thread-printfit]");
  const clearance = await page.inputValue("[data-testid=thread-clearance]");
  check("Print fit offers 0.2 mm by default", clearance === "0.2", clearance);
  await page.screenshot({ path: path.join(OUT, "thread_1_panel.png") });
  await page.click("[data-testid=thread-apply]");
  await settle();
  let st = await state();
  const boreThread = st.threads[0];
  check(
    "Add writes a thread feature with hand, clearance and the size in spec",
    !!boreThread &&
      boreThread.hand === "left" &&
      boreThread.clearance === 0.2 &&
      boreThread.spec?.designation === "M6" &&
      boreThread.pitch === 1,
    JSON.stringify(
      boreThread && {
        hand: boreThread.hand,
        clearance: boreThread.clearance,
        spec: boreThread.spec,
        pitch: boreThread.pitch,
      },
    ),
  );
  check(
    "the bore thread builds and removes material",
    st.errors.length === 0 && st.block < base.block - 5,
    `${base.block} -> ${st.block} ${st.errors.join("; ")}`,
  );

  // --- the shaft, with the core Thread tool ---
  await selectFace(at(33, 0, 0));
  await page.evaluate(() => window.__fundacad.handleAction("thread"));
  await page.waitForTimeout(1500);
  await page.keyboard.press("Enter");
  await settle();
  st = await state();
  const shaftThread = st.threads.find((f) => f.id !== boreThread?.id);
  check(
    "the core tool writes one thread feature at the coarse pitch",
    !!shaftThread && shaftThread.pitch === 1 && shaftThread.operation === "cut" && !shaftThread.spec,
    JSON.stringify(shaftThread && { pitch: shaftThread.pitch, op: shaftThread.operation }),
  );
  check(
    "the shaft thread builds and removes material",
    st.errors.length === 0 && st.shaft < base.shaft - 5,
    `${base.shaft} -> ${st.shaft} ${st.errors.join("; ")}`,
  );
  const rh = st.shaft;
  await page.screenshot({ path: path.join(OUT, "thread_2_both.png") });

  if (shaftThread) {
    await page.evaluate((id) => window.store.updateFeature(id, { hand: "left" }), shaftThread.id);
    await settle();
    st = await state();
    check(
      "left hand removes the same material as right",
      st.errors.length === 0 && Math.abs(st.shaft - rh) < 0.01 * rh,
      `${rh} vs ${st.shaft}`,
    );
    await page.evaluate((id) => window.store.updateFeature(id, { starts: 2 }), shaftThread.id);
    await settle();
    st = await state();
    check(
      "two starts at the same pitch still build",
      st.errors.length === 0 && st.threads.find((f) => f.id === shaftThread.id)?.starts === 2,
      st.errors.join("; "),
    );
  }

  // --- reopen the bore thread in the panel ---
  if (boreThread) {
    await page.evaluate((id) => window.__fundacad.editFeature(id), boreThread.id);
    const reopened = await page.waitForSelector("[data-testid=thread-panel]", { timeout: 15000 }).then(
      () => true,
      () => false,
    );
    check("double clicking the bore thread reopens the panel", reopened);
    if (reopened) {
      const hand = await page.inputValue("[data-testid=thread-hand]");
      const size = await page.inputValue("[data-testid=thread-size]");
      check("the panel reopens on the hand and size written", hand === "left" && size === "M6", `${hand} ${size}`);
      await page.selectOption("[data-testid=thread-starts]", "2");
      await page.click("[data-testid=thread-apply]");
      await settle();
      st = await state();
      const t = st.threads.find((f) => f.id === boreThread.id);
      check(
        "Update changes the starts in place",
        !!t && t.starts === 2 && st.threads.length === 2 && st.errors.length === 0,
        JSON.stringify(t && t.starts),
      );
    }
  }

  // --- the hole gets bigger, the thread follows ---
  const before = (await state()).block;
  await page.evaluate(async () => {
    window.store.setParam("holeR", 3.4);
    await window.store.rebuildNow();
  });
  await settle();
  st = await state();
  const plain = 30 * 30 * 10 - Math.PI * 3.4 * 3.4 * 10;
  check(
    "a 6.8 bore is threaded again, below the unthreaded block",
    st.errors.length === 0 && st.block < plain - 5 && st.block < before,
    `threaded ${st.block}, unthreaded ${plain.toFixed(1)}, before ${before} ${st.errors.join("; ")}`,
  );
  await page.screenshot({ path: path.join(OUT, "thread_3_rethreaded.png") });

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
