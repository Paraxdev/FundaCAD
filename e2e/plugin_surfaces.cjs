// Do the capabilities actually put things on screen, and take them away again?
//
// Nothing here is stubbed, and that is the whole point. Vite serves the real
// bundle, plugins/activate.ts globs the real plugin directories, each plugin's
// real activate() runs, and the real contribution table feeds the real menubar
// and the real ribbon. What is read back is the DOM.
//
// WHY IT EXISTS. The unit tests check that the menubar merges what it is given
// and that the table gives it. Both passed while the app was visibly wrong: a
// capability is switched on, and only some milliseconds later, after its module
// is fetched and its activate() has run, does it have rows to add. The surfaces
// were watching the SWITCH, so they rebuilt while the rows were still loading
// and were then left showing the previous state permanently. Nothing that stubs
// the loading can see that.
//
// Usage (from the repo root, with vite on 5173):
//   node e2e/plugin_surfaces.cjs
// SC_CHROME names a Chromium/Brave binary if the default is wrong.

const { chromium } = require("playwright-core");

const CHROME = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";

/** The capabilities to switch, and the DOM each is expected to own.
 *
 *  By id and by what it draws, not by what it is: this file is the outside view,
 *  and the outside view of a capability is the rows it puts in a menu. */
const CASES = [
  {
    id: "FundaCAD.SpaceMouse",
    owns: "the View menu",
    present: (m) => m.menus.includes("View"),
  },
  {
    id: "FundaCAD.Printing",
    owns: "the print rows and the PRINT group",
    present: (m) => m.menus.includes("Send to Printer…") && m.ribbon.includes("PRINT"),
  },
];

async function surfaces(page) {
  return page.evaluate(() => {
    const text = (el) => (el.textContent || "").trim().split("\n")[0].trim();
    const menus = [...document.querySelectorAll("#menubar button, .menubar button, [class*=menu] button")]
      .map(text)
      .filter(Boolean)
      // "Send to Printer…" renders with no shortcut; rows that have one carry it
      // in the same node, so compare on the label half.
      .map((t) => t.replace(/Ctrl\+.*$|Del$|\?$/, ""));
    const ribbon = [...document.querySelectorAll("[class*=ribbon] [class*=group], .ribbon-group")]
      .map((el) => text(el.querySelector("[class*=label], .ribbon-group-label") || el));
    return { menus, ribbon: [...new Set(ribbon)] };
  });
}

/** Flip a capability through the real registry and let its activate() settle. */
async function setEnabled(page, id, on) {
  await page.evaluate(async ([pid, value]) => {
    const m = await import("/src/plugins/registry.ts");
    m.setPluginEnabled(pid, value);
  }, [id, on]);
  await page.waitForTimeout(600);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const failures = [];
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const check = (label, ok) => {
    console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
    if (!ok) failures.push(label);
  };

  // As shipped: everything that is on by default has drawn itself. This is the
  // assertion the async-arrival bug failed, and it failed at 2.5 seconds, long
  // after any plausible race, because the surface was never coming back.
  const shipped = await surfaces(page);
  for (const c of CASES) {
    check(`${c.id} drew ${c.owns} without being touched`, c.present(shipped));
  }

  for (const c of CASES) {
    await setEnabled(page, c.id, false);
    const off = await surfaces(page);
    check(`${c.id} off: ${c.owns} is gone`, !c.present(off));
    // The control on the same reading: switching one off must not take another
    // one's surfaces with it.
    for (const other of CASES.filter((x) => x !== c)) {
      check(`${c.id} off: ${other.id} still has ${other.owns}`, other.present(off));
    }

    await setEnabled(page, c.id, true);
    const on = await surfaces(page);
    check(`${c.id} back on: ${c.owns} is back`, c.present(on));
  }

  await browser.close();
  if (failures.length) {
    console.error(`\n${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nOK every capability draws its own surfaces and takes them away");
})().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
