// appimagetool builds since 2026-10-29 refuse an AppDir that other users cannot read,
// and the extracted tree has 0700 directories.

import { describe, expect, it } from "vitest";

import action from "../../.github/actions/appimage-unbundle/action.yml?raw";

const lines = action.split(/\r?\n/).map((l) => l.trim());

describe("the AppImage repack", () => {
  it("makes the AppDir readable by every user before appimagetool packs it", () => {
    const chmod = lines.indexOf('chmod -R a+rX "$root"');
    const pack = lines.findIndex((l) => l.startsWith('ARCH=x86_64 "$APPIMAGETOOL"'));
    expect(pack).toBeGreaterThan(-1);
    expect(chmod).toBeGreaterThan(-1);
    expect(chmod).toBeLessThan(pack);
  });
});
