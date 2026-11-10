import { afterEach, describe, expect, it, vi } from "vitest";
import { contribute, contributedEnglish, contributedGroupLabel, resetContributions } from "../../src/plugins/contrib";
import { pluginText, setLanguage } from "../../src/i18n";
import { allCommands, commandEnglish, groupText } from "../../src/ui/commands";
import { modelRail } from "../../src/ui/railDefs";
import { toolEnglish } from "../../src/ui/ribbonDefs";

const en = {
  "group.rivets": "Rivets",
  "group.create": "Make",
  "tool.set": "Set Rivet",
  "tool.pull": "Pull Rivet",
  "tool.bolt": "Bolt Rivet",
};
const de = {
  "group.rivets": "Nieten",
  "group.create": "Machen",
  "tool.set": "Niete setzen",
  "tool.pull": "Niete ziehen",
  "tool.bolt": "Niete schrauben",
};
const files = {
  "./locales/en.json": en,
  "./locales/de.json": de,
};
const rivets = pluginText<typeof en>("Acme.Rivets", files);
const other = pluginText<typeof en>("Acme.Other", { "./locales/en.json": { "group.rivets": "Other rivets" } });

afterEach(async () => {
  resetContributions();
  vi.restoreAllMocks();
  await setLanguage("system");
});

function contributeRivets() {
  return contribute("Acme.Rivets", {
    ribbon: [
      {
        group: "RIVETS",
        get label() {
          return rivets.t("group.rivets");
        },
        items: [
          {
            action: "rivet-set",
            get label() {
              return rivets.t("tool.set");
            },
            refName: "Set Rivet",
            iconName: "extrude",
          },
          {
            action: "rivet-pull",
            get label() {
              return rivets.t("tool.pull");
            },
            iconName: "extrude",
          },
        ],
      },
      {
        group: "CREATE",
        get label() {
          return rivets.t("group.create");
        },
        items: [
          {
            action: "rivet-bolt",
            get label() {
              return rivets.t("tool.bolt");
            },
            refName: "Bolt Rivet",
            iconName: "extrude",
          },
        ],
      },
    ],
    tools: [
      {
        id: "rivet-tool",
        get label() {
          return rivets.t("tool.set");
        },
        refName: "Set Rivet Tool",
        iconName: "extrude",
        consumes: ["face"],
        source: "selection",
      },
    ],
  });
}

const family = (id: string) => {
  const e = modelRail().find((r) => r.kind === "family" && r.id === id);
  if (!e || e.kind !== "family") throw new Error(`no ${id}`);
  return e;
};
const pick = (id: string) => {
  const c = allCommands().find((x) => x.id === id)!;
  return { label: c.label, group: groupText(c.group), english: commandEnglish(id) };
};

describe("a plugin that follows the language", () => {
  it("reads English first, with the English name matching", () => {
    contributeRivets();
    const cat = family("cat:RIVETS");
    expect(cat.label).toBe("Rivets");
    expect(cat.english).toBe("Rivets");
    expect(cat.items.map((i) => ({ action: i.action, label: i.label, english: i.english }))).toEqual([
      { action: "rivet-set", label: "Set Rivet", english: "Set Rivet" },
      { action: "rivet-pull", label: "Pull Rivet", english: undefined },
    ]);
    expect(pick("rivet-set")).toEqual({ label: "Set Rivet", group: "Rivets", english: "Set Rivet" });
  });

  it("reads German after a switch with no new contribution, English names stay", async () => {
    contributeRivets();
    await setLanguage("de");
    const cat = family("cat:RIVETS");
    expect(cat.label).toBe("Nieten");
    expect(cat.english).toBe("Rivets");
    expect(cat.items.map((i) => ({ action: i.action, label: i.label, english: i.english }))).toEqual([
      { action: "rivet-set", label: "Niete setzen", english: "Set Rivet" },
      { action: "rivet-pull", label: "Niete ziehen", english: undefined },
    ]);
    expect(pick("rivet-set")).toEqual({ label: "Niete setzen", group: "Nieten", english: "Set Rivet" });
    expect(pick("rivet-pull")).toEqual({ label: "Niete ziehen", group: "Nieten", english: undefined });
  });

  it("falls back to the tool contribution's refName for the English name", async () => {
    contributeRivets();
    await setLanguage("de");
    expect(toolEnglish("rivet-tool")).toBe("Set Rivet Tool");
    expect(contributedEnglish("rivet-tool")).toBe("Set Rivet Tool");
    expect(contributedEnglish("rivet-pull")).toBeUndefined();
    expect(contributedEnglish("nothing")).toBeUndefined();
  });

  it("keeps the core heading for CREATE whatever the plugin says", async () => {
    contributeRivets();
    await setLanguage("de");
    const create = family("cat:CREATE");
    expect(create.label).toBe("Erstellen");
    expect(create.english).toBe("Create");
    expect(create.items.at(-1)).toMatchObject({ action: "rivet-bolt", label: "Niete schrauben", english: "Bolt Rivet" });
    expect(groupText("CREATE")).toBe("Erstellen");
  });

  it("shows the first contributor's label for a shared group, then the next when it stops", () => {
    const first = contribute("Acme.Rivets", {
      ribbon: [{ group: "RIVETS", label: "First", items: [{ action: "a1", label: "A1", iconName: "extrude" }] }],
    });
    contribute("Acme.Other", {
      ribbon: [
        {
          group: "RIVETS",
          get label() {
            return other.t("group.rivets");
          },
          items: [{ action: "b1", label: "B1", iconName: "extrude" }],
        },
      ],
    });
    expect(family("cat:RIVETS").label).toBe("First");
    expect(family("cat:RIVETS").items.map((i) => i.action)).toEqual(["a1", "b1"]);
    first();
    expect(contributedGroupLabel("RIVETS")).toBe("Other rivets");
    expect(family("cat:RIVETS").label).toBe("Other rivets");
    expect(family("cat:RIVETS").items.map((i) => i.action)).toEqual(["b1"]);
  });

  it("leaves a plugin without locales as it was across a switch", async () => {
    contribute("Acme.Plain", {
      ribbon: [{ group: "PLAIN", items: [{ action: "plain-x", label: "Plain X", iconName: "extrude" }] }],
    });
    const snap = () => ({ cat: family("cat:PLAIN"), cmd: pick("plain-x") });
    const before = snap();
    await setLanguage("de");
    expect(snap()).toEqual(before);
    expect(before.cat.label).toBe("Plain");
    expect(before.cat.english).toBeUndefined();
    expect(before.cmd).toEqual({ label: "Plain X", group: "PLAIN", english: undefined });
  });
});
