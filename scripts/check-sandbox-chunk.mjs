// Does the BUILT plugin sandbox still contain the thing the generated script
// calls?
//
// Nothing else can answer that. The unit tests hold the two source files
// against each other and pass; the CSP e2e runs an equivalent bootstrap it
// writes itself and passes; and in between them sits the bundler, which is what
// actually broke.
//
// WHAT BROKE. src/plugins/runner/sandbox.ts is built by Vite as a worker ENTRY.
// A worker entry has no importers, so Rollup treats every export as unreachable
// and drops it. The first build of this produced a 0.37 kB chunk holding the
// op-name array and nothing else, and the blob's first line would have been an
// import of a name that was not there. It is now registered on the Worker
// global by a top-level assignment, which a bundler must keep, and this checks
// that it survived.
//
// Usage (after `vite build`, or it will run one):
//   node scripts/check-sandbox-chunk.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "dist", "assets");

// Read out of the source rather than restated, so renaming it cannot make this
// test pass against a chunk that no longer matches the script.
const PROTOCOL = readFileSync(join(ROOT, "src/plugins/runner/protocol.ts"), "utf8");
const START = PROTOCOL.match(/export const START = "([^"]+)"/)?.[1];

let failed = false;
const fail = (msg) => {
  console.error("FAIL " + msg);
  failed = true;
};

if (!START) fail("could not read START out of src/plugins/runner/protocol.ts");

if (!existsSync(ASSETS)) {
  console.log("no dist/assets, building…");
  execFileSync("npx", ["vite", "build"], { cwd: ROOT, stdio: "inherit", shell: true });
}

const chunks = readdirSync(ASSETS).filter((f) => /^sandbox-.*\.js$/.test(f));
if (chunks.length !== 1) {
  fail(`expected exactly one sandbox chunk in dist/assets, found ${chunks.length}`);
} else {
  const src = readFileSync(join(ASSETS, chunks[0]), "utf8");

  if (!src.includes(START)) {
    fail(`the built sandbox chunk (${chunks[0]}) does not register ${START}. ` +
      "The generated worker script calls it and would fail on its first line.");
  }

  // The chunk has to be a real module with the guest in it, not the husk
  // tree-shaking left last time. These are strings the guest protocol uses and
  // cannot be optimised away while the code that reads them survives.
  for (const needed of ['"ready"', '"call"', '"done"', '"failed"']) {
    if (!src.includes(needed)) {
      fail(`the built sandbox chunk has no ${needed} in it, so the guest was tree-shaken out`);
    }
  }

  // The control for every check above: a chunk that was somehow the whole app
  // would contain all of it and prove nothing. This one is a few kB.
  if (src.length > 200_000) {
    fail(`the sandbox chunk is ${src.length} bytes, which is not a sandbox`);
  }
  if (src.length < 500) {
    fail(`the sandbox chunk is ${src.length} bytes, which is the husk this check exists for`);
  }

  if (!failed) {
    console.log(`OK  ${chunks[0]} (${src.length} bytes) registers ${START}`);
  }
}

process.exit(failed ? 1 : 0);
