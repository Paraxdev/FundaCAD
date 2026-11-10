// GitHub retires runner images on a schedule, and a retired label fails its job at once. On main the
// macOS bundle gates the release, so a label past its date stops every beta.

import { describe, expect, it } from "vitest";

import buildWorkflow from "../../.github/workflows/build.yml?raw";

function job(name: string): string {
  const lines = buildWorkflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${name}:`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the build workflow's runners", () => {
  it("uses no macOS image GitHub has retired", () => {
    expect(buildWorkflow).not.toMatch(/macos-1[0-4]\b/);
  });

  it("builds the macOS bundle, signs it, and runs the macOS tracer on one label", () => {
    expect(job("bundle")).toMatch(/- platform: macos-15\b/);
    expect(job("bundle")).toContain("matrix.platform == 'macos-15'");
    expect(job("tracer-macos")).toMatch(/runs-on: macos-15\r?$/m);
  });

  it("builds OpenCASCADE again when the macOS image changes, and leaves the other caches alone", () => {
    expect(job("bundle")).toContain("occt-static-v2-${{ runner.os == 'macOS' && matrix.platform || runner.os }}-");
  });

  it("holds the bundle to the macOS version the app promises", () => {
    expect(job("bundle")).toMatch(/MACOSX_DEPLOYMENT_TARGET: "11\.0"/);
    expect(job("bundle")).toContain("Check the macOS version the app needs");
    expect(job("bundle")).toMatch(/vtool -show-build/);
  });

  it("runs the heavy tests and the accessibility smoke beside e2e, each in exactly one job", () => {
    expect(job("e2e")).toContain('-m "smoke and not a11y and not heavy"');
    expect(job("e2e")).not.toMatch(/-m a11y\b/);
    expect(job("e2e-heavy")).toContain('-m "smoke and heavy"');
    expect(job("e2e-heavy")).toMatch(/needs: rust-geom\r?$/m);
    expect(job("e2e-a11y")).toContain("-m a11y -q");
    expect(job("e2e-a11y")).toMatch(/needs: rust-geom\r?$/m);
  });

  it("gives e2e room for a slow runner, whose setup alone took up to 30 minutes", () => {
    const minutes = Number(/^ {4}timeout-minutes: (\d+)/m.exec(job("e2e"))?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(75);
  });

  it("gives the accessibility smoke the 34 minutes or so a slow runner needs, with room for the job's setup", () => {
    const a11y = job("e2e-a11y");
    const jobMinutes = Number(/^ {4}timeout-minutes: (\d+)/m.exec(a11y)?.[1]);
    const stepMinutes = Number(/name: Accessibility smoke \(axe[^\n]*\n {8}timeout-minutes: (\d+)/.exec(a11y)?.[1]);
    expect(stepMinutes).toBeGreaterThanOrEqual(40);
    expect(jobMinutes).toBeGreaterThanOrEqual(stepMinutes + 15);
  });
});
