import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import PluginsSection from "../../../src/components/overlays/PluginsSection.vue";
import { setLanguage } from "../../../src/i18n";

enableAutoUnmount(afterEach);

const onshape = (w: ReturnType<typeof mount>) => w.get('[data-plugin="FundaCAD.Onshape"]');
const printing = (w: ReturnType<typeof mount>) => w.get('[data-plugin="FundaCAD.Printing"]');

beforeEach(() => setLanguage("en"));
afterEach(async () => {
  await setLanguage("en");
  localStorage.clear();
});

describe("plugin names in Preferences follow the language", () => {
  it("shows Onshape in German and switches live, while a plugin without translations stays English", async () => {
    const w = mount(PluginsSection);
    expect(onshape(w).find(".plug-name").text()).toBe("Onshape link");
    await setLanguage("de");
    await flushPromises();
    expect(onshape(w).find(".plug-name").text()).toBe("Onshape-Link");
    expect(onshape(w).find(".plug-summary").text()).toContain("Importiert die Part Studios");
    expect(printing(w).find(".plug-name").text()).toBe("Printer connection");
    await setLanguage("fr");
    await flushPromises();
    expect(onshape(w).find(".plug-name").text()).toBe("Lien Onshape");
  });
});
