// The test job scans the tree for secrets with a gitleaks release checked by sha256, and asks GitHub whether
// every action pin is the commit its tag comment names, both before any dependency is installed.

import { describe, expect, it } from "vitest";

import buildRaw from "../../.github/workflows/build.yml?raw";

const build = buildRaw.replace(/\r\n/g, "\n");

function job(name: string): string {
  const lines = build.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end] ?? "")) end++;
  return lines.slice(start, end).join("\n");
}

const test = job("test");
const steps = test.split(/\n {6}- /).slice(1);
const named = (name: string) => steps.findIndex((s) => s.startsWith(`name: ${name}\n`));
const firstInstall = steps.findIndex((s) => /\bnpm ci\b|uses: actions\/setup-node@/.test(s));

describe("the CI scans in the test job", () => {
  it("runs gitleaks from a tagged release only after its sha256 matches, with the repo config", () => {
    const i = named("Secret scan (gitleaks)");
    expect(i).toBeGreaterThanOrEqual(0);
    const step = steps[i] ?? "";
    const url = step.match(/https:\/\/\S+/g) ?? [];
    expect(url).toHaveLength(1);
    expect(url[0]).toMatch(
      /^https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v\d+\.\d+\.\d+\/[^/]+_linux_x64\.tar\.gz$/,
    );
    const check = step.search(/echo "[0-9a-f]{64}  \S+" \| sha256sum -c -/);
    expect(check).toBeGreaterThan(0);
    expect(step.indexOf("tar -xzf")).toBeGreaterThan(check);
    expect(step).toMatch(/gitleaks" dir \. --config \.gitleaks\.toml/);
    expect(step).toMatch(/^\s+set -eu$/m);
  });

  it("checks every action pin against GitHub with the job's own read only token", () => {
    const i = named("Action pins match their tags");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(steps[i]).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(steps[i]).toMatch(/run: node scripts\/verify-action-pins\.mjs$/m);
    expect(test).not.toMatch(/^ {4}permissions:/m);
  });

  it("runs both scans before any dependency is installed", () => {
    const scans = [named("Secret scan (gitleaks)"), named("Action pins match their tags")];
    expect(Math.min(...scans)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...scans)).toBeLessThan(firstInstall);
  });
});
