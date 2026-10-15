// Files dragged onto the window from the desktop, in a real browser against the
// real geometry engine. The browser path: the page reads File objects and sends
// mesh and CAD files to the engine as bytes.
//
//   1. A file drag shows the drop hint and leaving the window hides it.
//   2. A dropped STL lands as one import step.
//   3. A dropped .funda replaces the document and the title takes its name.
//   4. A dropped .txt is refused with an error notice naming it.
//   5. Two STLs dropped together become two import steps.
//   6. A material drag is left alone by the file handler.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/desktop_drop_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const STL = (name) => `solid ${name}
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 10 0
vertex 10 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 0 10
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 0 10
vertex 0 10 0
endloop
endfacet
facet normal 0.577 0.577 0.577
outer loop
vertex 10 0 0
vertex 0 10 0
vertex 0 0 10
endloop
endfacet
endsolid ${name}
`;

(async () => {
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
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const settle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.store.buildState.building && !window.store.busy?.active, null, { timeout: 120000 });
  };
  const imports = () => page.evaluate(() => window.store.document.features.filter((f) => f.type === "import").map((f) => f.name));

  // Builds the DataTransfer in the page, the way a desktop drag delivers one.
  const drag = (type, files, opts = {}) => page.evaluate(({ type, files, opts }) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([f.text], f.name));
    if (opts.mime) dt.setData(opts.mime, "x");
    const el = document.querySelector(opts.on || "canvas") || document.body;
    const r = el.getBoundingClientRect();
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
    return { cancelled: !el.dispatchEvent(ev) };
  }, { type, files, opts });
  const hint = () => page.evaluate(() => !!document.querySelector("[data-testid=drop-hint]"));

  console.log("1. the drop hint");
  const tri = [{ name: "tri.stl", text: STL("tri") }];
  const enter = await drag("dragenter", tri);
  const over = await drag("dragover", tri);
  await page.waitForTimeout(100);
  check("dragover of a file is accepted", over.cancelled && enter.cancelled);
  check("the hint shows while a file is over the window", await hint());
  await drag("dragleave", tri);
  await page.waitForTimeout(100);
  check("leaving the window hides the hint", !(await hint()));

  console.log("2. one STL");
  await drag("dragenter", tri);
  const drop = await drag("drop", tri);
  await page.waitForTimeout(100);
  check("the drop is taken, not left to the browser", drop.cancelled);
  check("the hint is gone after the drop", !(await hint()));
  await settle();
  const one = await imports();
  check("one import step", one.length === 1 && one[0] === "tri", JSON.stringify(one));
  const src = await page.evaluate(() => window.store.document.features.find((f) => f.type === "import")?.source);
  check("its source is the file name", src === "tri.stl", src);

  console.log("3. a .funda document");
  const doc = JSON.stringify({ parameters: {}, features: [{ id: "f1", type: "box", length: 10, width: 10, height: 10 }] });
  await drag("drop", [{ name: "dropped.funda", text: doc }]);
  await page.waitForTimeout(500);
  const choice = await page.$("button:has-text('Discard')");
  if (choice) await choice.click();
  await settle();
  const opened = await page.evaluate(() => ({
    name: window.store.fileName, types: window.store.document.features.map((f) => f.type), title: document.title,
  }));
  check("the document replaced the open one", JSON.stringify(opened.types) === '["box"]', JSON.stringify(opened.types));
  check("the title takes its name", /dropped/.test(opened.name) && (opened.title === "" || /dropped/.test(opened.title)), `${opened.name} | ${opened.title}`);

  console.log("4. a .txt");
  const featuresBefore = await page.evaluate(() => window.store.document.features.length);
  await drag("drop", [{ name: "a.txt", text: "hello" }]);
  await page.waitForTimeout(800);
  const notice = await page.evaluate(() => document.querySelector(".err-notice")?.textContent ?? "");
  check("an error notice names it", /a\.txt/.test(notice), notice.trim());
  check("nothing was added", (await page.evaluate(() => window.store.document.features.length)) === featuresBefore);

  console.log("5. two STLs together");
  await drag("drop", [{ name: "first.stl", text: STL("first") }, { name: "second.stl", text: STL("second") }]);
  await settle();
  await page.waitForTimeout(500);
  await settle();
  const two = await imports();
  check("two import steps in drop order", JSON.stringify(two) === '["first","second"]', JSON.stringify(two));

  console.log("6. a material drag");
  const mat = await drag("dragover", [], { mime: "application/x-fundacad-material", on: "body" });
  await page.waitForTimeout(100);
  check("the file handler leaves it alone", !mat.cancelled && !(await hint()));

  await browser.close();
  console.log(failures ? `FAILED: ${failures}` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
