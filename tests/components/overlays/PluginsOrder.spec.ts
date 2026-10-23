// The Plugins list keeps one order across loads, and its search finds a plugin by name or id.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import PluginsSection from "../../../src/components/overlays/PluginsSection.vue";
import { contribute, resetContributions } from "../../../src/plugins/contrib";
import { definePluginSettings } from "../../../src/plugins/settings";

enableAutoUnmount(afterEach);

const give = (id: string) =>
  contribute(id, {
    settings: [
      {
        key: "s",
        settings: definePluginSettings(id, {
          version: 1,
          props: [{ key: "gap", type: "number", label: "Spacing", unit: "length", default: 2, min: 0, max: 100 }],
        }),
      },
    ],
  });

const order = (w: ReturnType<typeof mount>) =>
  w.findAll("[data-plugin-row]").map((r) => r.attributes("data-plugin-row"));

afterEach(() => {
  resetContributions();
  localStorage.clear();
});

describe("plugin rows", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("follow the display name whatever order the plugins activated in", () => {
    for (const id of ["FundaCAD.Texture", "Test.Zeta", "FundaCAD.Screws", "test.apple", "FundaCAD.Gamepad"]) give(id);
    const first = order(mount(PluginsSection));
    expect(first).toEqual(["FundaCAD.Screws", "FundaCAD.Gamepad", "FundaCAD.Texture", "test.apple", "Test.Zeta"]);

    resetContributions();
    for (const id of ["Test.Zeta", "FundaCAD.Gamepad", "test.apple", "FundaCAD.Texture", "FundaCAD.Screws"]) give(id);
    expect(order(mount(PluginsSection))).toEqual(first);
  });

  it("are found by display name or id, in any case, and by a setting", async () => {
    for (const id of ["FundaCAD.Texture", "Test.Zeta", "FundaCAD.Screws"]) give(id);
    const w = mount(PluginsSection);
    const search = w.get("input");
    const found = async (q: string) => {
      await search.setValue(q);
      return order(w);
    };
    expect(await found("fasteners")).toEqual(["FundaCAD.Screws"]);
    expect(await found("SURFACE tex")).toEqual(["FundaCAD.Texture"]);
    expect(await found("test.zeta")).toEqual(["Test.Zeta"]);
    expect(await found("spacing")).toEqual(["FundaCAD.Screws", "FundaCAD.Texture", "Test.Zeta"]);
    expect(await found("nothing like it")).toEqual([]);
  });
});
