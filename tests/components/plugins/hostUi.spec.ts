// `fundacad/ui` hands plugins the app's own base components, not copies, and keeps every name a plugin imported before.

import { describe, expect, it } from "vitest";
import * as ui from "../../../src/plugins/hostUi";
import Button from "../../../src/components/ui/Button.vue";
import Dialog from "../../../src/components/ui/Dialog.vue";
import NumberField from "../../../src/components/ui/NumberField.vue";
import Panel from "../../../src/components/ui/Panel.vue";

const BASE = [
  "Button",
  "Card",
  "Checkbox",
  "Chip",
  "ConfirmDialog",
  "Dialog",
  "FieldRow",
  "IconButton",
  "KeyChip",
  "ListRow",
  "Menu",
  "MenuItem",
  "MenuSeparator",
  "NumberField",
  "Panel",
  "Popover",
  "Segmented",
  "Select",
  "Slider",
  "Switch",
  "SwitchRow",
  "Tabs",
  "TextField",
  "UnitChip",
];

const KEPT = [
  "FloatingPanel",
  "Icon",
  "InlineLabel",
  "ModalFrame",
  "RenderChoices",
  "RenderSection",
  "RenderSlider",
  "RenderSwitch",
];

// Building blocks of other base components, an old path kept for the app's own callers, or the app's single announcer.
const NOT_FOR_PLUGINS = ["Announcer", "ChoiceList", "RailButton", "Toggle"];

const baseFiles = Object.keys(import.meta.glob("../../../src/components/ui/*.vue")).map(
  (p) => /\/(\w+)\.vue$/.exec(p)![1]!,
);

const pluginSources = import.meta.glob("../../../plugins/**/*.{vue,ts}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const exported = ui as Record<string, unknown>;

describe("fundacad/ui", () => {
  it("exports every base component a plugin draws with", () => {
    expect(BASE.filter((name) => !exported[name])).toEqual([]);
  });

  it("exports the components themselves, so a plugin and the app cannot drift", () => {
    expect(exported.Button).toBe(Button);
    expect(exported.Dialog).toBe(Dialog);
    expect(exported.NumberField).toBe(NumberField);
    expect(exported.Panel).toBe(Panel);
  });

  it("keeps the names it exported before the base set", () => {
    expect(KEPT.filter((name) => !exported[name])).toEqual([]);
  });

  it("names every base component file, or says why a plugin does not get it", () => {
    const missing = baseFiles.filter((name) => !BASE.includes(name) && !NOT_FOR_PLUGINS.includes(name));
    expect(missing).toEqual([]);
  });

  it("has every name a shipped plugin imports from it", () => {
    const imported = Object.entries(pluginSources).flatMap(([path, text]) =>
      [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"fundacad\/ui"/g)].flatMap((m) =>
        (m[1] ?? "")
          .split(",")
          .map((s) => s.trim().replace(/^type\s+/, ""))
          .filter(Boolean)
          .map((name) => ({ path, name })),
      ),
    );
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter(({ name }) => !exported[name])).toEqual([]);
  });
});
