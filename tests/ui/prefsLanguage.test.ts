// The lists Preferences offers read in the chosen language and follow a live switch, the argument lines name what
// they should, and the German and French lines are really translated.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { ENVIRONMENTS_LIST } from "../../src/ui/renderPrefs";
import { EXPERIMENTAL_GROUPS } from "../../src/ui/experimentalPrefs";
import { UPDATE_PERIODS } from "../../src/ui/updatePrefs";
import { besideTitle, channelOptions, UPDATE_CHANNELS } from "../../src/ui/updateChannel";

afterEach(() => setLanguage("system"));

const labels = (list: readonly { label: string }[]) => list.map((x) => x.label);

describe("the lists that were module constants", () => {
  it("read English by default and German once picked, on the same list object", async () => {
    const same = [UPDATE_PERIODS, UPDATE_CHANNELS, ENVIRONMENTS_LIST, EXPERIMENTAL_GROUPS];
    expect(labels(UPDATE_PERIODS)).toEqual(["Every launch", "Daily", "Weekly"]);
    expect(labels(ENVIRONMENTS_LIST)).toEqual(["Studio", "Soft box", "Warm key", "Dusk", "Bright room", "Flat"]);
    expect(EXPERIMENTAL_GROUPS.map((g) => g.title)).toEqual(["Path traced", "Environment", "Model size"]);

    await setLanguage("de");
    expect(labels(UPDATE_PERIODS)).toEqual(["Bei jedem Start", "Täglich", "Wöchentlich"]);
    expect(labels(UPDATE_CHANNELS)).toEqual(["Stabil", "Beta", "Entwicklung"]);
    expect(ENVIRONMENTS_LIST.map((e) => e.note)).not.toContain("Neutral room, even light");
    expect(EXPERIMENTAL_GROUPS.map((g) => g.title)).toEqual(["Pfadverfolgung", "Umgebung", "Modellgröße"]);
    expect([UPDATE_PERIODS, UPDATE_CHANNELS, ENVIRONMENTS_LIST, EXPERIMENTAL_GROUPS]).toEqual(same);
  });

  it("keep their ids and swatches whatever the language", async () => {
    const ids = ENVIRONMENTS_LIST.map((e) => e.id);
    const swatches = ENVIRONMENTS_LIST.map((e) => e.swatch);
    await setLanguage("ja");
    expect(ENVIRONMENTS_LIST.map((e) => e.id)).toEqual(ids);
    expect(ENVIRONMENTS_LIST.map((e) => e.swatch)).toEqual(swatches);
    expect(EXPERIMENTAL_GROUPS.map((g) => g.id)).toEqual(["pathTraced", "environment", "modelSize"]);
    expect(UPDATE_PERIODS.map((p) => p.id)).toEqual(["launch", "daily", "weekly"]);
  });

  it("do not lose their getters when mapped, which is how the dialogs read them", async () => {
    const mapped = () => ENVIRONMENTS_LIST.map((e) => e.label);
    await setLanguage("fr");
    const fr = mapped();
    await setLanguage("es");
    expect(mapped()).not.toEqual(fr);
  });
});

describe("the channel lines", () => {
  it("name the product and read in the language", async () => {
    expect(besideTitle("development")).toBe("Install FundaCAD Dev beside this app");
    const opts = channelOptions("beta", false);
    expect(opts.find((o) => o.value === "stable")).toMatchObject({ hint: "No stable release yet", disabled: true });
    expect(opts.find((o) => o.value === "development")?.hint).toBe("Installs FundaCAD Dev beside this app");

    await setLanguage("de");
    expect(besideTitle("development")).toContain("FundaCAD Dev");
    expect(besideTitle("development")).not.toContain("Install");
    const de = channelOptions("beta", false);
    expect(de.find((o) => o.value === "stable")?.hint).not.toBe("No stable release yet");
    expect(de.find((o) => o.value === "development")?.hint).toContain("FundaCAD Dev");
  });
});
