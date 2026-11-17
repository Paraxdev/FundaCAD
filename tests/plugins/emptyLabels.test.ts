// A control with no name is one a screen reader reads as "button" and voice control cannot reach, so a plugin that
// registers one is refused at the door rather than shipped nameless: the manifest, the settings schema and every
// labelled contribution.

import { afterEach, describe, expect, it } from "vitest";

import { contribute, contributedMenus, resetContributions } from "../../src/plugins/contrib";
import { parseManifest } from "../../src/plugins/manifest";
import { validateSchema } from "../../src/plugins/settings";

afterEach(() => resetContributions());

const base = { id: "Some.Plugin", name: "Some plugin", version: "1.0.0", kind: "process", grants: [] };

const why = (raw: unknown): string => {
  const res = parseManifest(raw);
  if (res.ok) throw new Error("expected this to be refused, it parsed");
  return res.why;
};

describe("the manifest", () => {
  it("parses with a name", () => {
    expect(parseManifest(base).ok).toBe(true);
  });

  it("refuses an empty or blank name, and says so", () => {
    expect(why({ ...base, name: "" })).toMatch(/name/);
    expect(why({ ...base, name: "   " })).toMatch(/name is empty/);
  });
});

describe("the settings schema", () => {
  it("refuses a blank label as it refuses a missing one", () => {
    const out = validateSchema({ version: 1, props: [{ key: "on", type: "boolean", label: "  ", default: false }] });
    expect(out.join("\n")).toMatch(/"on" has no label/);
  });
});

describe("a contribution", () => {
  const Fake = { name: "Fake" } as unknown as never;

  it("is accepted with every label filled in, separators included", () => {
    expect(() =>
      contribute("A.One", {
        menus: [{ menu: "Edit", items: [{ separator: true, label: "" }, { label: "Do it" }] }],
        ribbon: [{ group: "Mine", items: [{ action: "a", label: "Act", iconName: "box" }] }],
        tools: [{ id: "t", label: "Tool", iconName: "box", consumes: ["body"], source: "selection" }],
        browserSections: [{ key: "s", component: Fake }],
      }),
    ).not.toThrow();
    expect(contributedMenus()).toHaveLength(1);
  });

  it("refuses a menu row with a blank label, naming the plugin and the place", () => {
    expect(() => contribute("A.One", { menus: [{ menu: "Edit", items: [{ label: " " }] }] })).toThrow(
      /A\.One.*Edit menu.*empty label/,
    );
    expect(contributedMenus()).toHaveLength(0);
  });

  it("refuses a blank menu, ribbon group, ribbon button or tool name", () => {
    expect(() => contribute("A.One", { menus: [{ menu: "", items: [{ label: "x" }] }] })).toThrow(/empty label/);
    expect(() => contribute("A.One", { ribbon: [{ group: "  ", items: [] }] })).toThrow(/empty label/);
    expect(() =>
      contribute("A.One", { ribbon: [{ group: "G", items: [{ action: "a", label: "", iconName: "box" }] }] }),
    ).toThrow(/ribbon.*empty label/);
    expect(() =>
      contribute("A.One", {
        tools: [{ id: "t", label: "\t", iconName: "box", consumes: ["body"], source: "selection" }],
      }),
    ).toThrow(/tool "t".*empty label/);
  });

  it("refuses a feature row with a blank label", () => {
    expect(() =>
      contribute("A.One", {
        features: [{ type: "thing", toggleFields: [{ field: "on", label: "" }] as never }],
      }),
    ).toThrow(/thing.*empty label/);
  });

  it("leaves a label computed on open alone, it can only be judged when the menu opens", () => {
    expect(() => contribute("A.One", { menus: [{ menu: "Edit", items: [{ label: () => "Undo" }] }] })).not.toThrow();
  });
});
