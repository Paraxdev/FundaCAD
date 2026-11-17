// The Flatpak and AppImage jobs start the app under headless Wayland. A new GUI smoke can be flaky,
// so each step stays continue-on-error until it has run green on dev. The script's own tests run
// against a fake cage and cannot flake that way, so they gate.

import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";

function jobSteps(name: string) {
  const job = new RegExp(String.raw`^ {2}${name}:\r?\n([\s\S]*?)(?=^ {2}\S)`, "m").exec(workflow)?.[1] ?? "";
  return job
    .split(/^ {6}- /m)
    .slice(1)
    .map((text) => ({ name: /name: (.*)/.exec(text)?.[1]?.trim() ?? "", text }));
}

describe("the Wayland smoke script's own tests", () => {
  it("gate the test job", () => {
    const step = jobSteps("test").find((s) => s.text.includes("python3 tests/build/test_wayland_smoke.py"));
    expect(step).toBeDefined();
    expect(step?.text).not.toMatch(/continue-on-error/);
  });
});

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

  it("checks the app's own log too, since the app moves its output there once it starts", () => {
    expect(smoke?.text).toMatch(
      /SMOKE_APP_LOG="\$HOME\/\.var\/app\/dev\.fundacad\.app\/data\/dev\.fundacad\.app\/logs\/fundacad\.log"/,
    );
  });

  it("names a portal backend, so GTK finds the Settings portal a desktop has", () => {
    expect(smoke?.text).toMatch(/default=gtk[^\n]*> ~\/\.config\/xdg-desktop-portal\/portals\.conf/);
  });

  it("leaves the session bus to the smoke script, since dbus-run-session ends it when the app restarts", () => {
    expect(smoke?.text).not.toMatch(/dbus-run-session/);
  });

  it("stops the sandbox when the step ends, since bwrap takes it out of the smoke's process group", () => {
    expect(smoke?.text).toMatch(/trap 'flatpak kill dev\.fundacad\.app[^']*' EXIT[\s\S]*scripts\/wayland-smoke\.sh/);
  });

  it("waits long enough for the stall restart and the second start", () => {
    const secs = Number(/SMOKE_SECONDS=(\d+)/.exec(smoke?.text ?? "")?.[1]);
    expect(secs).toBeGreaterThanOrEqual(40);
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

  it("installs Xwayland beside cage, which the cage on 22.04 needs to start at all", () => {
    expect(smoke?.text).toMatch(/apt-get install[^\n]*\bcage\b[^\n]*\bxwayland\b/);
  });

  it("checks the app's own log in the data folder it gives the app", () => {
    expect(smoke?.text).toMatch(
      /XDG_DATA_HOME="\$data" SMOKE_APP_LOG="\$data\/dev\.fundacad\.app\/logs\/fundacad\.log"/,
    );
  });

  it("leaves the session bus to the smoke script, as the Flatpak leg does", () => {
    expect(smoke?.text).not.toMatch(/dbus-run-session/);
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
