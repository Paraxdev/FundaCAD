// The installers are started, not only read, before anything ships them.
//
// The bundle legs used to grep the built binary for two strings and upload it.
// A package that cannot start passes that grep, so a missing WebKit or GTK
// reached users before it reached CI. scripts/bundle-smoke.py starts each
// package as its MCP server and builds a box through the engine inside it;
// this holds the steps that run it in place, in the order that makes them mean
// something, with the gating docs/ENGINE.md section 7 describes.

import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";

type Step = { name: string; text: string };

function job(text: string, name: string): string {
  const start = text.search(new RegExp(`^  ${name}:$`, "m"));
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const end = rest.search(/^ {2}[a-z][a-z0-9-]*:$/m);
  return end < 0 ? rest : rest.slice(0, end);
}

function steps(jobText: string): Step[] {
  return jobText
    .split(/^ {6}- /m)
    .slice(1)
    .map((text) => ({ name: /name: (.*)/.exec(text)?.[1]?.trim() ?? "", text }));
}

const GATE = "continue-on-error: ${{ needs.channel.outputs.gated == 'false' }}";
const runsSmoke = (s: Step) => /scripts\/bundle-smoke\.py/.test(s.text);
const indexOf = (all: Step[], name: string) => {
  const i = all.findIndex((s) => s.name === name);
  expect(i, `step "${name}"`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("the bundle job", () => {
  const all = steps(job(workflow, "bundle"));

  it("starts what it built on every platform", () => {
    const smokes = all.filter(runsSmoke);
    expect(smokes.some((s) => /if: matrix\.platform == 'ubuntu-22\.04'/.test(s.text))).toBe(true);
    expect(smokes.some((s) => /if: matrix\.platform != 'ubuntu-22\.04'/.test(s.text))).toBe(true);
  });

  it("starts the AppImage, the .deb's binary and the Windows exe with --mcp", () => {
    const text = all.filter(runsSmoke).map((s) => s.text).join("\n");
    expect(text).toMatch(/\.AppImage/);
    expect(text).toMatch(/--appimage-extract-and-run/);
    expect(text).toMatch(/dpkg-deb -x/);
    expect(text).toMatch(/fundacad\.exe/);
    expect(text).toMatch(/--mcp/);
  });

  it("starts them after the packages are rewritten and before they upload", () => {
    const after = indexOf(all, "Depend on the renamed GTK package (deb)");
    const upload = indexOf(all, "Upload artifacts");
    for (const [i, s] of all.entries()) {
      if (!runsSmoke(s) || /continue-on-error: true/.test(s.text)) continue;
      expect(i, s.name).toBeGreaterThan(after);
      expect(i, s.name).toBeLessThan(upload);
    }
  });

  it("holds the beta on a red smoke and lets the development build ship", () => {
    const gating = all.filter((s) => runsSmoke(s) && !/continue-on-error: true/.test(s.text));
    expect(gating.length).toBeGreaterThanOrEqual(2);
    for (const s of gating) expect(s.text, s.name).toContain(GATE);
  });
});

describe("the Flatpak job", () => {
  const all = steps(job(workflow, "build-flatpak"));

  it("runs the installed Flatpak before it uploads it", () => {
    const i = all.findIndex(runsSmoke);
    expect(i).toBeGreaterThanOrEqual(0);
    const smoke = all[i]?.text ?? "";
    expect(smoke).toMatch(/flatpak run [^\n]*dev\.fundacad\.app --mcp/);
    expect(i).toBeGreaterThan(indexOf(all, "Build the Flatpak"));
    expect(i).toBeLessThan(indexOf(all, "Upload the Flatpak"));
    expect(smoke).toContain(GATE);
  });
});

describe("the test job", () => {
  it("runs the smoke driver's own tests", () => {
    const all = steps(job(workflow, "test"));
    expect(all.some((s) => /python3 tests\/build\/test_bundle_smoke\.py/.test(s.text))).toBe(true);
  });
});
