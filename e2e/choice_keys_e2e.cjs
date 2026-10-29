// The choosers' keys in a real browser, where happy-dom cannot show native
// checkbox activation.
//
//   1. A multi chooser opens on its first box, with OK greyed.
//   2. Space ticks the focused box natively, and OK wakes.
//   3. Tab moves to the next box, Space ticks it, Enter answers both.
//   4. Focus goes back to the opener, and the keymap never heard Space.
//   5. A single chooser takes Escape as no answer.
//
// Usage (from the repo root, with vite running, the engine is optional):
//   SC_CHROME=<chrome.exe> [SC_TOKEN=<engine token>] [SC_URL=http://localhost:5173/] node e2e/choice_keys_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store, null, { timeout: 60000 });

  const state = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      const boxes = [...document.querySelectorAll(".ui-confirm-check input")];
      const ok = document.querySelector(".ui-confirm-ok");
      return {
        focus: a?.id || a?.className || a?.tagName,
        focusIndex: boxes.indexOf(a),
        ticked: boxes.map((b) => b.checked),
        okDisabled: ok ? ok.getAttribute("aria-disabled") === "true" : null,
        open: !!document.querySelector(".ui-confirm"),
        answer: window.__answer,
        keymapHeard: window.__keymapHeard,
      };
    });

  await page.evaluate(async () => {
    const opener = document.createElement("button");
    opener.id = "choice-opener";
    opener.textContent = "open";
    document.body.appendChild(opener);
    opener.focus();
    window.__answer = "pending";
    window.__keymapHeard = 0;
    window.addEventListener("keydown", (e) => {
      if (e.key === " ") window.__keymapHeard++;
    });
    const m = await import("/src/ui/choice.ts");
    void m
      .chooseMulti(
        "Export which bodies?",
        [
          { value: "a", label: "Bracket", hint: "body1" },
          { value: "b", label: "Lid", hint: "body2" },
          { value: "c", label: "Screw" },
        ],
        { confirmLabel: "Export" },
      )
      .then((r) => (window.__answer = r));
  });
  await page.waitForSelector(".ui-confirm-check input");
  await page.waitForTimeout(200);
  let s = await state();
  check("the multi chooser opens on its first box", s.focusIndex === 0, JSON.stringify(s));
  check("OK is greyed with nothing ticked", s.okDisabled === true && s.ticked.join() === "false,false,false");

  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  s = await state();
  check("Space ticks the focused box", s.ticked.join() === "true,false,false", s.ticked.join());
  check("and OK wakes", s.okDisabled === false);

  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  s = await state();
  check(
    "Tab moves to the next box and Space ticks it",
    s.focusIndex === 1 && s.ticked.join() === "true,true,false",
    JSON.stringify(s),
  );

  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  s = await state();
  check("Enter answers the two ticked", JSON.stringify(s.answer) === '["a","b"]' && !s.open, JSON.stringify(s.answer));
  check("focus goes back to the opener", s.focus === "choice-opener", s.focus);
  check("the window keymap never heard Space", s.keymapHeard === 0, String(s.keymapHeard));

  await page.evaluate(async () => {
    window.__answer = "pending";
    const m = await import("/src/ui/choice.ts");
    void m
      .choose("Section view: cut along what?", [
        { value: "face", label: "Face or plane", primary: true },
        { value: "axis", label: "Axis" },
      ])
      .then((r) => (window.__answer = r));
  });
  await page.waitForSelector(".ui-confirm-choice");
  await page.waitForTimeout(200);
  s = await state();
  check("the single chooser opens on its primary", /ui-confirm-primary/.test(String(s.focus)), s.focus);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  s = await state();
  check("Escape closes it with no answer", s.answer === null && !s.open, JSON.stringify(s.answer));
  check("and focus goes back to the opener", s.focus === "choice-opener", s.focus);

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
