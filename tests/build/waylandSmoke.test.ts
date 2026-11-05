// The Flatpak and AppImage jobs start the app under headless Wayland. A new GUI smoke can be flaky,
// so each step stays continue-on-error until it has run green on dev.

import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";

function jobSteps(name: string) {
  const job = new RegExp(String.raw`^ {2}${name}:\r?\n([\s\S]*?)(?=^ {2}\S)`, "m").exec(workflow)?.[1] ?? "";
  return job
    .split(/^ {6}- /m)
    .slice(1)
    .map((text) => ({ name: /name: (.*)/.exec(text)?.[1]?.trim() ?? "", text }));
}

describe("the Flatpak job's Wayland smoke", () => {
  const steps = jobSteps("build-flatpak");
  const smoke = steps.find((s) => s.text.includes("scripts/wayland-smoke.sh"));

  it("runs the installed Flatpak through the smoke script", () => {
    expect(smoke?.text).toMatch(
      /sh scripts\/wayland-smoke\.sh "\$RUNNER_TEMP\/[^"]+"[\s\S]*flatpak run[^\n]*dev\.fundacad\.app/,
    );
  });

  it("passes the protocol log switch into the sandbox, since the smoke reads that log", () => {
    expect(smoke?.text).toMatch(/flatpak run --env=WAYLAND_DEBUG=client dev\.fundacad\.app/);
  });

  it("installs cage first", () => {
    expect(smoke?.text).toMatch(/apt-get install[^\n]*\bcage\b/);
  });

  it("does not gate the job yet", () => {
    expect(smoke?.text).toMatch(/^ {8}continue-on-error: true\r?$/m);
  });

  it("comes after the Flatpak is installed", () => {
    const build = steps.findIndex((s) => s.text.includes("flatpak install --user"));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(smoke!)).toBeGreaterThan(build);
  });
});

describe("the AppImage job's Wayland smoke", () => {
  const steps = jobSteps("bundle");
  const smoke = steps.find((s) => s.text.includes("scripts/wayland-smoke.sh"));

  it("runs the repacked AppImage through the smoke script on the Linux leg", () => {
    expect(smoke?.text).toMatch(/^ {8}if: matrix\.platform == 'ubuntu-22\.04'\r?$/m);
    expect(smoke?.text).toMatch(/apt-get install[^\n]*\bcage\b/);
    expect(smoke?.text).toMatch(/sh scripts\/wayland-smoke\.sh "\$RUNNER_TEMP\/[^"]+"[\s\S]*"\$img"/);
  });

  it("does not gate the job yet", () => {
    expect(smoke?.text).toMatch(/^ {8}continue-on-error: true\r?$/m);
    expect(smoke?.text).toMatch(/^ {8}timeout-minutes: \d+\r?$/m);
  });

  it("comes after the GTK hook's X11 line is stripped", () => {
    const unbundle = steps.findIndex((s) => s.text.includes("./.github/actions/appimage-unbundle"));
    expect(unbundle).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(smoke!)).toBeGreaterThan(unbundle);
  });
});
