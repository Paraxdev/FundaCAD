import { afterEach, describe, expect, it } from "vitest";

import { activate } from "../../plugins/FundaCAD.PrintLook/main";
import { settings } from "../../plugins/FundaCAD.PrintLook/settings";
import { contributedMaterialPresets, contributedRelief, contributedRenderSections, onContribChange, resetContributions } from "../../src/plugins/contrib";
import type { Engine } from "../../src/app/engine";

describe("the Printed look plugin", () => {
  afterEach(() => {
    settings.reset();
    resetContributions();
  });

  it("contributes relief only once layer lines are switched on, read fresh each time", async () => {
    const stop = await activate({} as Engine);
    expect(contributedRenderSections("environment").map((s) => s.key)).toEqual(["FundaCAD.PrintLook:layer-lines"]);
    expect(contributedRelief()).toEqual({});
    let heard = 0;
    const unlisten = onContribChange(() => heard++);
    settings.set("layerLines", true);
    expect(heard).toBeGreaterThan(0);
    unlisten();
    settings.set("direction", "-X");
    expect(contributedRelief().all).toMatchObject({ axis: [-1, 0, 0], pitch: 0.2 });
    settings.set("layerLines", false);
    expect(contributedRelief()).toEqual({});
    stop();
    settings.set("layerLines", true);
    expect(contributedRelief()).toEqual({});
  });

  it("offers the Filament group as copies, and stops when it is switched off", async () => {
    const stop = await activate({} as Engine);
    const groups = contributedMaterialPresets();
    expect(groups.map((g) => g.group)).toEqual(["Filament"]);
    expect(groups[0]!.materials).toHaveLength(8);
    groups[0]!.materials[0]!.color = "#000000";
    expect(contributedMaterialPresets()[0]!.materials[0]!.color).toBe("#e7e4dc");
    stop();
    expect(contributedMaterialPresets()).toEqual([]);
  });
});
