// A long import shows its stages and a moving bar in the history's busy line,
// then hands over to the rebuild's meshing bar.
//
// Through the real engine and the real store: the stages come from the engine's
// `importing` frames, so a file that imports in under a few seconds shows too
// little to check. Point IMPORT_FILE at a big STEP (an assembly of a minute or more).
//
// Usage (from the repo root, with vite and `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> IMPORT_FILE=<big.step> [SC_PORT=8765] [VITE_URL=http://localhost:5173/] \
//     node e2e/import_progress_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const PORT = process.env.SC_PORT || "8765";
const URL = process.env.VITE_URL || "http://localhost:5173/";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const FILE = process.env.IMPORT_FILE || "";
const OUT = path.resolve(process.argv[2] || "import_progress_shots");
if (!TOKEN || !FILE) {
  console.error("set SC_TOKEN and IMPORT_FILE");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.addInitScript(
    ([t, port]) => {
      const N = window.WebSocket;
      class P extends N {
        constructor(u, p) {
          let s = String(u)
            .replace(":8765", `:${port}`)
            .replace(/([?&])token=[^&]*/, `$1token=${t}`);
          if (!s.includes("token=")) s += (s.includes("?") ? "&" : "?") + "token=" + t;
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
  await page.waitForFunction(() => !!window.store && !!window.geometry, null, { timeout: 60000 });

  // io/files.ts importPath is what a picked or dropped file goes through,
  // runBusy and all, minus the native picker.
  await page.evaluate((file) => {
    window.__importDone = false;
    import("/src/io/files.ts")
      .then((m) => m.importPath(window.store, window.geometry, file))
      .finally(() => {
        window.__importDone = true;
      });
  }, FILE);

  const samples = [];
  const t0 = Date.now();
  let shots = 0;
  let lastStage = "";
  while (!(await page.evaluate(() => window.__importDone)) && Date.now() - t0 < 10 * 60 * 1000) {
    const s = await page.evaluate(() => {
      const busy = document.querySelector(".timeline-busy");
      const bar = busy?.querySelector(".busy-bar");
      return {
        text: busy?.querySelector(".busy-text")?.textContent ?? "",
        stage: busy?.querySelector(".busy-stage")?.textContent ?? "",
        width: bar?.querySelector("i")?.style.width ?? "",
        indeterminate: !!bar?.classList.contains("indeterminate"),
        building: document.querySelector(".timeline-node.building .t-build")?.textContent ?? "",
      };
    });
    samples.push({ t: (Date.now() - t0) / 1000, ...s });
    const stageName = s.stage.replace(/ \d+%$/, "");
    if (stageName && stageName !== lastStage && shots < 6) {
      await page.screenshot({
        path: path.join(OUT, `stage-${++shots}.png`),
        clip: { x: 0, y: 0, width: 1400, height: 900 },
      });
      lastStage = stageName;
    }
    await page.waitForTimeout(500);
  }
  fs.writeFileSync(path.join(OUT, "samples.json"), JSON.stringify(samples, null, 1));

  const stages = [...new Set(samples.map((s) => s.stage.replace(/ \d+%$/, "")).filter(Boolean))];
  const widths = new Set(samples.filter((s) => !s.indeterminate && s.width).map((s) => s.width));
  check("the busy line names three or more stages", stages.length >= 3, stages.join(" > "));
  check("the bar takes three or more widths", widths.size >= 3, [...widths].slice(0, 8).join(" "));
  check(
    "a stage without a fraction draws an indeterminate bar",
    samples.some((s) => s.indeterminate),
  );
  check(
    "the label stays the import's",
    samples.filter((s) => s.stage).every((s) => s.text.startsWith("Importing")),
  );

  // importPath resolves after the rebuild that meshes the new part, which the
  // building chip counts
  const meshing = samples.map((s) => s.building).filter((b) => /meshing \d+\//.test(b));
  check("the rebuild after it shows the meshing bar", meshing.length > 0, meshing.at(-1));

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
