// Every datum tool that keeps a model reference, made with real clicks, then
// the part under it edited: the datum has to be where the engine resolves it
// now, not where it was picked.
//
// A 40 x 20 x 20 box centred on the origin, its length a parameter, so its +X
// face sits at x = len / 2. Each datum is picked on that end at len = 40 and
// read back from the rebuild at len = 80. A cylinder moved by a parameter
// covers the axis of a round face.
//
// Usage (from the repo root, with vite and `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] \
//     node e2e/datum_types_follow_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "datum_types_follow_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const close = (a, b, tol = 1e-3) =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < tol);
const fmt = (v) => JSON.stringify(v && v.map ? v.map((n) => +(+n).toFixed(3)) : v);

// A face pick draws the base planes over the model and prefers them, so the
// part is moved well clear of the origin. Clicks and wanted values below are
// given about the box centre and shifted by OFF.
const OFF = 100;
const PLUS_X = [20, -5, 3];
const TOP = [3, -5, 10];
const BOX = (len) => ({
  version: 10,
  parameters: { len },
  features: [
    { id: "b", type: "box", length: "len", width: 20, height: 20 },
    { id: "mv", type: "move", dx: OFF, dy: OFF, dz: OFF },
  ],
});
const shifted = (v) => (Array.isArray(v) ? v.map((n) => n + OFF) : v + OFF);

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

  const load = (doc) =>
    page.evaluate(async (d) => {
      window.store.load(JSON.stringify(d));
      await window.store.rebuildNow();
      window.viewport.setStandardView("iso");
      window.viewport.fitView();
      await new Promise((r) => setTimeout(r, 600));
    }, doc);
  const screen = (w) =>
    page.evaluate((p) => {
      const s = window.viewport.projectToScreen({ x: p[0], y: p[1], z: p[2] });
      return [s.x, s.y];
    }, w);
  const click = async (w) => {
    const [x, y] = await screen(shifted(w));
    await page.mouse.move(x, y);
    await page.waitForTimeout(150);
    await page.mouse.click(x, y);
    await page.waitForTimeout(450);
  };
  const clickRow = async (text) => {
    let row = page.getByText(text, { exact: true }).first();
    if (!(await row.isVisible().catch(() => false))) {
      await page.getByText("Origin", { exact: true }).first().click();
      await page.waitForTimeout(300);
      row = page.getByText(text, { exact: true }).first();
    }
    await row.click();
    await page.waitForTimeout(450);
  };
  const newest = () =>
    page.evaluate(() => {
      const f = window.store.document.features;
      return f[f.length - 1];
    });
  const rebuilt = (len, param = "len") =>
    page.evaluate(
      async ([n, v]) => {
        window.store.setParam(n, v);
        await window.store.rebuildNow();
        const r = window.store.buildState.result;
        return {
          planes: r.datumPlanes || {},
          marks: r.datumMarks || {},
          errors: r.errors || [],
          diagnostics: r.diagnostics || [],
        };
      },
      [param, len],
    );
  const act = (a) =>
    page.evaluate((x) => {
      window.__fundacad.selectFeature(null);
      window.__fundacad.handleAction(x);
    }, a);

  // Each case: the action, its clicks at len = 40, the reference it must have
  // written, and where the engine must put it at 40 and at 80.
  const cases = [
    {
      name: "midplane of the +X face and the YZ plane",
      action: "midplane",
      picks: async () => {
        await click(PLUS_X);
        await clickRow("YZ plane");
      },
      ref: (f) => f.through?.kind === "mid",
      at: (r, id) => r.planes[id]?.origin?.[0],
      // Halfway between the face at x = OFF + len / 2 and the YZ plane at 0.
      want: [(OFF + 20) / 2 - OFF, (OFF + 40) / 2 - OFF],
    },
    {
      name: "plane through a corner and two edge middles",
      action: "plane-points",
      picks: async () => {
        await click([20, -10, 10]);
        await click([20, 10, 0]);
        await click([20, -10, 0]);
      },
      ref: (f) => f.through?.kind === "points" && f.through.points.length === 3,
      at: (r, id) => r.planes[id]?.origin?.[0],
      want: [20, 40],
    },
    {
      name: "datum point on a corner",
      action: "datum-point",
      picks: async () => {
        await click([20, -10, 10]);
      },
      ref: (f) => !!f.at?.edge,
      at: (r, id) => r.marks[id]?.position,
      want: [
        [20, -10, 10],
        [40, -10, 10],
      ],
    },
    {
      name: "datum axis through two edge middles",
      action: "datum-axis",
      picks: async () => {
        await click([20, 10, 0]);
        await click([20, -10, 0]);
      },
      ref: (f) => f.through?.kind === "points",
      at: (r, id) => r.marks[id]?.origin?.[0],
      want: [20, 40],
    },
    {
      name: "plane normal to the top edge of the +X face",
      action: "plane-normal-edge",
      picks: async () => {
        await click([20, 0, 10]);
      },
      ref: (f) => f.through?.kind === "normalToEdge" && f.t === 0.5,
      at: (r, id) => r.planes[id]?.origin,
      want: [
        [20, 0, 10],
        [40, 0, 10],
      ],
    },
    {
      name: "plane through two parallel edges",
      action: "plane-two-edges",
      picks: async () => {
        await click([20, 10, 0]);
        await click([20, -10, 0]);
      },
      ref: (f) => f.through?.kind === "twoEdges",
      at: (r, id) => r.planes[id]?.origin?.[0],
      want: [20, 40],
    },
    {
      name: "plane at 45 degrees about an edge from the top face",
      action: "plane-angle",
      picks: async () => {
        await click([20, 0, 10]);
        await click(TOP);
      },
      ref: (f) => f.through?.kind === "angle" && f.angle === 45,
      at: (r, id) => r.planes[id]?.origin,
      want: [
        [20, 0, 10],
        [40, 0, 10],
      ],
      // The engine turns the same way as the plane the app drew on the click.
      agree: (f, r) => {
        const n = r.planes[f.id]?.normal;
        const c = f.plane?.normal;
        return !!n && !!c && n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0.999;
      },
    },
    {
      name: "axis where the +X face meets the top face",
      action: "axis-planes",
      picks: async () => {
        await click(PLUS_X);
        await click(TOP);
      },
      ref: (f) => f.through?.kind === "planes",
      at: (r, id) => r.marks[id]?.origin?.[0],
      want: [20, 40],
    },
  ];

  for (const c of cases) {
    console.log(c.name);
    await load(BOX(40));
    await act(c.action);
    await page.waitForTimeout(300);
    await c.picks();
    const f = await newest();
    const made = f && f.type.startsWith("datum");
    check("created by clicks", made, made ? f.type : JSON.stringify(f && f.type));
    if (!made) {
      await page.keyboard.press("Escape");
      continue;
    }
    check("keeps its model reference", c.ref(f), JSON.stringify(f.through || f.at || null).slice(0, 200));
    const before = await rebuilt(40);
    const after = await rebuilt(80);
    const [w40, w80] = c.want.map(shifted);
    const ok = (got, want) => (Array.isArray(want) ? close(got, want) : Math.abs(got - want) < 1e-3);
    check("sits on the reference at len 40", ok(c.at(before, f.id), w40), fmt(c.at(before, f.id)));
    check("follows the reference to len 80", ok(c.at(after, f.id), w80), fmt(c.at(after, f.id)));
    if (c.agree)
      check(
        "turns the way the app drew it",
        c.agree(f, before),
        fmt(before.planes[f.id]?.normal) + " vs " + fmt(f.plane?.normal),
      );
    check("no errors", after.errors.length === 0, JSON.stringify(after.errors.map((e) => e.message)));
    if (process.env.SC_DEBUG)
      console.log(
        JSON.stringify({
          f,
          before: [before.planes[f.id], before.marks[f.id]],
          after: [after.planes[f.id], after.marks[f.id]],
          diag: after.diagnostics.filter((d) => d.feature_id === f.id),
        }),
      );
    await page.screenshot({ path: `${OUT}/${c.action}.png` });
  }

  console.log("axis of a round face, the cylinder moved");
  await load({
    version: 10,
    parameters: { dx: OFF },
    features: [
      { id: "c", type: "cylinder", radius: 10, height: 30 },
      { id: "mv", type: "move", dx: "dx", dy: OFF, dz: OFF },
    ],
  });
  await act("axis-cylinder");
  await page.waitForTimeout(300);
  await click([Math.SQRT1_2 * 10, -Math.SQRT1_2 * 10, 0]);
  const ax = await newest();
  const madeAx = ax && ax.type === "datumAxis";
  check("created by a click", madeAx, JSON.stringify(ax && ax.type));
  if (madeAx) {
    check("keeps its round face", ax.through?.kind === "cylinder", JSON.stringify(ax.through || null).slice(0, 200));
    const r0 = await rebuilt(OFF, "dx");
    const r1 = await rebuilt(OFF + 15, "dx");
    check(
      "on the axis before the move",
      Math.abs(r0.marks[ax.id]?.origin?.[0] - OFF) < 1e-3,
      fmt(r0.marks[ax.id]?.origin),
    );
    check(
      "follows the move",
      Math.abs(r1.marks[ax.id]?.origin?.[0] - OFF - 15) < 1e-3 && close(r1.marks[ax.id]?.dir?.map(Math.abs), [0, 0, 1]),
      fmt(r1.marks[ax.id]?.origin),
    );
    await page.screenshot({ path: `${OUT}/axis-cylinder.png` });
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
