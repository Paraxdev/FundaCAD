// The Plugins section reads in the chosen language and follows a switch made while it is open.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import PluginsSection from "../../../src/components/overlays/PluginsSection.vue";
import { setLanguage } from "../../../src/i18n";

enableAutoUnmount(afterEach);
afterEach(() => setLanguage("system"));

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("the Plugins section", () => {
  it("reads English, then German and Japanese on the same mounted page", async () => {
    const w = mount(PluginsSection);
    const text = () => squash(w.text());
    expect(text()).toContain("Installed plugins");
    expect(text()).toContain("Nothing installed yet.");
    expect(text()).toContain("Add a plugin");

    await setLanguage("de");
    expect(text()).toContain("Installierte Plug-ins");
    expect(text()).toContain("Noch nichts installiert.");
    expect(text()).toContain("Plug-in hinzufügen");
    expect(text()).toContain("Von FundaCAD erstellt");
    expect(text()).not.toContain("Installed plugins");
    expect(text()).not.toContain("Add a plugin");

    await setLanguage("ja");
    expect(text()).toContain("インストール済みのプラグイン");
    expect(text()).toContain("プラグインを追加");
    expect(text()).not.toContain("Installierte");
  });

  it("words the consent lists and the Install button in the chosen language", async () => {
    await setLanguage("de");
    const w = mount(PluginsSection);
    const offer = w.get('[data-plugin="FundaCAD.Printing"]');
    expect(offer.get(".btn").text()).toBe("Installieren");
    await offer.get(".btn").trigger("click");
    const consent = squash(offer.get(".plug-consent").text());
    expect(consent).toContain("kann");
    expect(consent).toContain("Es kann nicht");
    expect(consent).not.toContain("It cannot");
    expect(consent).toContain("Teil von FundaCAD selbst");

    await setLanguage("fr");
    expect(squash(offer.get(".plug-consent").text())).toContain("pourra");
  });

  it("keeps the controls of the add row reachable by their ids", async () => {
    const w = mount(PluginsSection);
    await setLanguage("de");
    expect(w.find("[data-plugin-add]").exists()).toBe(true);
    expect(squash(w.get("[data-plugin-add]").text())).toContain("Lesen");
    expect(squash(w.get("[data-plugin-add]").text())).toContain("Datei auswählen");
  });
});
