// Does a two-tone inlay reach the SCREEN?
//
// WHY THIS EXISTS. A mesh pass can tag the faces it covers with a palette slot,
// and the palette capability turns that slot into a colour on those faces. Every
// link in that chain had a test, and the chain was still broken for as long as it
// took to notice: the sidecar wrote the slots under one key, the window read
// them under another, and the reader's "this body has no inlays" early exit is
// indistinguishable from a key that was never sent. The document was right, the
// build was right, the payload was right, and nothing was painted.
//
// The unit tests could not see it because each one built its own input and spelt
// the key the way the code under test expected. tests/geometry/wireKeys.test.ts
// now compares the two real files, which is the cheap half. This is the other
// half: it looks at the pixels.
//
// Usage (from the repo root, with vite on 5173 and the sidecar running):
//   node e2e/inlay_color_e2e.cjs
// SC_CHROME names a Chromium/Brave binary if the default is wrong.
// SC_URL must carry the sidecar token in a dev browser: ...?token=...
// SC_OUT is where the pictures land (default: the system temp directory).

const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = process.env.SC_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "inlay_"));

/** The slot the probe paints, and a colour nothing else in the app uses, so a
 *  pixel count is unambiguous rather than a judgement about shading. */
const SLOT = 2;
const INK = "#ff00ff";

/** Poll until `fn` is true, rather than sleeping a guessed number of ms. */
async function until(page, fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await page.waitForTimeout(150);
  }
}

/** How much of the picture is the inlay colour.
 *
 *  Through the app's own still render, NOT readPixels on the live canvas: the
 *  main renderer has no preserveDrawingBuffer, so its buffer is already cleared
 *  by the time an outside caller could read it and every sample comes back zero
 *  whether the model is painted or not. renderStill draws and reads in one task.
 *  That cost an hour once; it is written down here so it costs nobody another. */
async function countInk(page, tag) {
  const r = await page.evaluate(async () => {
    const url = window.viewport.renderStill(1, { edges: false });
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      // magenta: red and blue high, green low. Generous, the face is lit, shaded
      // and displaced, so no pixel is the flat swatch colour.
      if (px[i] > 90 && px[i + 2] > 90 && px[i + 1] < 80) n++;
    }
    return { n, total: c.width * c.height, url };
  });
  fs.writeFileSync(path.join(OUT, `${tag}.png`), Buffer.from(r.url.split(",")[1], "base64"));
  return r;
}

(async () => {
  const failures = [];
  const check = (label, ok) => {
    console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
    if (!ok) failures.push(label);
  };

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await until(page, () => !!window.__fundacad && !!window.viewport, "the dev globals");
  // The welcome screen is a modal over a fresh profile, and every starter in the
  // application returns silently while one is up.
  await page.keyboard.press("Escape");
  await until(page, () => window.__fundacad.toolBusy() === false, "the window to be idle");

  await page.evaluate(([slot, ink]) => {
    window.__fundacad.store.setPaletteSlot(slot, { name: "Probe", color: ink });
  }, [SLOT, INK]);

  /** A knurled cube, with or without a palette slot on the texture. */
  const build = async (withSlot) => {
    await page.evaluate(([withSlot, slot]) => {
      const s = window.__fundacad.store;
      for (const f of [...s.document.features]) s.removeFeature(f.id);
      s.addFeature({ id: "b1", type: "box", length: 30, width: 30, height: 30 });
      s.addFeature(Object.assign(
        { id: "t1", type: "texture", body: "body1", kind: "knurl", depth: 0.8, scale: 3, faces: { by: "all" } },
        withSlot ? { colorSlot: slot } : {},
      ));
    }, [withSlot, SLOT]);
    await until(page, () => (window.__fundacad.store.buildState.result?.mesh?.positions?.length ?? 0) > 400
      && window.__fundacad.store.buildState.building === false, "a built textured body");
    await page.waitForTimeout(2500);
  };

  // --- 1. the slots survive the crossing ------------------------------------
  await build(true);
  const wire = await page.evaluate(() => {
    const b = window.__fundacad.store.buildState.result.bodies[0];
    return { slots: b.faceColorSlots || null, distinct: [...new Set(b.faceColorSlots || [])] };
  });
  check("the window receives the per-face palette slots the engine sent",
    !!wire.slots && wire.slots.length === 6);
  check("and they are the slot the texture asked for", wire.distinct.join() === String(SLOT));

  // --- 2. and they are painted ----------------------------------------------
  const on = await countInk(page, "inlay-on");
  console.log(`     ${on.n} inlay pixels of ${on.total}`);
  check("the inlay is on the screen", on.n > 2000);

  // --- 3. the control, which must come back clean ---------------------------
  // The same body, the same palette, the same camera, with only the slot taken
  // off the feature. Without this, a viewport that had gone magenta for any
  // other reason would pass section 2 and prove nothing.
  await build(false);
  const off = await countInk(page, "inlay-off");
  console.log(`     ${off.n} inlay pixels of ${off.total}`);
  check("control: no slot on the texture, no inlay colour anywhere", off.n === 0);

  console.log("");
  console.log(failures.length ? `${failures.length} FAILED` : "all checks passed");
  console.log(`pictures in ${OUT}`);
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
