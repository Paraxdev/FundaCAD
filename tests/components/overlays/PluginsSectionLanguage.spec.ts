import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const inspectUrl = vi.fn();
const installedPlugins = vi.fn();

vi.mock("../../../src/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/plugins")>();
  return {
    ...real,
    inspectUrl: (u: string) => inspectUrl(u),
    installedPlugins: () => installedPlugins(),
  };
});

const PluginsSection = (await import("../../../src/components/overlays/PluginsSection.vue")).default;
const { candidateFrom } = await import("../../../src/plugins");
const { setLanguage } = await import("../../../src/i18n");

enableAutoUnmount(afterEach);

const STRANGER = {
  manifest: {
    id: "Acme.Gaskets",
    name: "Gasket maker",
    version: "0.3.1",
    kind: "compute",
    summary: "Cuts gaskets from a face outline.",
    grants: ["document.read"],
  },
  sha256: "d".repeat(64),
  source: "https://plugins.example.com/gaskets.zip",
  official: false,
};

const row = (w: ReturnType<typeof mount>, id: string) => w.get(`[data-plugin="${id}"]`);
const nameOf = (w: ReturnType<typeof mount>, id: string) => row(w, id).find(".plug-name").text();

async function showStranger(w: ReturnType<typeof mount>) {
  const add = w.get("[data-plugin-add]");
  await add.get(".plug-address input").setValue(STRANGER.source);
  await add.findAll("button")[0]!.trigger("click");
  await flushPromises();
  return w.get("[data-plugin-candidate]");
}

beforeEach(async () => {
  setActivePinia(createPinia());
  installedPlugins.mockResolvedValue([]);
  inspectUrl.mockResolvedValue(candidateFrom(STRANGER, "url"));
  await setLanguage("en");
});
afterEach(async () => {
  await setLanguage("en");
  localStorage.clear();
});

describe("plugin names in Preferences follow the language", () => {
  it("switches shipped names live, while a plugin without translations stays English", async () => {
    const w = mount(PluginsSection);
    await flushPromises();
    const stranger = await showStranger(w);
    expect(nameOf(w, "FundaCAD.Onshape")).toBe("Onshape link");
    expect(nameOf(w, "FundaCAD.Printing")).toBe("Printer connection");
    expect(stranger.find(".plug-name").text()).toBe("Gasket maker");

    await setLanguage("de");
    await flushPromises();
    expect(nameOf(w, "FundaCAD.Onshape")).toBe("Onshape-Link");
    expect(row(w, "FundaCAD.Onshape").find(".plug-summary").text()).toContain("Importiert die Part Studios");
    expect(nameOf(w, "FundaCAD.Printing")).toBe("Druckerverbindung");
    expect(stranger.find(".plug-name").text()).toBe("Gasket maker");
    expect(stranger.find(".plug-summary").text()).toBe("Cuts gaskets from a face outline.");

    await setLanguage("fr");
    await flushPromises();
    expect(nameOf(w, "FundaCAD.Onshape")).toBe("Lien Onshape");
    expect(stranger.find(".plug-name").text()).toBe("Gasket maker");
  });
});
