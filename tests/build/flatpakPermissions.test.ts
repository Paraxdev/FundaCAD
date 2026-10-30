// The Flatpak runs on native Wayland with an X11 fallback, and reaches input devices and the
// spacenavd socket instead of every device node on the host.

import { describe, expect, it } from "vitest";

import release from "../../packaging/flatpak/dev.fundacad.app.yml?raw";
import sourceCheck from "../../packaging/flatpak/source-check/fundacad-source-check.yml?raw";
import buildWorkflow from "../../.github/workflows/build.yml?raw";
import sourceWorkflow from "../../.github/workflows/flatpak-source.yml?raw";

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

// Flatpak 1.14, the Ubuntu 24.04 package, refuses --device=input in build-finish.
describe.each([
  ["build", buildWorkflow],
  ["flatpak-source", sourceWorkflow],
])("the %s workflow", (_name, workflow) => {
  it("installs Flatpak from the upstream PPA before flatpak-builder runs", () => {
    const ppa = workflow.indexOf("add-apt-repository -y -n ppa:flatpak/stable");
    const install = workflow.indexOf("apt-get install -y -qq flatpak flatpak-builder");
    expect(ppa).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(ppa);
  });
});
