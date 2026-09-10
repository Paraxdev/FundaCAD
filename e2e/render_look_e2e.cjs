// How the viewport looks, and the two things that decide it.
//
// Read back off the live renderer and the live materials, not off a pixel diff:
// a screenshot comparison of a lit solid is a test that fails when a graphics
// driver changes. What is asserted is that the settings reach the renderer at
// all, that a glowing material is actually emissive, and that the post chain
// does not quietly give up the antialiasing or the colour management the direct
// path has. The screenshots are there to be LOOKED at, which is the only way to
// judge whether it looks better.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> node e2e/render_look_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "render_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
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

  // A row of parts covering the range: a matt one, a polished metal, and one
  // that gives off light.
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      const id = window.store.nextId();
      window.store.addFeature({ id, type: "cylinder", radius: 9, height: 26 });
      window.store.addFeature({
        id: window.store.nextId(), type: "move", body: `body${i + 1}`,
        dx: (i - 1) * 26, dy: 0, dz: 0,
      });
    }
    await window.store.rebuildNow();
    window.store.setBodiesMaterial(["body1"], "m-plastic-white");
    window.store.setBodiesMaterial(["body2"], "m-steel");
    window.store.setBodiesMaterial(["body3"], "m-emitter");
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1500);

  // The CANVAS alone, and not the corner it keeps the frame-rate readout in.
  // A full-window shot changes between every pair of screenshots whatever the
  // renderer did, which would make three identical renders look like three
  // different ones and hide exactly the fault this section is for.
  const canvasBox = await page.$eval("canvas", (c) => {
    const r = c.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.round(r.width) - 130, height: Math.round(r.height) - 70,
    };
  });

  // ---- 1. a glowing material is actually emissive --------------------------
  console.log("\n1. glow");
  const mats = () => page.evaluate(() => window.viewport.bodyMeshes.map((b) => {
    const m = b.mesh.material;
    return {
      id: b.id,
      emissive: "#" + m.emissive.getHexString(),
      intensity: m.emissiveIntensity,
      metalness: m.metalness,
      roughness: m.roughness,
    };
  }));
  const lit = await mats();
  for (const m of lit) console.log(`  ${m.id}: emissive ${m.emissive} x${m.intensity}, `
    + `metalness ${m.metalness}, roughness ${m.roughness}`);
  const glowing = lit.find((m) => m.id === "body3");
  check("the lit indicator gives off light", glowing.intensity > 0, JSON.stringify(glowing));
  check("brightly enough to get past the bloom threshold",
    glowing.intensity > 1, `intensity ${glowing.intensity}`);
  check("and it glows in its OWN colour, not white",
    glowing.emissive === "#42e07a", glowing.emissive);
  check("the parts that are not lit give off nothing (control)",
    lit.filter((m) => m.id !== "body3").every((m) => m.intensity === 0),
    JSON.stringify(lit.filter((m) => m.id !== "body3").map((m) => m.intensity)));

  // ---- 2. the post chain keeps what the direct path had --------------------
  console.log("\n2. the post chain");
  const chain = await page.evaluate(() => {
    const r = window.viewport.scene?.renderer ?? window.__renderer;
    return {
      toneMapping: r.toneMapping,
      neutral: r.toneMapping === 7, // THREE.NeutralToneMapping
      exposure: r.toneMappingExposure,
      outputColorSpace: r.outputColorSpace,
    };
  });
  check("tone mapping is on, and it is the neutral one",
    chain.neutral, `toneMapping=${chain.toneMapping}, exposure=${chain.exposure}`);

  const samples = await page.evaluate(() => window.viewport.scene.post.samples);
  check("rendering through the passes keeps the multisampling",
    samples >= 4,
    `${samples} samples (a composer's default target has none, which would trade `
    + `the antialiasing for the glow)`);

  // ---- 3. the settings reach the renderer ----------------------------------
  //
  // Through the PREFERENCES DIALOG, not by importing ui/renderPrefs from here.
  // A page-side `import("/src/ui/renderPrefs.ts")` resolves to a SECOND copy of
  // that module with its own state: measured, the app's lights did not move
  // when brightness was set that way, and three supposedly different bloom
  // screenshots came back byte-identical apart from the frame-rate readout.
  // Driving the real control is both the honest test and the only one that
  // works from out here.
  console.log("\n3. the settings");
  const shot = async (name) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: canvasBox });
  };
  const setBloom = async (level) => {
    await page.keyboard.press("Control+Comma");
    await page.waitForSelector("#prefs-bloom", { timeout: 5000 });
    await page.selectOption("#prefs-bloom", level);
    await page.waitForTimeout(200);
    // The close BUTTON, not Escape: the focus is in the select that was just
    // used, which swallows it, and a dialog left standing over the viewport
    // means every screenshot below is a picture of the dialog. (It was, and
    // three of them "differed" only in which option the Bloom row was showing.)
    await page.click(".modal-close");
    await page.waitForFunction(() => document.querySelector("#prefs-bloom") === null, null, { timeout: 5000 });
    await page.waitForTimeout(600);
  };

  await shot("1-bloom-subtle");
  await setBloom("strong");
  await shot("2-bloom-strong");
  await setBloom("off");
  await shot("3-bloom-off");

  const md5 = (n) => require("crypto").createHash("md5")
    .update(fs.readFileSync(path.join(OUT, `${n}.png`))).digest("hex");
  const hashes = ["1-bloom-subtle", "2-bloom-strong", "3-bloom-off"].map(md5);
  check("each bloom level draws a different picture",
    new Set(hashes).size === 3, hashes.map((h) => h.slice(0, 8)).join(" "));

  await setBloom("subtle");
  check("the dialog closed again",
    await page.evaluate(() => document.querySelector("#prefs-bloom") === null));

  console.log(`\nshots in ${OUT}`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall render look checks passed");
  process.exit(failures ? 1 : 0);
})();
