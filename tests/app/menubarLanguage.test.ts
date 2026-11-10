import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { buildMenubar } from "../../src/app/menubarDef";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import { menuName, menuText, type MenuDef } from "../../src/ui/menu";
import { setLanguage } from "../../src/i18n";
import type { Engine } from "../../src/app/engine";

const build = () => buildMenubar({ ui: { home: { open: () => {} } } } as unknown as Engine);
const texts = (m: MenuDef[]) => m.map(menuText);
const names = (m: MenuDef[]) => m.map(menuName);
const row = (label: string) => ({ label, onClick: () => {} });

beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  resetContributions();
  await setLanguage("system");
});

describe("top menu names under a language", () => {
  it("show German texts over the English names", async () => {
    await setLanguage("de");
    const menus = build();
    expect(texts(menus)).toEqual(["Datei", "Bearbeiten", "Ansicht", "Hilfe"]);
    expect(names(menus)).toEqual(["File", "Edit", "View", "Help"]);
  });

  it("read English again after switching back", async () => {
    await setLanguage("de");
    const menus = build();
    await setLanguage("system");
    expect(texts(menus)).toEqual(["File", "Edit", "View", "Help"]);
  });

  it("send a plugin row naming Help into Hilfe, one or many", async () => {
    await setLanguage("de");
    contribute("P.One", { menus: [{ menu: "Help", items: [row("Tour")] }] });
    expect(build().find((m) => menuName(m) === "Help")!.items.map((i) => i.label)).toContain("Tour");
    contribute("P.Two", { menus: [{ menu: "Help", items: [row("Tour B"), row("Tour C")] }] });
    const help = build().find((m) => menuName(m) === "Help")!;
    expect(help.items.filter((i) => ["Tour", "Tour B", "Tour C"].includes(i.label as string))).toHaveLength(3);
    expect(names(build())).toEqual(["File", "Edit", "View", "Help"]);
  });

  it("place a new menu before Help, and one naming an unknown menu at the end", async () => {
    await setLanguage("de");
    contribute("P.One", { menus: [{ menu: "Mouse", before: "Help", items: [row("Pad")] }] });
    contribute("P.One", { menus: [{ menu: "Extras", items: [row("X")] }] });
    expect(names(build())).toEqual(["File", "Edit", "View", "Mouse", "Help", "Extras"]);
    expect(texts(build())).toEqual(["Datei", "Bearbeiten", "Ansicht", "Mouse", "Hilfe", "Extras"]);
  });

  it("do not match the German text: a menu named Hilfe is a new menu", async () => {
    await setLanguage("de");
    contribute("P.One", { menus: [{ menu: "Hilfe", items: [row("Tour")] }] });
    const menus = build();
    expect(names(menus)).toEqual(["File", "Edit", "View", "Help", "Hilfe"]);
    expect(menus.find((m) => menuName(m) === "Help")!.items.map((i) => i.label)).not.toContain("Tour");
  });
});
