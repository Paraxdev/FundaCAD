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
    const check = lines.findIndex(
      (l) => l.includes("grep") && l.includes("GDK_BACKEND") && l.includes("apprun-hooks/"),
    );
    const pack = lines.findIndex((l) => l.startsWith('ARCH=x86_64 "$work/appimagetool"'));
    expect(strip).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(strip);
    expect(check).toBeLessThan(pack);
  });

  it("fails only on a line that still assigns GDK_BACKEND, not on a comment or a test of it", () => {
    const sed = /sed -i '\/(.+)\/d' "\$root"\/apprun-hooks\/\*\.sh/.exec(action)?.[1] ?? "";
    const guard = /grep -nE '([^']+)' "\$root"\/AppRun "\$root"\/apprun-hooks\/\*\.sh/.exec(action)?.[1] ?? "";
    const strips = new RegExp(sed.replace("[[:space:]]", "\\s"));
    const sets = new RegExp(guard);
    // The tauri-apps linuxdeploy-plugin-gtk hook as of 2026-10, plus forms a later version could use.
    const hook = [
      'export GTK_THEME="$APPIMAGE_GTK_THEME" # Custom themes are broken',
      "export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland",
      'export XDG_DATA_DIRS="$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS"',
      "# GDK_BACKEND=x11 used to be forced here",
      '[ -z "${GDK_BACKEND:-}" ] && echo unset',
      "unset GDK_BACKEND",
      'GDK_BACKEND=x11 exec "$@"',
      '    : "${GDK_BACKEND:=x11}"',
    ];
    expect(hook.filter((l) => sets.test(l))).toEqual([hook[1], hook[6], hook[7]]);
    expect(hook.filter((l) => !strips.test(l)).filter((l) => sets.test(l))).toEqual([hook[6], hook[7]]);
  });
});
