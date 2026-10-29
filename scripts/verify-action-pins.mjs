// Asks GitHub whether each pinned commit is what its comment says: the commit the tag points to, or one on the branch.
// It needs gh and the network, which the offline tests have neither of, so run it on any change to a pin.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { BRANCH_PINS, pins } from "./actionPins.mjs";

const files = {};
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.ya?ml$/.test(entry.name)) files[full.split(path.sep).join("/")] = readFileSync(full, "utf8");
  }
};
walk(".github");

const api = (route, jq) => execFileSync("gh", ["api", route, "--jq", jq], { encoding: "utf8" }).trim();

const seen = new Set();
let bad = 0;
for (const p of pins(files)) {
  const key = `${p.repo}@${p.sha} ${p.ref}`;
  if (seen.has(key)) continue;
  seen.add(key);
  let ok;
  try {
    // A branch only has to contain the commit: it moves on after the pin, which Dependabot then follows.
    ok =
      BRANCH_PINS[p.repo] === p.ref
        ? ["ahead", "identical"].includes(api(`repos/${p.repo}/compare/${p.sha}...${p.ref}`, ".status"))
        : api(`repos/${p.repo}/commits/${p.ref}`, ".sha") === p.sha;
  } catch {
    ok = false;
  }
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BAD "} ${key} (${p.where})`);
}
console.log(`${seen.size} pins, ${bad} wrong`);
process.exit(bad ? 1 : 0);
