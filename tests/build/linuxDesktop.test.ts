// The desktop entries a Linux install puts in the app menu. Tauri's own
// template maps "DeveloperTool" to Development; and knows no Graphics
// category, so the deb, rpm and AppImage (built from the deb's data) use
// packaging/fundacad.desktop.hbs, and the Flatpak has its own file.

import { describe, expect, it } from "vitest";

import confRaw from "../../src-tauri/tauri.conf.json?raw";
import template from "../../packaging/fundacad.desktop.hbs?raw";
import flatpakDesktop from "../../packaging/flatpak/dev.fundacad.app.desktop?raw";
import flatpakManifest from "../../packaging/flatpak/dev.fundacad.app.yml?raw";
import mimeXml from "../../packaging/dev.fundacad.app.mime.xml?raw";

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

  // A file manager offers FundaCAD for a document only when a MIME type names
  // the extension and the entry both claims that type and takes the file (%F).
  it("open a .funda or .fundab a file manager hands them", () => {
    const types = "application/x-fundacad;application/x-fundacad-bundle;";
    expect(line(template, "Exec")).toBe("{{exec}} %F");
    expect(line(flatpakDesktop, "Exec")).toBe("fundacad %F");
    expect(line(template, "MimeType")).toBe(types);
    expect(line(flatpakDesktop, "MimeType")).toBe(types);
    expect(mimeXml).toMatch(/<mime-type type="application\/x-fundacad">[\s\S]*?<glob pattern="\*\.funda"\/>/);
    expect(mimeXml).toMatch(/<mime-type type="application\/x-fundacad-bundle">[\s\S]*?<glob pattern="\*\.fundab"\/>/);
    for (const pkg of ["deb", "rpm"]) {
      expect(conf.bundle.linux[pkg].files["/usr/share/mime/packages/dev.fundacad.app.xml"], pkg).toBe("../packaging/dev.fundacad.app.mime.xml");
    }
    expect(flatpakManifest).toMatch(/install -Dm644 \S+ \/app\/share\/mime\/packages\/dev\.fundacad\.app\.xml/);
  });

  // The bundler files each PNG under hicolor by its pixel size, so a size
  // missing here is one the desktop scales up from a smaller icon.
  it("ship the app icon at every size a menu, dock or launcher asks for", () => {
    for (const icon of ["icons/32x32.png", "icons/64x64.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png"]) {
      expect(conf.bundle.icon, icon).toContain(icon);
    }
    expect(conf.bundle.icon[0], "the window icon is the first PNG").toBe("icons/32x32.png");
    for (const size of ["32x32", "64x64", "128x128", "256x256", "512x512"]) {
      expect(flatpakManifest).toContain(`/app/share/icons/hicolor/${size}/apps/dev.fundacad.app.png`);
    }
    expect(flatpakManifest).toContain("/app/share/icons/hicolor/scalable/apps/dev.fundacad.app.svg");
  });
});
