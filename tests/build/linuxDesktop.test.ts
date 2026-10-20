// The desktop entries a Linux install puts in the app menu. Tauri's own
// template maps "DeveloperTool" to Development; and knows no Graphics
// category, so the deb, rpm and AppImage (built from the deb's data) use
// packaging/fundacad.desktop.hbs, and the Flatpak has its own file.

import { describe, expect, it } from "vitest";

import confRaw from "../../src-tauri/tauri.conf.json?raw";
import template from "../../packaging/fundacad.desktop.hbs?raw";
import flatpakDesktop from "../../packaging/flatpak/dev.fundacad.app.desktop?raw";

const conf = JSON.parse(confRaw);
const line = (text: string, key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];

describe("the Linux desktop entries", () => {
  it("are what the deb and rpm are built with", () => {
    for (const pkg of ["deb", "rpm"]) {
      expect(conf.bundle.linux[pkg].desktopTemplate, pkg).toBe("../packaging/fundacad.desktop.hbs");
    }
  });

  it("put FundaCAD under Graphics, not Programming", () => {
    for (const text of [template, flatpakDesktop]) {
      expect(line(text, "Categories")).toBe("Graphics;3DGraphics;Engineering;");
    }
  });

  it("keep the window class the window really has", () => {
    expect(line(template, "StartupWMClass")).toBe("{{exec}}");
    expect(line(flatpakDesktop, "StartupWMClass")).toBe("fundacad");
  });
});
