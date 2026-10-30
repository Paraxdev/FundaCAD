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

  it("gives e2e enough time to reach the accessibility step", () => {
    const minutes = Number(/timeout-minutes: (\d+)/.exec(job("e2e"))?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(60);
  });
});
