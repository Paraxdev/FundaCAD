// A dropped in language file is untrusted: size, shape, keys, markup, control characters, syntax and arguments.

import { describe, expect, it } from "vitest";
import { checkLine, MAX_LINE_CHARS, MAX_OVERRIDE_BYTES, parseOverrides, shownKey } from "../../src/i18n/overrides";

const english = {
  "stress.setup.title": "Stress setup",
  "stress.setup.faces": "{n, plural, one {# face} other {# faces}}",
  "stress.load.force": "{force, number} N on {name}",
};

const bytes = (text: string) => new TextEncoder().encode(text).length;

// One good line and one far too long, padded with spaces to an exact UTF-8 size; ä is two bytes.
function sized(total: number, prefix = ""): string {
  const head = `${prefix}{"stress.setup.title": "Belastung", "stress.setup.faces": "`;
  const tail = `"}`;
  const room = total - bytes(head) - bytes(tail);
  const text = head + "ä".repeat(Math.floor(room / 2)) + tail + " ".repeat(room % 2);
  expect(bytes(text)).toBe(total);
  return text;
}

describe("parseOverrides", () => {
  it("reads an empty file, one line and many", () => {
    expect(parseOverrides("{}", english)).toEqual({ lines: new Map(), pluginLines: new Map(), skipped: [] });
    expect(parseOverrides('{"stress.setup.title": "Belastung"}', english)).toEqual({
      lines: new Map([["stress.setup.title", "Belastung"]]),
      pluginLines: new Map(),
      skipped: [],
    });
    const many = JSON.stringify({
      "stress.setup.title": "Belastung",
      "stress.setup.faces": "{n, plural, one {# Fläche} other {# Flächen}}",
      "stress.load.force": "{name}: {force, number} N",
    });
    expect(parseOverrides(many, english)).toEqual({
      lines: new Map([
        ["stress.setup.title", "Belastung"],
        ["stress.setup.faces", "{n, plural, one {# Fläche} other {# Flächen}}"],
        ["stress.load.force", "{name}: {force, number} N"],
      ]),
      pluginLines: new Map(),
      skipped: [],
    });
  });

  it("keeps nothing of a first file when a second is read", () => {
    const first = parseOverrides('{"stress.setup.title": "Belastung", "stress.load.force": "{force} N"}', english);
    const second = parseOverrides('{"stress.setup.faces": "{n, plural, other {# faces}}"}', english);
    expect(second).toEqual({
      lines: new Map([["stress.setup.faces", "{n, plural, other {# faces}}"]]),
      pluginLines: new Map(),
      skipped: [],
    });
    expect(first.lines).toEqual(
      new Map([
        ["stress.setup.title", "Belastung"],
        ["stress.load.force", "{force} N"],
      ]),
    );
  });

  it("takes a file of exactly the byte limit and refuses one byte more, a BOM included", () => {
    const kept = {
      lines: new Map([["stress.setup.title", "Belastung"]]),
      pluginLines: new Map(),
      skipped: [{ key: "stress.setup.faces", reason: "too-long" }],
    };
    const refused = { lines: new Map(), pluginLines: new Map(), skipped: [], error: "too-large" };
    expect(MAX_OVERRIDE_BYTES).toBe(262144);
    expect(parseOverrides(sized(262144), english)).toEqual(kept);
    expect(parseOverrides(sized(262145), english)).toEqual(refused);
    expect(parseOverrides(sized(262144, "\ufeff"), english)).toEqual(kept);
    expect(parseOverrides(sized(262145, "\ufeff"), english)).toEqual(refused);
  });

  it("reads past a leading BOM", () => {
    expect(parseOverrides('\ufeff{"stress.setup.title": "Belastung"}', english)).toEqual({
      lines: new Map([["stress.setup.title", "Belastung"]]),
      pluginLines: new Map(),
      skipped: [],
    });
  });

  it("refuses text that is not JSON, with where it breaks", () => {
    const trailing = '{"stress.setup.title": "Belastung",}';
    const cases: [string, { line: number; column: number }][] = [
      ["", { line: 1, column: 1 }],
      ["stress.setup.title = Belastung", { line: 1, column: 1 }],
      [trailing, { line: 1, column: trailing.length }],
      [" \ufeff{}", { line: 1, column: 2 }],
      ['{\n  "stress.setup.title": "Belastung",\n  }', { line: 3, column: 3 }],
    ];
    for (const [text, at] of cases) {
      expect(parseOverrides(text, english), JSON.stringify(text)).toEqual({
        lines: new Map(),
        pluginLines: new Map(),
        skipped: [],
        error: "not-json",
        at,
      });
    }
  });

  it("refuses a file that is not one flat object of lines", () => {
    const files = [
      "null",
      "[]",
      '["stress.setup.title"]',
      '"Belastung"',
      "17",
      '{"stress": {"setup": {"title": "Belastung"}}}',
      '{"stress.setup.title": "Belastung", "stress.load.force": ["{force} N"]}',
    ];
    for (const text of files) {
      expect(parseOverrides(text, english), text).toEqual({
        lines: new Map(),
        pluginLines: new Map(),
        skipped: [],
        error: "not-flat",
      });
    }
  });

  it("skips unknown keys, a __proto__ key among them, and values that are not text", () => {
    const before = Object.getOwnPropertyNames(Object.prototype);
    const text =
      '{"__proto__": "x", "stress.setup.titel": "Belastung", "stress.setup.title": 12.5, ' +
      '"stress.load.force": null, "stress.setup.faces": true, "toString": "x"}';
    expect(parseOverrides(text, english)).toEqual({
      lines: new Map(),
      pluginLines: new Map(),
      skipped: [
        { key: "__proto__", reason: "unknown-key" },
        { key: "stress.setup.titel", reason: "unknown-key" },
        { key: "stress.setup.title", reason: "not-text" },
        { key: "stress.load.force", reason: "not-text" },
        { key: "stress.setup.faces", reason: "not-text" },
        { key: "toString", reason: "unknown-key" },
      ],
    });
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("keeps the good lines of a file and lists each bad one with its reason", () => {
    const text = JSON.stringify({
      "stress.setup.title": "<b>Belastung</b>",
      "stress.setup.faces": "{n, plural, one {# Fläche} other {# Flächen}}",
      "stress.load.force": "{force} N auf {body}",
    });
    expect(parseOverrides(text, english)).toEqual({
      lines: new Map([["stress.setup.faces", "{n, plural, one {# Fläche} other {# Flächen}}"]]),
      pluginLines: new Map(),
      skipped: [
        { key: "stress.setup.title", reason: "markup" },
        { key: "stress.load.force", reason: "bad-argument", arg: "body" },
      ],
    });
  });
});

describe("checkLine", () => {
  it("takes a line of exactly the length limit and refuses one character more", () => {
    expect(MAX_LINE_CHARS).toBe(2000);
    expect(checkLine("ä".repeat(2000), "Stress setup")).toBeNull();
    expect(checkLine("ä".repeat(2001), "Stress setup")).toBe("too-long");
  });

  it.each(["<b>bold</b>", "a </i", "<!-- note -->", "<?xml", "R &amp; D", "a &#60; b", "a &#x3c; b", "a &#X3C; b"])(
    "refuses the markup in %j",
    (line) => {
      expect(checkLine(line, "Stress setup")).toBe("markup");
    },
  );

  it.each(["a < b", "R&D", "Tom & Jerry", "3 <= 4", "x & y;"])("lets %j through as plain text", (line) => {
    expect(checkLine(line, "Stress setup")).toBeNull();
  });

  // Each part alone is plain text, put together they render as <img src=x onerror=alert(1)> or &lt;.
  it.each([
    "<{n, select, other {img src=x onerror=alert(1)}}>",
    "&{n, select, other {lt}};",
    "{n, plural, one {<} other {</}}b>",
    "{n, select, one {x &l} other {&g}}t;",
    "&#{n};",
    "{n, plural, other {&'#'#;}}",
    "a <{name}",
    "{n, plural, other {&'#'60;}}",
  ])("refuses the markup %j builds across its parts", (line) => {
    expect(checkLine(line, english["stress.load.force"] + " {n, plural, other {#}}")).toBe("markup");
  });

  it.each([
    "{n, plural, one {# Fläche < 2} other {# Flächen & mehr}}",
    "R&D {n, select, other {a < b}} x",
    "{n, plural, other {# R&D}}",
    "{name} <= {n, number} & {force}",
  ])("lets %j through, its < and & close inside their own part", (line) => {
    expect(checkLine(line, english["stress.load.force"] + " {n, plural, other {#}}")).toBeNull();
  });

  it.each(["bell\u0007", "two\nlines", "next\u0085line", "\u202eevil", "\u2066isolated\u2069", "del\u007f"])(
    "refuses the control character in %j",
    (line) => {
      expect(checkLine(line, "Stress setup")).toBe("control-character");
    },
  );

  it.each([
    "line\u2028break",
    "para\u2029break",
    "in\ufefftext",
    "\ufff9ruby\ufffanote\ufffb",
    "tag\u{e0001}start",
    "flag\u{e0067}\u{e0062}\u{e007f}",
  ])("refuses the invisible format character in %j", (line) => {
    expect(checkLine(line, "Stress setup")).toBe("control-character");
  });

  it.each([
    "\u200eStress",
    "\u05e2\u05d5\u05de\u05e1\u200f 3",
    "\u0634\u200c\u0645",
    "\u{1f468}\u200d\u{1f527}",
    "\ufff8\u{e0080}",
  ])("lets %j through, RTL text and emoji need its marks and joiners", (line) => {
    expect(checkLine(line, "Stress setup")).toBeNull();
  });

  it.each(["", "   ", "\u3000\u00a0", "\u200e\u200b", " \u2060 "])(
    "refuses %j as empty, it would show nothing",
    (line) => {
      expect(checkLine(line, "Stress setup")).toBe("empty");
    },
  );

  it.each([" x ", "\u200ex", "0", "-", "{n, plural, other {}}"])("takes %j, it is not all blank", (line) => {
    expect(checkLine(line, "{n, plural, other {# faces}}")).toBeNull();
  });

  it("refuses a line that does not parse", () => {
    expect(checkLine("{n, plural, one {# Fläche}}", english["stress.setup.faces"])).toBe("syntax");
    expect(checkLine("Belastung }", "Stress setup")).toBe("syntax");
  });

  it("refuses an argument English does not pass, and takes a subset of English's", () => {
    const force = english["stress.load.force"];
    expect(checkLine("{force} N auf {body}", force)).toBe("bad-argument");
    expect(checkLine("{n, plural, other {# N}}", force)).toBe("bad-argument");
    expect(checkLine("{force} N", force)).toBeNull();
    expect(checkLine("Kraft", force)).toBeNull();
    expect(checkLine("{name}: {force, number} N", force)).toBeNull();
  });
});

describe("shownKey", () => {
  it("keeps a plain key, cuts a long one at 80 and replaces each control and bidi character", () => {
    const long = "stress.load." + "x".repeat(100);
    const keys = ["stress.load.force", "", long, "a\u202Eb.c\u0007d", "e\u2066f\nf", "\u200Eg h", "i\u2028j\u{e0041}k"];
    expect(keys.map(shownKey)).toEqual([
      "stress.load.force",
      "",
      long.slice(0, 80),
      "a\uFFFDb.c\uFFFDd",
      "e\uFFFDf\uFFFDf",
      "\u200Eg h",
      "i\uFFFDj\uFFFDk",
    ]);
  });
});

describe("plugin lines in a user's file", () => {
  const parse = (data: Record<string, unknown>) => parseOverrides(JSON.stringify(data), english);

  it("go to pluginLines under the lower cased id, a core line stays apart", () => {
    expect(
      parse({
        "stress.setup.title": "Belastung",
        "Acme.Rivets:menu.file.send": "An Drucker senden",
        "Zeta-9:tool.extrude": "Ziehen",
        "Solo:tool.extrude": "Allein",
      }),
    ).toEqual({
      lines: new Map([["stress.setup.title", "Belastung"]]),
      pluginLines: new Map([
        ["acme.rivets:menu.file.send", "An Drucker senden"],
        ["zeta-9:tool.extrude", "Ziehen"],
        ["solo:tool.extrude", "Allein"],
      ]),
      skipped: [],
    });
  });

  it("list a refused value with its reason and keep a good sibling", () => {
    const result = parse({
      "Acme.Rivets:menu.file.a": "<b>x</b>",
      "Acme.Rivets:menu.file.b": 17,
      "Acme.Rivets:menu.file.c": "ok {n, plural, one {#} other",
      "Acme.Rivets:menu.file.d": "x".repeat(MAX_LINE_CHARS + 1),
      "Acme.Rivets:menu.file.e": "x".repeat(MAX_LINE_CHARS),
      "Acme.Rivets:menu.file.f": "a\u0007b",
      "Acme.Rivets:menu.file.g": "  ",
    });
    expect(result.skipped).toEqual([
      { key: "Acme.Rivets:menu.file.a", reason: "markup" },
      { key: "Acme.Rivets:menu.file.b", reason: "not-text" },
      { key: "Acme.Rivets:menu.file.c", reason: "syntax" },
      { key: "Acme.Rivets:menu.file.d", reason: "too-long" },
      { key: "Acme.Rivets:menu.file.f", reason: "control-character" },
      { key: "Acme.Rivets:menu.file.g", reason: "empty" },
    ]);
    expect([...result.pluginLines.keys()]).toEqual(["acme.rivets:menu.file.e"]);
  });

  it("read a bad id or a bad key as an unknown line", () => {
    const keys = ["a:b", "1a:tool.x", "Acme.Rivets.Extra:tool.x", "Acme.Rivets:Tool.x", "Acme.Rivets:", ":tool.x"];
    const result = parse(Object.fromEntries(keys.map((k) => [k, "Text"])));
    expect(result.skipped).toEqual(keys.map((key) => ({ key, reason: "unknown-key" })));
    expect(result.pluginLines.size).toBe(0);
  });

  it("keep a __proto__ key as a plain line", () => {
    const result = parseOverrides('{"Acme.Rivets:__proto__.x": "T", "__proto__": "T"}', english);
    expect(result.skipped.map((s) => s.reason)).toEqual(["unknown-key", "unknown-key"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("accept and refuse the same ids as a plugin manifest", async () => {
    const { parseManifest } = await import("../../src/plugins/manifest");
    const ids = [
      "Acme.Rivets",
      "Acme",
      "a",
      "A1-b.C-2",
      "Acme.Rivets.X",
      "1Acme",
      "Acme.",
      ".Rivets",
      "Ac_me",
      "x".repeat(31),
      "x".repeat(32),
      `${"x".repeat(31)}.${"y".repeat(31)}`,
    ];
    const viaLines = ids.map((id) => parse({ [`${id}:tool.x`]: "T" }).pluginLines.size === 1);
    const manifestBase = { name: "N", version: "1.0.0", kind: "process", summary: "S", grants: ["document.read"] };
    const manifest = (id: string) => parseManifest({ ...manifestBase, id });
    expect(viaLines).toEqual(ids.map((id) => manifest(id).ok));
  });
});

describe("checkLine without English", () => {
  it("skips only the argument check", () => {
    expect(checkLine("{extra} {n}")).toBeNull();
    expect(checkLine("{extra}", "none")).toBe("bad-argument");
    expect(checkLine("<i>")).toBe("markup");
  });
});
