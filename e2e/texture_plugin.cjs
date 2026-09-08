// Does the texture TOOL work, as a plugin, in a real window?
//
// The unit tests drive the tool against a viewport they wrote. This drives it
// against the real one: the real bundle, the real plugin loaded by the real
// activate.ts, a real body built by the real sidecar, a real face picked out of
// a real raycast, and the panel read back out of the DOM.
//
// WHAT IT IS FOR, and why it is not a duplicate of plugin_surfaces.cjs. That
// file checks that a capability's menu rows appear and disappear. A TOOL is a
// larger claim: the ribbon button has to dispatch, the panel has to draw, the
// ambient selection has to reach a plugin's rAF loop, the preview has to go
// through the application's own store, the commit has to leave a feature in the
// document, and the mark and the name of that feature have to come back out of a
// contribution table. Every one of those crosses the plugin boundary, and every
// one of them was an ordinary function call inside src/ a commit ago.
//
// Usage (from the repo root, with vite on 5173 and the sidecar running):
//   node e2e/texture_plugin.cjs
// SC_CHROME names a Chromium/Brave binary if the default is wrong.
// SC_URL must carry the sidecar token in a dev browser: ...?token=...

const { chromium } = require("playwright-core");

const CHROME = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ID = "FundaCAD.Texture";

/** Poll until `fn` is true, rather than sleeping a guessed number of ms. A
 *  fixed sleep is either slower than it needs to be or flaky under load, and
 *  under a full suite it manages both. */
async function until(page, fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await page.waitForTimeout(100);
  }
}

/** A short settle, for the NEGATIVE assertions only: "it is still absent" needs
 *  time to have been wrong in, and there is nothing to poll for. */
const settle = (page) => page.waitForTimeout(700);

/** Like `until`, but ANSWERS instead of throwing. For a condition whose failure
 *  is itself one of the findings: a thrown timeout reports the wait, a returned
 *  false lets the check that cares report the behaviour. */
async function soft(page, fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return true;
    if (Date.now() - t0 > ms) return false;
    await page.waitForTimeout(100);
  }
}

async function setEnabled(page, on) {
  await page.evaluate(async ([pid, value]) => {
    const m = await import("/src/plugins/registry.ts");
    m.setPluginEnabled(pid, value);
  }, [ID, on]);
  await page.waitForTimeout(800);
}

/** What the window currently shows about textures. Read from the DOM and from
 *  the application's own tables, never from the plugin. */
async function view(page) {
  return page.evaluate(async () => {
    const caps = await import("/src/features/toolCapabilities.ts");
    const meta = await import("/src/ui/featureMeta.ts");
    const icons = await import("/src/ui/icons.ts");
    const sel = await import("/src/ui/selectionTools.ts");
    const text = (el) => (el.textContent || "").trim();
    return {
      // the tool inventory, and what a face selection is offered
      inInventory: caps.capabilities().has("texture"),
      offeredToAFace: sel.selectionOffers({ face: 1 }).some((o) => o.tool === "texture"),
      // the mark, and the name in the history
      hasIcon: icons.iconPaths("texture").length > 0,
      featureLabel: meta.featureMeta({ type: "texture" }).label,
      // the ribbon button, by what is on screen
      ribbonButton: [...document.querySelectorAll("[class*=ribbon] button")]
        .some((b) => text(b) === "Texture"),
      // the panel, by what is on screen
      panelOpen: !!document.querySelector("[data-panel=texture]"),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const failures = [];
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  const check = (label, ok) => {
    console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
    if (!ok) failures.push(label);
  };

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  // The welcome screen opens over a fresh profile and counts as a modal, so
  // toolBusy() is true and every starter in the application returns silently —
  // a plugin's included, which is the correct behaviour and not what is under
  // test here. Dismiss it and get on.
  await page.keyboard.press("Escape");
  await until(page, () => window.__fundacad.toolBusy() === false, "the window to be idle");

  // --- 1. the plugin drew its surfaces without being touched ---------------
  const on = await view(page);
  check("the tool is in the application's inventory", on.inInventory);
  check("a face selection is offered it", on.offeredToAFace);
  check("it brought a mark the application does not have", on.hasIcon);
  check("a texture feature has a name in the history", on.featureLabel === "Texture");
  check("the ribbon carries its button", on.ribbonButton);

  // --- 2. switched off, every one of those goes ----------------------------
  await setEnabled(page, false);
  const off = await view(page);
  check("off: the tool leaves the inventory", !off.inInventory);
  check("off: a face is no longer offered it", !off.offeredToAFace);
  check("off: the mark is gone", !off.hasIcon);
  // The honest fallback: the document still opens, the history still has a row,
  // and it reads as something this build does not understand.
  check("off: a texture feature falls back to its raw type", off.featureLabel === "texture");
  check("off: the ribbon button is gone", !off.ribbonButton);
  // The control on the same reading: the application's own tools are untouched.
  const stillCore = await page.evaluate(async () => {
    const caps = await import("/src/features/toolCapabilities.ts");
    return caps.capabilities().has("fillet") && caps.capabilities().has("presspull");
  });
  check("off: the application's own tools are still there", stillCore);

  await setEnabled(page, true);
  check("back on: the tool returns", (await view(page)).inInventory);

  // --- 3. the gesture, on a real body -------------------------------------
  // A box from the real sidecar, so there is a real face to click.
  await page.evaluate(async () => {
    const a = window.__fundacad;
    a.store.addFeature({ id: "b1", type: "box", length: 40, width: 40, height: 20 });
    await a.store.rebuildNow();
  });
  await until(page, () => (window.__fundacad?.store?.buildState?.result?.mesh?.positions?.length ?? 0) > 0,
    "the box to build");

  // Start the tool through handleAction, which is the APPLICATION'S dispatcher —
  // the same door the ribbon button and the command palette go through. Calling
  // the plugin's own function instead would prove the plugin works and nothing
  // about whether the application can reach it: app/actions.ts has to fall all
  // the way through its own switch and ask the contribution table.
  await page.evaluate(() => window.__fundacad.handleAction("texture"));
  await until(page, () => !!document.querySelector("[data-panel=texture]"), "the panel to open");
  check("the action opens the plugin's panel", true);

  // While the plugin's tool is running, the application must believe it is busy.
  const busy = await page.evaluate(() => window.__fundacad.toolBusy());
  check("a plugin's tool holds the window", busy === true);

  // Pick a face the way a click does, then let the tool's rAF tick notice.
  await page.evaluate(() => window.__fundacad.viewport.selectFaces([0]));
  await until(page, () => {
    const p = document.querySelector("[data-panel=texture]");
    return !!p && /1 face selected/.test(p.textContent || "");
  }, "the tool to notice the selection");
  check("the ambient selection reaches the plugin's own loop", true);

  // THE GESTURE HAS TO SURVIVE ITS OWN PREVIEW, which is the thing this whole
  // file exists to check and the thing it used to miss. The tool pushes a live
  // preview 150 ms after the pick, and the reply comes back CHUNKED: every
  // installment publishes a fresh Highlighter, so the selection was wiped
  // mid-build and the tool read that as the user deselecting. It then threw the
  // members away, cleared the preview, and refused Add over a face that was lit
  // up on screen. Six runs out of six, on a plain box.
  //
  // The check above raced past it: it polls every 100 ms and the pick satisfies
  // it before the preview is even scheduled. So wait for the preview to have
  // been through the sidecar and landed, and only THEN ask.
  // A SOFT wait, not `until`: when this regresses, the preview never lands at
  // all (the tool clears it along with the members), and a thrown timeout would
  // report itself instead of the two named checks below.
  const landed = await soft(page,
    () => (window.__fundacad.store.buildState.result?.mesh?.positions?.length ?? 0) > 400
      && window.__fundacad.store.buildState.building === false);
  check("the tool's live preview reaches the model", landed);
  await settle(page);
  const survived = await page.evaluate(() => {
    const p = document.querySelector("[data-panel=texture]");
    return {
      faces: window.__fundacad.viewport.getSelectedFaceIds().length,
      summary: p ? /1 face selected/.test(p.textContent || "") : false,
    };
  });
  check("the pick survives the tool's own preview rebuild", survived.faces === 1);
  check("and the panel still says so", survived.summary);

  // Commit through the panel's own button, and read the document back.
  await page.evaluate(() => {
    const p = document.querySelector("[data-panel=texture]");
    const btn = [...p.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Add"));
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await until(page, () => window.__fundacad.store.document.features.some((f) => f.type === "texture"),
    "the texture feature to land in the document");
  check("committing leaves a texture in the document", true);

  const after = await page.evaluate(() => {
    const f = window.__fundacad.store.document.features.find((x) => x.type === "texture");
    return { kind: f.kind, hasBody: !!f.body };
  });
  check("the committed feature names its pattern and its body", after.kind === "knurl" && after.hasBody);
  check(
    "the window is released after a commit",
    (await page.evaluate(() => window.__fundacad.toolBusy())) === false,
  );

  // Re-opening it is the plugin's `edit` contribution, reached through the
  // application's editFeature — which has no case for a texture any more and
  // has to ask the table.
  const featureId = await page.evaluate(() =>
    window.__fundacad.store.document.features.find((x) => x.type === "texture").id);
  await page.evaluate((id) => window.__fundacad.editFeature(id), featureId);
  // "Apply" rather than "Add" is how the panel says it is editing something
  // that already exists, so this is also the check that it re-opened in the
  // right mode rather than merely opening.
  await until(page, () => {
    const p = document.querySelector("[data-panel=texture]");
    return !!p && [...p.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Apply"));
  }, "the panel to re-open on the committed feature");
  check("double-clicking the feature re-opens the plugin's tool", true);
  await page.evaluate(() => {
    const p = document.querySelector("[data-panel=texture]");
    const btn = [...p.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Cancel"));
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await until(page, () => !document.querySelector("[data-panel=texture]"),
    "the edit to be cancelled");
  check("cancelling the edit closes the panel and releases the window",
    (await page.evaluate(() => window.__fundacad.toolBusy())) === false);

  // --- 4. and it rebuilds with the plugin switched off ---------------------
  // The line the whole split is drawn on: uninstalling may cost you the panel
  // that makes one. It may not cost you the ones you already made.
  await setEnabled(page, false);
  await settle(page);
  const rebuilt = await page.evaluate(async () => {
    const a = window.__fundacad;
    await a.store.rebuildNow();
    const r = a.store.buildState.result;
    return {
      stillThere: a.store.document.features.some((f) => f.type === "texture"),
      built: (r?.mesh?.positions?.length ?? 0) > 0,
      error: r?.error ?? null,
    };
  });
  check("off: the texture is still in the document", rebuilt.stillThere);
  check("off: the document still builds", rebuilt.built && !rebuilt.error);

  await browser.close();
  if (failures.length) {
    console.error(`\n${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nOK a tool can be a plugin, and a document does not depend on one");
})().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
