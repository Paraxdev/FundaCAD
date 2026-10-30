// The Flatpak job starts the installed app under headless Wayland. A new GUI smoke can be flaky,
// so the step stays continue-on-error until it has run green on dev.

import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";

const job = /^ {2}build-flatpak:\r?\n([\s\S]*?)(?=^ {2}\S)/m.exec(workflow)?.[1] ?? "";
const steps = job
  .split(/^ {6}- /m)
  .slice(1)
  .map((text) => ({ name: /name: (.*)/.exec(text)?.[1]?.trim() ?? "", text }));
const smoke = steps.find((s) => s.text.includes("scripts/wayland-smoke.sh"));

describe("the Flatpak job's Wayland smoke", () => {
  it("runs the installed Flatpak through the smoke script", () => {
    expect(smoke?.text).toMatch(/sh scripts\/wayland-smoke\.sh "\$RUNNER_TEMP\/[^"]+"[\s\S]*flatpak run[^\n]*dev\.fundacad\.app/);
  });

  it("installs cage first", () => {
    expect(smoke?.text).toMatch(/apt-get install[^\n]*\bcage\b/);
  });

  it("does not gate the job yet", () => {
    expect(smoke?.text).toMatch(/^ {8}continue-on-error: true$/m);
  });

  it("comes after the Flatpak is installed", () => {
    const build = steps.findIndex((s) => s.text.includes("flatpak install --user"));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(smoke!)).toBeGreaterThan(build);
  });
});
