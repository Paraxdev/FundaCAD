// The Flatpak runs on native Wayland with an X11 fallback, and reaches input devices and the
// spacenavd socket instead of every device node on the host.

import { describe, expect, it } from "vitest";

import release from "../../packaging/flatpak/dev.fundacad.app.yml?raw";
import sourceCheck from "../../packaging/flatpak/source-check/fundacad-source-check.yml?raw";

function finishArgs(manifest: string): string[] {
  const lines = manifest.split(/\r?\n/);
  const start = lines.indexOf("finish-args:");
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

describe.each([
  ["release", release],
  ["source check", sourceCheck],
])("the %s manifest's finish-args", (_name, manifest) => {
  const args = finishArgs(manifest);

  it("are found", () => {
    expect(args.length).toBeGreaterThan(0);
  });

  it("ask for Wayland with an X11 fallback, and do not force X11", () => {
    expect(args).toContain("--socket=wayland");
    expect(args).toContain("--socket=fallback-x11");
    expect(args).not.toContain("--socket=x11");
    expect(args.filter((a) => a.includes("GDK_BACKEND"))).toEqual([]);
  });

  it("ask for the GPU, input devices and the spacenavd socket, not every device", () => {
    expect(args).not.toContain("--device=all");
    expect(args).toContain("--device=dri");
    expect(args).toContain("--device=input");
    expect(args).toContain("--filesystem=/run/spnav.sock:ro");
  });
});
