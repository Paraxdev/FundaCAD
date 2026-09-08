// Does a plugin sandbox start under the policy a PACKAGED build ships?
//
// This exists for the same reason e2e/solver_csp.cjs does, and the lesson is
// the same one: `tauri dev` serves from vite with no CSP, and vitest runs in
// Node, which has no CSP either. The constraint solver was dead in every
// packaged build for months behind exactly that gap. A plugin sandbox is the
// next thing in this repository whose failure mode is "works everywhere the
// tests look, refused where it ships".
//
// The policy is READ FROM src-tauri/tauri.conf.json, so this cannot certify a
// policy the app does not ship.
//
// WHAT IT PROVES, which is the shape src/plugins/runner/spawn.ts builds:
//
//   1. a blob can become a module Worker              (worker-src blob:)
//   2. that Worker can import the app's own bootstrap (worker-src/script-src 'self')
//   3. the plugin's code, inlined into the blob, runs without 'unsafe-eval'
//   4. the two ends complete the protocol handshake and a grant check
//   5. the Worker has no DOM
//
// (3) is the one worth being deliberate about. The obvious sandbox hands the
// plugin's text to the Function constructor, which needs 'unsafe-eval'. That
// grant is in this app's policy for ONE unrelated reason (planegcs; see
// tests/security/csp.test.ts) and is meant to be removed when that reason goes.
// So this run strips 'unsafe-eval' out of the policy before applying it, and
// everything below has to pass anyway.
//
// Usage (from the repo root, no dev server and no sidecar needed):
//   node e2e/sandbox_csp.cjs
//
// SC_CHROME picks the browser. Any Chromium build works.
const { chromium } = require("playwright-core");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXE =
  process.env.SC_CHROME ||
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

const CSP = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"))
  .app.security.csp;

/** The shipped policy with `'unsafe-eval'` taken out.
 *
 *  Not a weaker test, a stricter one: the sandbox must not need that grant, and
 *  running under the policy that still has it would let a dependency on it pass
 *  unnoticed until the day it is removed. */
const CSP_WITHOUT_EVAL = CSP.split(";")
  .map((d) => d.trim().replace(/\s*'unsafe-eval'/, ""))
  .join("; ");

// Stands in for the built src/plugins/runner/sandbox.ts chunk: same contract
// (an ES module, on the app's own origin, exporting `startPlugin`), reduced to
// what the protocol needs. Written out rather than built so this runs from a
// clean checkout with no prior `vite build`.
const BOOTSTRAP = `
export function startPlugin(run) {
  const pending = new Map();
  let nextId = 1;
  const call = (op, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    self.postMessage({ t: "call", id, op, params });
  });
  const app = {
    grants: [],
    call,
    async callOrThrow(op, params) {
      const r = await call(op, params);
      if (!r.ok) throw new Error(op + ": " + r.why);
      return r.value;
    },
    log: (...p) => self.postMessage({ t: "log", text: p.join(" ") }),
  };
  self.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.t === "reply") {
      const r = pending.get(m.id);
      if (!r) return;
      pending.delete(m.id);
      r(m.ok ? { ok: true, value: m.value } : { ok: false, code: m.code, why: m.why });
      return;
    }
    if (m.t === "start") {
      app.grants = m.grants || [];
      run(app).then(
        (value) => self.postMessage({ t: "done", value: value === undefined ? null : value }),
        (e) => self.postMessage({ t: "failed", why: String(e && e.message || e) }),
      );
    }
  });
  self.postMessage({ t: "ready" });
}
`;

// The plugin. Inlined into the blob as a function body, exactly as spawn.ts
// does it. It proves it reached the app AND that a refusal is a refusal.
const PLUGIN = `
  app.log("the plugin is running");
  const allowed = await app.call("doc_get");
  const refused = await app.call("doc_new");
  return {
    hasDom: typeof document !== "undefined",
    hasWindow: typeof window !== "undefined",
    allowed: allowed.ok,
    refused: refused.ok === false && refused.code,
    wasm: (() => { try { new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])); return "ok"; }
                   catch (e) { return "BLOCKED"; } })(),
  };
`;

const DRIVER = `
const say = (o) => { document.getElementById("out").textContent = JSON.stringify(o); window.__result = o; };

// The host: the grant check lives here, exactly as src/plugins/runner/host.ts
// has it. The plugin holds document.read and not document.write.
const HELD = new Set(["document.read"]);
const NEEDS = { doc_get: ["document.read"], doc_new: ["document.write"] };

const script = [
  'import { startPlugin } from ' + JSON.stringify(location.origin + "/bootstrap.js") + ';',
  'startPlugin(async function (app) {',
  ${JSON.stringify(PLUGIN)},
  '});',
].join("\\n");

const run = () => new Promise((resolve) => {
  let w;
  const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
  try { w = new Worker(url, { type: "module" }); }
  catch (e) { return resolve({ stage: "spawn", error: String(e.message || e) }); }

  const timer = setTimeout(() => resolve({ stage: "timeout" }), 8000);
  const log = [];
  w.onerror = (e) => { clearTimeout(timer); resolve({ stage: "worker-error", error: e.message || "onerror" }); };
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.t === "ready") { w.postMessage({ t: "start", source: "", grants: [...HELD] }); return; }
    if (m.t === "log") { log.push(m.text); return; }
    if (m.t === "call") {
      const missing = (NEEDS[m.op] || ["nope"]).filter((g) => !HELD.has(g));
      w.postMessage(missing.length
        ? { t: "reply", id: m.id, ok: false, code: "not-granted", why: missing.join(",") }
        : { t: "reply", id: m.id, ok: true, value: { document: "yes" } });
      return;
    }
    if (m.t === "done") { clearTimeout(timer); w.terminate(); resolve({ stage: "done", value: m.value, log }); return; }
    if (m.t === "failed") { clearTimeout(timer); w.terminate(); resolve({ stage: "failed", why: m.why, log }); return; }
  };
});

say(await run());
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>sandbox csp</title>
<body><pre id="out">running</pre><script type="module" src="/driver.js"></script></body>`;

const files = {
  "/": { body: PAGE, type: "text/html" },
  "/driver.js": { body: DRIVER, type: "text/javascript" },
  "/bootstrap.js": { body: BOOTSTRAP, type: "text/javascript" },
};

async function attempt(csp, browser) {
  const server = http.createServer((req, res) => {
    const f = files[req.url.split("?")[0]];
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": f.type, "Content-Security-Policy": csp });
    res.end(f.body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const page = await browser.newPage();
  const refusals = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) refusals.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  let result;
  try {
    await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 20000 });
    result = await page.evaluate(() => window.__result);
  } catch {
    result = { stage: "no-result" };
  }
  await page.close();
  server.close();
  return { result, refusals };
}

function fail(msg) {
  console.error("FAIL " + msg);
  process.exitCode = 1;
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE });

  // --- the real thing, under the shipped policy with 'unsafe-eval' removed ---
  console.log("policy under test (shipped, minus 'unsafe-eval'):");
  console.log("  " + CSP_WITHOUT_EVAL.split(";").map((d) => d.trim())
    .filter((d) => /^(default|script|worker|child)-src/.test(d)).join("; "));

  const { result, refusals } = await attempt(CSP_WITHOUT_EVAL, browser);
  console.log("  result: " + JSON.stringify(result));

  if (result.stage !== "done") {
    fail("the sandbox did not run: " + JSON.stringify(result));
    if (refusals.length) console.error("  " + refusals[0]);
  } else {
    const v = result.value || {};
    if (v.hasDom || v.hasWindow) fail("the sandbox can see the document");
    if (v.allowed !== true) fail("a granted op was refused");
    if (v.refused !== "not-granted") fail("an ungranted op was not refused: " + v.refused);
    if (v.wasm !== "ok") fail("WebAssembly does not compile in the sandbox");
    if (!(result.log || []).includes("the plugin is running")) fail("the plugin's output did not arrive");
    if (process.exitCode !== 1) console.log("OK  the sandbox runs, is empty, and is held to its grants");
  }

  // --- the control ---------------------------------------------------------
  // Without `blob:` in worker-src the Worker cannot be created at all. If this
  // passed, the test above would prove nothing about the policy: it would be
  // measuring a browser that permits everything.
  const noBlob = CSP_WITHOUT_EVAL.replace(/worker-src[^;]*;?\s*/, "");
  const control = await attempt(noBlob, browser);
  if (control.result.stage === "done") {
    fail("CONTROL: the sandbox ran with no worker-src grant, so this test proves nothing");
  } else {
    console.log("OK  control: without worker-src blob: the sandbox is refused (" + control.result.stage + ")");
  }

  await browser.close();
  if (process.exitCode === 1) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
