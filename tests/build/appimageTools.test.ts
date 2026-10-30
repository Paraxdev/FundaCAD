// The AppImage packers and their runtime come from tagged releases, each checked against a sha256 in the repo.

import { describe, expect, it } from "vitest";

import pins from "../../packaging/appimage-tools.sha256?raw";
import unbundle from "../../.github/actions/appimage-unbundle/action.yml?raw";
import build from "../../.github/workflows/build.yml?raw";

const entries = pins
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split(/\s+/));

const fetchStart = build.indexOf("- name: Fetch the AppImage tools (Linux)");
const fetchStep = fetchStart < 0 ? "" : build.slice(fetchStart, build.indexOf("\n      - ", fetchStart + 1));

describe("the pinned AppImage tools", () => {
  it("pins every tool the AppImage build uses to a tagged release or commit with a sha256", () => {
    const files = entries.map((e) => e[1]).sort();
    expect(files).toEqual(
      [
        "AppRun-x86_64",
        "appimagetool-x86_64.AppImage",
        "linuxdeploy-plugin-appimage-x86_64.AppImage",
        "linuxdeploy-plugin-gstreamer.sh",
        "linuxdeploy-plugin-gtk.sh",
        "linuxdeploy-x86_64.AppImage",
        "runtime-x86_64",
      ].sort(),
    );
    for (const [sha, file, url] of entries) {
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect(url).toMatch(/^https:\/\//);
      expect(url?.endsWith(`/${file}`)).toBe(true);
      expect(url).not.toMatch(/\/(continuous|latest|master|main)\//);
    }
  });

  it("downloads no tool from a moving release", () => {
    for (const text of [build, unbundle]) {
      expect(text).not.toMatch(/releases\/download\/continuous\//);
      expect(text).not.toMatch(/releases\/latest\//);
    }
  });

  it("checks every download against the pin file before anything runs it", () => {
    expect(fetchStart).toBeGreaterThan(-1);
    expect(fetchStart).toBeGreaterThan(-1);
    expect(fetchStep).toContain("packaging/appimage-tools.sha256");
    const check = fetchStep.indexOf("sha256sum -c");
    expect(check).toBeGreaterThan(-1);
    for (const use of ["install -m755", "LDAI_RUNTIME_FILE=", "APPIMAGETOOL="]) {
      const at = fetchStep.indexOf(use);
      expect(at, use).toBeGreaterThan(check);
    }
  });

  it("seeds the bundler's tool cache under the names it looks for", () => {
    for (const name of [
      "AppRun-x86_64",
      "linuxdeploy-x86_64.AppImage",
      "linuxdeploy-plugin-gtk.sh",
      "linuxdeploy-plugin-gstreamer.sh",
      "linuxdeploy-plugin-appimage.AppImage",
    ]) {
      expect(fetchStep, name).toContain(`"$cache/${name}"`);
    }
  });

  it("repacks with the checked appimagetool and runtime, never a fresh download", () => {
    expect(unbundle).not.toMatch(/\bcurl\b|\bwget\b/);
    expect(unbundle).toContain('"$APPIMAGETOOL" --appimage-extract-and-run');
    expect(unbundle).toContain('--runtime-file "$LDAI_RUNTIME_FILE"');
    expect(unbundle).not.toContain("${LDAI_RUNTIME_FILE:+");
  });
});
