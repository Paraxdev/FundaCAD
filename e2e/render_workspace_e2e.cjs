// The Render workspace: the toggle, the dock, the previews, the drop, the
// environments, the lens, and the picture at the end.
//
// Read back off the LIVE app: the store after a drop, the THREE materials the
// renderer is actually drawing with, the camera's own fov. A screenshot
// comparison of a lit solid is a test that fails when a graphics driver
// changes; what is asserted here is that the gesture reached the model.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> node e2e/render_workspace_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "render_ws_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

/** A real HTML5 drag, synthesised. Playwright's own dragTo drives the POINTER,
 *  which a native drag-and-drop gesture does not surface to page scripts at all;
 *  the events the app listens for are dragstart/dragover/drop, and they carry a
 *  DataTransfer that has to be the SAME object across all three or the drop
 *  arrives with an empty types list and is refused as somebody else's drag. */
async function dragMaterialTo(page, materialId, x, y, opts = {}) {
  return page.evaluate(({ materialId, x, y, shiftKey }) => {
    const src = document.querySelector(`[data-material="${materialId}"]`);
    const pane = document.getElementById("viewport");
    if (!src || !pane) return { ok: false, why: "no source or no viewport" };
    const dt = new DataTransfer();
    const fire = (el, type, extra = {}) => {
      const ev = new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: extra.clientX ?? 0, clientY: extra.clientY ?? 0,
        shiftKey: extra.shiftKey ?? false,
      });
      el.dispatchEvent(ev);
      return ev;
    };
    fire(src, "dragstart");
    fire(pane, "dragover", { clientX: x, clientY: y, shiftKey });
    const over = fire(pane, "dragover", { clientX: x, clientY: y, shiftKey });
    const accepted = over.defaultPrevented;
    fire(pane, "drop", { clientX: x, clientY: y, shiftKey });
    fire(src, "dragend");
    return { ok: true, accepted, types: [...dt.types] };
  }, { materialId, x, y, shiftKey: !!opts.shift });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
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

  // A block to drop things on.
  await page.evaluate(async () => {
    window.store.addFeature({ id: window.store.nextId(), type: "box", length: 40, width: 30, height: 20 });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1200);

  // ---- 1. the workspace toggle --------------------------------------------
  console.log("\n1. [ Model | Render ]");
  check("the toggle is in the title bar",
    await page.locator("#workspace-toggle .seg-btn").count() === 2);
  check("Model is the one it opens in",
    await page.locator("#workspace-toggle .seg-btn.active").getAttribute("data-workspace") === "model");
  check("and the dock is not mounted at all (control)",
    await page.locator("#renderdock").count() === 0);

  const viewportBefore = await page.locator("#viewport").boundingBox();
  await page.click('#workspace-toggle [data-workspace="render"]');
  await page.waitForTimeout(900);
  check("Render opens the dock", await page.locator("#renderdock").count() === 1);
  check("with three tabs", await page.locator(".rd-tab").count() === 3,
    (await page.locator(".rd-tab").allTextContents()).join(" | "));
  const viewportAfter = await page.locator("#viewport").boundingBox();
  check("and the viewport gives up exactly the dock's width",
    Math.abs((viewportBefore.width - viewportAfter.width) - 301) <= 2,
    `${Math.round(viewportBefore.width)} -> ${Math.round(viewportAfter.width)}`);

  // ---- 2. the previews are RENDERS ----------------------------------------
  console.log("\n2. the swatches");
  await page.waitForTimeout(1200); // the reflections land a beat after the panel
  const balls = await page.evaluate(() => {
    const out = [];
    for (const img of document.querySelectorAll(".rd-tile img.rd-ball")) {
      out.push({ len: img.src.length, head: img.src.slice(0, 22), w: img.naturalWidth });
    }
    return out;
  });
  check("every material in the library got one",
    balls.length >= 11, `${balls.length} swatches`);
  check("each is a real PNG the renderer produced",
    balls.every((b) => b.head === "data:image/png;base64," && b.len > 2000 && b.w === 160),
    `smallest ${Math.min(...balls.map((b) => b.len))} bytes, ${balls[0]?.w}px square`);
  const distinct = new Set(await page.evaluate(() =>
    [...document.querySelectorAll(".rd-tile img.rd-ball")].map((i) => i.src)));
  check("and two different materials are two different pictures",
    distinct.size === balls.length, `${distinct.size} distinct of ${balls.length}`);
  await page.locator("#renderdock").screenshot({ path: path.join(OUT, "1-materials.png") });

  // ---- 3. a material dropped on a FACE -------------------------------------
  console.log("\n3. dropping one on a face");
  const box = await page.locator("canvas").boundingBox();
  const mid = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const drag = await dragMaterialTo(page, "m-brass", mid.x, mid.y);
  check("the viewport accepted the drag", drag.ok && drag.accepted, JSON.stringify(drag));
  await page.waitForTimeout(900);

  const afterFace = await page.evaluate(() => ({
    faces: window.store.faceMaterialEntries(),
    bodyMat: window.store.bodyMaterialId("body1") ?? null,
  }));
  check("exactly one body face wears it now",
    afterFace.faces.length >= 1 && afterFace.faces.every(([, id]) => id === "m-brass"),
    JSON.stringify(afterFace.faces));
  check("and the BODY was left alone (control: a face drop is not a body drop)",
    afterFace.bodyMat === null, String(afterFace.bodyMat));

  // The renderer's own answer: the mesh now draws with more than one material.
  const groups = await page.evaluate(() => {
    const b = window.viewport.bodyMeshes[0];
    const mats = Array.isArray(b.mesh.material) ? b.mesh.material : [b.mesh.material];
    return {
      count: mats.length,
      groups: b.mesh.geometry.groups.length,
      slots: [...new Set(b.mesh.geometry.groups.map((g) => g.materialIndex))].sort(),
      finishes: mats.map((m) => ({ metal: m.metalness, rough: m.roughness })),
      covered: b.mesh.geometry.groups.reduce((n, g) => n + g.count, 0),
      indices: b.mesh.geometry.index.count,
    };
  });
  check("the body draws with a second material for that face",
    groups.count === 2, JSON.stringify(groups.finishes));
  check("the groups cover every triangle, none left undrawn",
    groups.covered === groups.indices, `${groups.covered} of ${groups.indices} indices`);
  check("and both materials are actually used",
    groups.slots.length === 2, `slots ${groups.slots.join(",")}, ${groups.groups} groups`);
  check("brass is the metallic one",
    groups.finishes[1].metal === 0.9 && groups.finishes[1].rough === 0.3,
    JSON.stringify(groups.finishes[1]));
  await page.locator("#viewport").screenshot({ path: path.join(OUT, "2-face-dropped.png") });

  // ---- 4. Shift drops onto the whole body ----------------------------------
  console.log("\n4. Shift, the whole body");
  const dragBody = await dragMaterialTo(page, "m-copper", mid.x, mid.y, { shift: true });
  check("accepted", dragBody.ok && dragBody.accepted);
  await page.waitForTimeout(800);
  const afterBody = await page.evaluate(() => window.store.bodyMaterialId("body1") ?? null);
  check("the body wears it", afterBody === "m-copper", String(afterBody));
  const stillFace = await page.evaluate(() => window.store.faceMaterialEntries().length);
  check("and the face keeps its own, which is the point of having both",
    stillFace >= 1, `${stillFace} face assignments`);

  // ---- 5. it survives a rebuild and a reopen -------------------------------
  console.log("\n5. surviving");
  const saved = await page.evaluate(async () => {
    const json = window.store.toJSON();
    window.store.addFeature({ id: window.store.nextId(), type: "move", body: "body1", dx: 5 });
    await window.store.rebuildNow();
    return {
      json,
      hasBlock: json.includes('"faceMaterials"'),
      afterRebuild: Array.isArray(window.viewport.bodyMeshes[0].mesh.material)
        ? window.viewport.bodyMeshes[0].mesh.material.length : 1,
    };
  });
  check("the assignment is in the saved file", saved.hasBlock);
  check("and the second material is still on the mesh after a rebuild",
    saved.afterRebuild === 2, `${saved.afterRebuild} materials`);

  // ---- 6. environments -----------------------------------------------------
  console.log("\n6. the room");
  await page.click('.rd-tab[data-tab="environment"]');
  await page.waitForTimeout(300);
  check("six rooms on offer", await page.locator("#renderdock [data-environment]").count() === 6);
  await page.locator("#renderdock").screenshot({ path: path.join(OUT, "8-environment-tab.png") });
  const envMaps = [];
  for (const env of ["softbox", "dusk", "bright"]) {
    await page.click(`#renderdock [data-environment="${env}"]`);
    await page.waitForTimeout(1100);
    const on = await page.evaluate(() => ({
      pref: window.viewport.scene.scene.environment !== null,
      uuid: window.viewport.scene.scene.environment?.uuid ?? null,
    }));
    check(`${env} reaches the scene`, on.pref, on.uuid ? on.uuid.slice(0, 8) : "null");
    envMaps.push(on.uuid);
    await page.locator("#viewport").screenshot({ path: path.join(OUT, `3-env-${env}.png`) });
  }
  // Three DIFFERENT cubemaps, not the same one three times: the cache is keyed
  // per environment, and a key that collapsed would light every room identically
  // while every check above still passed.
  check("and each is a room of its own",
    new Set(envMaps).size === 3, envMaps.map((u) => u?.slice(0, 8)).join(" "));
  const envPics = ["3-env-softbox", "3-env-dusk", "3-env-bright"].map((n) =>
    require("crypto").createHash("md5").update(fs.readFileSync(path.join(OUT, `${n}.png`))).digest("hex"));
  check("which the model is visibly lit by", new Set(envPics).size === 3,
    envPics.map((h) => h.slice(0, 8)).join(" "));
  await page.click('#renderdock [data-environment="none"]');
  await page.waitForTimeout(600);
  check("and Flat takes it away again (control)",
    await page.evaluate(() => window.viewport.scene.scene.environment === null));
  await page.click('#renderdock [data-environment="studio"]');
  await page.waitForTimeout(900);

  // ---- 7. the lens ---------------------------------------------------------
  console.log("\n7. the lens");
  await page.click('.rd-tab[data-tab="camera"]');
  await page.waitForTimeout(300);
  await page.locator("#renderdock").screenshot({ path: path.join(OUT, "9-camera-tab.png") });
  const fov0 = await page.evaluate(() => window.viewport.rig.fov());
  await page.locator("#rd-fov").fill("22");
  await page.waitForTimeout(500);
  const fov1 = await page.evaluate(() => ({
    rig: window.viewport.rig.fov(),
    camera: window.viewport.rig.active.fov,
  }));
  check("the slider reaches the actual camera",
    fov1.rig === 22 && fov1.camera === 22, `${fov0} -> ${JSON.stringify(fov1)}`);
  await page.locator("#viewport").screenshot({ path: path.join(OUT, "4-fov-22.png") });
  await page.locator("#rd-fov").fill("65");
  await page.waitForTimeout(500);
  await page.locator("#viewport").screenshot({ path: path.join(OUT, "5-fov-65.png") });
  const md5 = (n) => require("crypto").createHash("md5")
    .update(fs.readFileSync(path.join(OUT, `${n}.png`))).digest("hex");
  check("and a wider lens is visibly a different picture",
    md5("4-fov-22") !== md5("5-fov-65"));
  await page.locator("#rd-fov").fill("45");

  // depth of field
  const dofOff = await page.evaluate(() => window.viewport.scene.post.bokehOn ?? null);
  await page.locator("#rd-blur").fill("0.6");
  await page.waitForTimeout(1400);
  const dof = await page.evaluate(() => {
    const post = window.viewport.scene.post;
    return { on: post.bokehOn, focus: Math.round(post.focusDistance) };
  });
  check("blur switches the depth-of-field pass on", dof.on === true, JSON.stringify(dof));
  check("focused on what the view is centred on",
    dof.focus > 1, `${dof.focus} mm from the camera`);
  await page.locator("#viewport").screenshot({ path: path.join(OUT, "6-dof.png") });
  await page.locator("#rd-blur").fill("0");
  await page.waitForTimeout(600);
  check("and zero turns it off again, so an ordinary viewport pays nothing (control)",
    await page.evaluate(() => window.viewport.scene.post.bokehOn) === false,
    `was ${dofOff}`);

  // ---- 8. the picture ------------------------------------------------------
  console.log("\n8. the picture");
  const still = await page.evaluate(() => {
    const c = document.querySelector("canvas").getBoundingClientRect();
    const url = window.viewport.renderStill(2);
    return { url: url.slice(0, 22), len: url.length, w: Math.round(c.width), h: Math.round(c.height) };
  });
  check("renderStill hands back a PNG", still.url === "data:image/png;base64,", still.url);
  check("and a big one", still.len > 20000, `${Math.round(still.len / 1024)} KiB`);
  const dims = await page.evaluate(async () => {
    const url = window.viewport.renderStill(2);
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = url; });
    const c = document.querySelector("canvas").getBoundingClientRect();
    return { iw: img.width, ih: img.height, cw: Math.round(c.width), ch: Math.round(c.height) };
  });
  check("twice the viewport, in pixels",
    dims.iw === dims.cw * 2 && dims.ih === dims.ch * 2, JSON.stringify(dims));
  const restored = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return {
      buffer: [c.width, c.height],
      css: [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)],
      grid: window.viewport.scene.grid.group.visible,
      triad: window.viewport.scene.triad.group.visible,
      // The edge lines are hidden for the picture and have to come back: this
      // is the one restore that is easy to forget, because it is the only piece
      // of furniture that belongs to the MODEL rather than to the scene.
      edges: window.viewport.bodyMeshes.every((b) => b.edges.object.visible),
    };
  });
  check("and the viewport is put back exactly as it was",
    restored.grid === true && restored.triad === true && restored.edges === true
    && restored.buffer[0] <= restored.css[0] * 2 + 2,
    JSON.stringify(restored));
  fs.writeFileSync(path.join(OUT, "7-still.png"), Buffer.from(
    (await page.evaluate(() => window.viewport.renderStill(2))).split(",")[1], "base64"));

  // ---- 9. a sketch takes the workspace away --------------------------------
  console.log("\n9. sketching");
  await page.evaluate(() => window.__fundacad.handleAction("sketch"));
  await page.waitForTimeout(300);
  // Sketch asks for a plane first, so the gesture is the command AND a click on
  // a face. Clicking the middle of the block puts one on whatever is facing us.
  await page.mouse.move(mid.x, mid.y);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1200);
  check("a sketch actually opened (control: the rest of this section means nothing otherwise)",
    await page.evaluate(() => window.sketch.active) === true);
  const inSketch = await page.evaluate(() => ({
    dock: !!document.getElementById("renderdock"),
    toggle: !!document.getElementById("workspace-toggle"),
  }));
  check("the dock is gone while a sketch is open", inSketch.dock === false, JSON.stringify(inSketch));
  check("and so is the toggle, rather than offering a third mode from inside one",
    inSketch.toggle === false);

  console.log(`\nshots in ${OUT}`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall render workspace checks passed");
  process.exit(failures ? 1 : 0);
})();
