// Checks the built sandbox chunk still registers START. Rollup treats a worker entry's exports as unreachable and once
// shipped a 0.37 kB husk, so sandbox.ts registers START on the Worker global by a top level assignment.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "dist", "assets");

// Read from the source so a rename cannot make this pass against a chunk that no longer matches.
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
    fail(
      `the built sandbox chunk (${chunks[0]}) does not register ${START}. ` +
        "The generated worker script calls it and would fail on its first line.",
    );
  }

  // Strings the guest protocol uses, which survive only while the guest code does.
  for (const needed of ['"ready"', '"call"', '"done"', '"failed"']) {
    if (!src.includes(needed)) {
      fail(`the built sandbox chunk has no ${needed} in it, so the guest was tree-shaken out`);
    }
  }

  // A chunk holding the whole app would prove nothing, and this one is a few kB.
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
