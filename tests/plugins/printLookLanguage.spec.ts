import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import LayerLinesSection from "../../plugins/FundaCAD.PrintLook/LayerLinesSection.vue";
import { activate } from "../../plugins/FundaCAD.PrintLook/main";
import { settings } from "../../plugins/FundaCAD.PrintLook/settings";
import { reloadLanguageFiles, setLanguage } from "../../src/i18n";
import { contributedMaterialPresets, resetContributions } from "../../src/plugins/contrib";
import type { Engine } from "../../src/app/engine";

const engine = { viewport: {}, store: {}, geometry: {} } as unknown as Engine;
let stop: (() => void) | null = null;

const labelOf = (key: string) => {
  const prop = settings.schema.props.find((p) => p.key === key)!;
  return { label: prop.label, description: prop.description };
};

beforeEach(async () => {
  setActivePinia(createPinia());
  localStorage.clear();
  await setLanguage("en");
  stop = await activate(engine);
});

afterEach(async () => {
  stop?.();
  stop = null;
  resetContributions();
  localStorage.clear();
  await reloadLanguageFiles();
  await setLanguage("system");
});

describe("print look in the chosen language", () => {
  it("reads in English by default", () => {
    expect(labelOf("layerLines").label).toBe("Layer lines");
    expect(contributedMaterialPresets()[0]!.group).toBe("Filament");
  });

  it("follows a switch to German without a restart", async () => {
    await setLanguage("de");
    expect(labelOf("layerLines").label).toBe("Schichtlinien");
    expect(labelOf("layerHeight").label).toBe("Schichthöhe");
    expect(labelOf("layerLines").description).toContain("Nur Anzeige");
    expect(contributedMaterialPresets()[0]!.group).toBe("Filament");
  });

  it("follows a switch to Japanese in the settings and the preset group", async () => {
    await setLanguage("ja");
    expect(labelOf("layerLines").label).toBe("積層線");
    expect(contributedMaterialPresets()[0]!.group).toBe("フィラメント");
  });

  it("keeps the filament preset names as the material codes they are", async () => {
    await setLanguage("ja");
    const names = contributedMaterialPresets()[0]!.materials.map((m) => m.name);
    expect(names).toContain("PLA, matte");
  });

  it("draws the render section in the chosen language", async () => {
    await setLanguage("de");
    const section = mount(LayerLinesSection);
    expect(section.text()).toContain("Schichtlinien");
    expect(section.text()).toContain("Echtzeitansicht");
    section.unmount();
    await setLanguage("ja");
    const ja = mount(LayerLinesSection);
    expect(ja.text()).toContain("積層線");
    ja.unmount();
  });
});
