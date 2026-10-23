import { describe, expect, it } from "vitest";
import {
  decideWhatsNew,
  loadNotes,
  notesHash,
  parseNotes,
  whatsNewSection,
  type WhatsNewInput,
} from "../../src/ui/whatsNew";

// The notes as they were when the card was built, so their shape stays tested after the real file changes.
const frozen = Object.values(
  import.meta.glob<string>("../fixtures/whats_new_beta.md", { query: "?raw", import: "default", eager: true }),
)[0]!;

describe("whatsNewSection", () => {
  it("takes the section under the first What's new heading and stops at the next one", () => {
    const md = [
      "> ### Install by hand",
      "",
      "## What's new since the last beta",
      "",
      "- one",
      "### Group",
      "- two",
      "## Known limits",
      "- three",
      "## What's new again",
      "- four",
    ].join("\n");
    expect(whatsNewSection(md)).toBe("- one\n### Group\n- two");
  });

  it("matches a curly apostrophe, any case, and stops at a top heading too", () => {
    expect(whatsNewSection("# Notes\n## WHAT’S NEW in 1.3\n- a\n# Next\n- b")).toBe("- a");
  });

  it("reads a file saved with Windows line ends as the same text", () => {
    const lf = "## What's new\n- a\n- b\n## Later";
    expect(whatsNewSection(lf.replace(/\n/g, "\r\n"))).toBe(whatsNewSection(lf));
  });

  it("is empty with no What's new heading, or a heading with nothing under it", () => {
    expect(whatsNewSection("## Changes\n- a")).toBe("");
    expect(whatsNewSection("### What's new\n- a")).toBe("");
    expect(whatsNewSection("## What's new\n\n## Known limits\n- a")).toBe("");
  });
});

describe("parseNotes", () => {
  it("turns headings and bold lines into groups of plain text bullets", () => {
    const section = [
      "### Sketch tools",
      "- **Bold** start, a [link](https://example.org/a_b) and `code` here",
      "- <b>html</b> stays & text",
      "  continued on the next line",
      "* star bullet",
      "> a quote line",
      "> - a bullet in a quote",
      "- after the quote",
      "",
      "**Files:**",
      "+ plus bullet",
    ].join("\n");
    expect(parseNotes(section)).toEqual([
      {
        title: "Sketch tools",
        bullets: [
          "Bold start, a link and code here",
          "<b>html</b> stays & text continued on the next line",
          "star bullet",
          "after the quote",
        ],
      },
      { title: "Files", bullets: ["plus bullet"] },
    ]);
  });

  it("keeps bullets before any heading in an untitled group and drops a heading with no bullets", () => {
    expect(parseNotes("- first\n### Empty\n### Full\n- second\nwraps on\n\nA loose paragraph.")).toEqual([
      { title: "", bullets: ["first"] },
      { title: "Full", bullets: ["second wraps on"] },
    ]);
  });

  it("gives no groups for an empty section or one holding only a quote", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes("> Install this one by hand.\n> - not a note")).toEqual([]);
    expect(parseNotes("### Only a heading")).toEqual([]);
  });

  it("reads one group with one bullet", () => {
    expect(parseNotes("**Modeling**\n- Extrude makes a thin wall.")).toEqual([
      { title: "Modeling", bullets: ["Extrude makes a thin wall."] },
    ]);
  });

  it("reads the notes of the first beta that had the card, group by group", () => {
    const groups = parseNotes(whatsNewSection(frozen));
    expect(groups.map((g) => [g.title, g.bullets.length])).toEqual([
      ["Home", 2],
      ["Path traced", 5],
      ["Realtime", 2],
      ["Modeling", 6],
      ["Files", 2],
      ["Linux and stability", 4],
      ["For AI assistants", 1],
    ]);
    expect(groups[0]!.bullets[1]).toBe(
      "Home sits on a calm background in the app's glass look. You can switch it to the workspace or your own picture in Preferences.",
    );
  });

  it("reads the bundled notes into titled groups of plain bullets", async () => {
    const md = await loadNotes("beta");
    const section = whatsNewSection(md);
    const groups = parseNotes(section);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.title).not.toBe("");
      expect(g.bullets.length).toBeGreaterThan(0);
    }
    const text = groups.flatMap((g) => [g.title, ...g.bullets]).join("\n");
    expect(text).not.toMatch(/\*\*|`|\]\(|^>|^#/m);
    expect(section).not.toMatch(/^#{1,2} /m);
  });
});

describe("loadNotes", () => {
  it("falls back to the beta notes for a channel with no notes of its own", async () => {
    const beta = await loadNotes("beta");
    expect(beta).toMatch(/^## What's new/m);
    expect(await loadNotes("v1.4.2")).toBe(beta);
  });
});

describe("notesHash", () => {
  it("is FNV-1a 32 as 8 hex digits", () => {
    expect([notesHash(""), notesHash("a"), notesHash("foobar")]).toEqual(["811c9dc5", "e40c292c", "bf9cf968"]);
  });

  it("is stable for the same text and changes with one character", () => {
    const s = whatsNewSection(frozen);
    expect(notesHash(s)).toBe(notesHash(`${s}`));
    expect(notesHash(s.replace("Home sits", "Home sat"))).not.toBe(notesHash(s));
    expect(notesHash("ä 3D")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("decideWhatsNew", () => {
  const base: WhatsNewInput = { dev: false, returning: true, seen: null, hash: "3fa9c071" };
  it.each([
    ["a returning user who never saw notes", {}, "show"],
    ["a returning user who saw older notes", { seen: "9d0e12ab" }, "show"],
    ["a returning user who saw these notes", { seen: "3fa9c071" }, "nothing"],
    ["a new user", { returning: false }, "record"],
    ["a new user with an older hash", { returning: false, seen: "9d0e12ab" }, "record"],
    ["a new user who has these notes", { returning: false, seen: "3fa9c071" }, "nothing"],
    ["a dev build, returning", { dev: true }, "nothing"],
    ["a dev build, new user", { dev: true, returning: false }, "nothing"],
  ] as const)("%s", (_name, over, want) => {
    expect(decideWhatsNew({ ...base, ...over })).toBe(want);
  });
});
