// CI builds and tests resolve crates from the checked in lockfiles, the ones the advisory gate reads.

import { describe, expect, it } from "vitest";

import build from "../../.github/workflows/build.yml?raw";

const code = build
  .split(/\r?\n/)
  .map((l) => l.replace(/^\s*#.*$/, ""))
  .join("\n");

const cargoRuns = [...code.matchAll(/\bcargo (build|test|run)\b[^\n]*/g)].map((m) => m[0]);

describe("cargo in build.yml", () => {
  it("finds the cargo build and test steps", () => {
    expect(cargoRuns.length).toBeGreaterThanOrEqual(10);
  });

  it("passes --locked to every cargo build, test and run", () => {
    expect(cargoRuns.filter((l) => !/\s--locked\b/.test(l.split(" -- ")[0] ?? ""))).toEqual([]);
  });

  it("passes --locked through tauri-action to the release cargo build", () => {
    const args = [...code.matchAll(/^\s*args: (.*)$/gm)].map((m) => (m[1] ?? "").trim());
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) expect(a).toMatch(/ -- --locked$/);
  });
});
