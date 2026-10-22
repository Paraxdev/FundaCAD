// The app shell never scrolls, so the title bar stays at y 0.
//
// #app was `overflow: hidden`, which still lets script scroll it, and the tool
// rail's foot pokes 20px past the window for its shadow bleed. Any
// scrollIntoView that wanted its target lower (History's error badge centres the
// failing step) then scrolled #app and lifted the whole shell by up to 20px.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chromium or brave> node e2e/shell_no_shift_e2e.cjs
// SC_APP_PORT and SC_ENGINE_PORT move it off 5173/8765, to run beside a dev
// session (the engine then needs FUNDACAD_EXTRA_ORIGINS for that app port).
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const APP_PORT = process.env.SC_APP_PORT || "5173";
const WS_PORT = process.env.SC_ENGINE_PORT || "8765";
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

function doc() {
  const features = [
    {
      id: "s1",
      type: "sketch",
      plane: "XY",
      entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 24 }],
    },
  ];
  for (let i = 0; i < 12; i++)
    features.push({ id: `e${i}`, type: "extrude", sketch: "s1", distance: 12 + i, operation: i ? "join" : "new" });
  features.push({ id: "bad", type: "extrude", sketch: "nope", distance: 5, operation: "join" });
  return JSON.stringify({ version: 9, parameters: {}, paramDefs: {}, features });
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    await page.addInitScript(
      ({ t, ws }) => {
        const N = window.WebSocket;
        class P extends N {
          constructor(u, p) {
            const s = String(u)
              .replace(":8765", `:${ws}`)
              .replace(/([?&])token=[^&]*/, `$1token=${t}`);
            super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
          }
        }
        window.WebSocket = P;
      },
      { t: TOKEN, ws: WS_PORT },
    );

    await page.goto(`http://localhost:${APP_PORT}/`);
    await page.waitForFunction(() => !!window.store, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await page.evaluate(async (text) => {
      window.store.load(text);
      await Promise.race([window.store.rebuildNow?.(), new Promise((r) => setTimeout(r, 15000))]);
    }, doc());
    await page.waitForTimeout(1500);

    // Every box from the title bar up to the root, and the canvas host's.
    const shift = () =>
      page.evaluate(() => {
        const chain = [];
        for (let el = document.getElementById("titlebar"); el; el = el.parentElement) chain.push(el);
        const scrolled = chain
          .filter((el) => el.scrollTop !== 0 || el.scrollLeft !== 0)
          .map((el) => `${el.tagName.toLowerCase()}#${el.id} ${el.scrollTop}`);
        return { titleTop: document.getElementById("titlebar").getBoundingClientRect().top, scrolled };
      });
    const stays = async (what) => {
      await page.waitForTimeout(900);
      const s = await shift();
      check(
        `${what}, the shell stays put`,
        s.titleTop === 0 && s.scrolled.length === 0,
        `title bar top ${s.titleTop}${s.scrolled.length ? `, scrolled ${s.scrolled.join(", ")}` : ""}`,
      );
      // Undo a shift, so each check stands on its own.
      await page.evaluate(() => {
        for (const el of [document.getElementById("app"), document.body, document.documentElement]) el.scrollTop = 0;
      });
    };

    await stays("loaded");

    const badge = page.locator(".timeline-errbadge:not(.hidden)");
    check("History shows the failing step's error badge", (await badge.count()) > 0);
    if (await badge.count()) {
      await badge.first().click();
      await stays("the error badge centres the failing step");
    }

    await page.evaluate(() => {
      const nodes = document.querySelectorAll("#timeline .timeline-node");
      nodes[nodes.length - 1]?.scrollIntoView({ block: "center" });
    });
    await stays("the last History step scrolled into view, centred");

    await page.evaluate(() => {
      const foot = document.querySelector(".rail-foot");
      foot?.scrollIntoView({ block: "end" });
      foot?.querySelector("button")?.focus();
    });
    await stays("the rail foot scrolled into view and focused");

    // What any later caller could do; a clipped shell has nothing to scroll.
    await page.evaluate(() => {
      document.getElementById("app").scrollTop = 40;
      document.body.scrollTop = 40;
      document.documentElement.scrollTop = 40;
    });
    await stays("script sets scrollTop on #app, body and html");
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
