// appimagetool comes from its continuous release, whose builds since 2026-10-29 refuse an AppDir
// that other users cannot read, and the extracted tree has 0700 directories.

import { describe, expect, it } from "vitest";

import action from "../../.github/actions/appimage-unbundle/action.yml?raw";

const lines = action.split(/\r?\n/).map((l) => l.trim());

describe("the AppImage repack", () => {
  it("makes the AppDir readable by every user before appimagetool packs it", () => {
    const chmod = lines.indexOf('chmod -R a+rX "$root"');
    const pack = lines.findIndex((l) => l.startsWith('ARCH=x86_64 "$work/appimagetool"'));
    expect(pack).toBeGreaterThan(-1);
    expect(chmod).toBeGreaterThan(-1);
    expect(chmod).toBeLessThan(pack);
  });

  it("drops the GTK hook's GDK_BACKEND=x11 and fails if a hook still sets it", () => {
    const strip = lines.findIndex(
      (l) => l.startsWith("sed -i") && l.includes("GDK_BACKEND") && l.includes("apprun-hooks/"),
    );
    const check = lines.findIndex((l) => l.includes("grep") && l.includes("GDK_BACKEND") && l.includes("apprun-hooks/"));
    const pack = lines.findIndex((l) => l.startsWith('ARCH=x86_64 "$work/appimagetool"'));
    expect(strip).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(strip);
    expect(check).toBeLessThan(pack);
  });
});
