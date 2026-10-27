import { describe, expect, it } from "vitest";

import indexText from "../../src/styles/ui/_index.scss?raw";
import mainText from "../../src/styles/main.scss?raw";

const partials = Object.keys(
  import.meta.glob("../../src/styles/ui/_*.scss", { query: "?raw", import: "default", eager: true }),
)
  .map((p) => /\/_([\w-]+)\.scss$/.exec(p)![1]!)
  .filter((n) => n !== "index")
  .sort();

const PLANNED = [
  "button",
  "card",
  "checkbox",
  "chip",
  "confirm-dialog",
  "dialog",
  "field-row",
  "icon-button",
  "list-row",
  "menu",
  "number-field",
  "panel",
  "popover",
  "segmented",
  "select",
  "slider",
  "states",
  "switch",
  "switch-row",
  "tabs",
  "text-field",
  "unit-chip",
];

describe("the base component styles", () => {
  it("has a partial for every planned component", () => {
    expect(PLANNED.filter((n) => !partials.includes(n))).toEqual([]);
  });

  it("forwards every partial from _index.scss, once each", () => {
    const forwarded = [...indexText.matchAll(/^@forward "([\w-]+)";/gm)].map((m) => m[1]).sort();
    expect(forwarded).toEqual(partials);
  });

  it("is part of the main stylesheet, before _glass repaints the surfaces", () => {
    const uses = [...mainText.matchAll(/^@use "([\w/-]+)";/gm)].map((m) => m[1]);
    expect(uses).toContain("ui");
    expect(uses.indexOf("ui")).toBeLessThan(uses.indexOf("glass"));
  });
});
