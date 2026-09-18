#!/usr/bin/env node
// The `fundacad` entry in .mcp.json: runs a fundacad-mcp that is already
// built, or exits at once saying how to build it. `cargo run` was the entry
// before, and a first compile outlasts an MCP host's 30 s connect timeout, which
// the host reports as a timeout with no hint of the cause.
//
// Build once, from the repository root:
//   cargo build --release -p fundacad-mcp -p fundacad-cli
// fundacad-cli is the `fundacad-engine` its private mode starts, and needs
// OpenCASCADE (FUNDACAD_OCCT_ROOT, docs/ENGINE.md). Attaching to a running
// app needs only fundacad-mcp.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? ".exe" : "";
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(repo, "target");

const built = ["release", "debug"]
  .map((profile) => join(target, profile, `fundacad-mcp${exe}`))
  .filter((p) => existsSync(p))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

if (built.length === 0) {
  process.stderr.write(
    `fundacad-mcp is not built (looked in ${join(target, "release")} and ${join(target, "debug")}).\n` +
      "Build it once from the repository root, then reconnect:\n" +
      "  cargo build --release -p fundacad-mcp -p fundacad-cli\n",
  );
  process.exit(1);
}

const child = spawn(built[0], process.argv.slice(2), { stdio: "inherit" });
child.on("error", (e) => {
  process.stderr.write(`cannot start ${built[0]}: ${e.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
