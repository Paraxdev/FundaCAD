// Does the 2D constraint solver start under the policy a PACKAGED build ships?
//
// This exists because no other test can answer that. `tauri dev` serves from
// vite with no CSP, so development never shows it; vitest runs in Node, which
// has no CSP, so the unit suites never show it either. The solver was dead in
// every packaged build for months behind exactly that gap, and the app told
// users to reinstall their webview runtime.
//
// The policy is READ FROM src-tauri/tauri.conf.json rather than written out
// here, so this cannot certify a policy the app does not ship.
//
// Usage (from the repo root, no dev server and no sidecar needed):
//   node e2e/solver_csp.cjs
//
// SC_CHROME picks the browser. Any Chromium build works.
const { chromium } = require("playwright-core");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GLUE = path.join(ROOT, "node_modules/@salusoft89/planegcs/dist/planegcs_dist");
const EXE = process.env.SC_CHROME
  || "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

const CSP = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"))
  .app.security.csp;

// The driver is an EXTERNAL module, never inline: `script-src 'self'` blocks
// inline scripts, so an inline driver would be blocked before it ever reached
// planegcs and would "fail" for a reason that has nothing to do with the solver.
const PAGE = `<!doctype html><meta charset="utf-8"><title>solver csp</title>
<body><pre id="out">running</pre><script type="module" src="/driver.js"></script></body>`;

// The two calls src/sketch/solver.ts makes, in order.
const DRIVER = `
const say = (s) => { document.getElementById("out").textContent = s; window.__result = s; };
try {
  const mod = await import("./planegcs.js");
  const M = await mod.default({ locateFile: () => "./planegcs.wasm" });
  new M.GcsSystem();
  say("OK");
} catch (e) {
  say("FAIL: " + (e && e.name) + ": " + (e && e.message));
}
`;

function serve(csp) {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split("?")[0];
      const headers = csp ? { "Content-Security-Policy": csp } : {};
      if (url === "/") {
        res.writeHead(200, { ...headers, "Content-Type": "text/html" });
        return res.end(PAGE);
      }
      if (url === "/driver.js") {
        res.writeHead(200, { ...headers, "Content-Type": "text/javascript" });
        return res.end(DRIVER);
      }
      const file = path.join(GLUE, path.basename(url));
      if (!fs.existsSync(file)) { res.writeHead(404, headers); return res.end(); }
      res.writeHead(200, {
        ...headers,
        "Content-Type": file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, () => done({ server, port: server.address().port }));
  });
}

async function run(browser, csp) {
  const { server, port } = await serve(csp);
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
    await page
      .waitForFunction(() => window.__result !== undefined, null, { timeout: 30000 })
      .catch(() => {});
    const result = await page.evaluate(() => window.__result ?? "(never resolved)");
    await page.close();
    return result;
  } finally {
    server.close();
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
  let failed = false;
  try {
    console.log(`policy under test:\n  ${CSP}\n`);

    const shipped = await run(browser, CSP);
    console.log(`  ${shipped === "OK" ? "OK  " : "FAIL"} the solver starts under the shipped policy`);
    if (shipped !== "OK") {
      failed = true;
      console.log(`       ${shipped}`);
      console.log("       The sketcher is dead in packaged builds. script-src must permit");
      console.log("       what planegcs needs, or the glue must stop needing it.");
    }

    // A CONTROL, so a pass cannot be vacuous. If the solver starts even with
    // script-src stripped to 'self', then this harness is not exercising the
    // thing it claims to and its OK above means nothing.
    const bare = await run(browser, CSP.replace(/script-src[^;]*/, "script-src 'self'"));
    const controlOk = bare !== "OK";
    console.log(`  ${controlOk ? "OK  " : "FAIL"} the control fails, so the check is not vacuous`);
    if (!controlOk) {
      failed = true;
      console.log("       planegcs started with script-src 'self', so this harness proves nothing.");
    }
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
