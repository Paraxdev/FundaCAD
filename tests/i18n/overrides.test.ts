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
    expect(parseOverrides("{}", english)).toEqual({ lines: new Map(), skipped: [] });
    expect(parseOverrides('{"stress.setup.title": "Belastung"}', english)).toEqual({
      lines: new Map([["stress.setup.title", "Belastung"]]),
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
      skipped: [],
    });
  });

  it("keeps nothing of a first file when a second is read", () => {
    const first = parseOverrides('{"stress.setup.title": "Belastung", "stress.load.force": "{force} N"}', english);
    const second = parseOverrides('{"stress.setup.faces": "{n, plural, other {# faces}}"}', english);
    expect(second).toEqual({ lines: new Map([["stress.setup.faces", "{n, plural, other {# faces}}"]]), skipped: [] });
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
      skipped: [{ key: "stress.setup.faces", reason: "too-long" }],
    };
    const refused = { lines: new Map(), skipped: [], error: "too-large" };
    expect(MAX_OVERRIDE_BYTES).toBe(262144);
    expect(parseOverrides(sized(262144), english)).toEqual(kept);
    expect(parseOverrides(sized(262145), english)).toEqual(refused);
    expect(parseOverrides(sized(262144, "\ufeff"), english)).toEqual(kept);
    expect(parseOverrides(sized(262145, "\ufeff"), english)).toEqual(refused);
  });

  it("reads past a leading BOM", () => {
    expect(parseOverrides('\ufeff{"stress.setup.title": "Belastung"}', english)).toEqual({
      lines: new Map([["stress.setup.title", "Belastung"]]),
      skipped: [],
    });
  });

  it("refuses text that is not JSON", () => {
    for (const text of ["", "stress.setup.title = Belastung", '{"stress.setup.title": "Belastung",}', " \ufeff{}"]) {
      expect(parseOverrides(text, english), JSON.stringify(text)).toEqual({
        lines: new Map(),
        skipped: [],
        error: "not-json",
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
      expect(parseOverrides(text, english), text).toEqual({ lines: new Map(), skipped: [], error: "not-flat" });
    }
  });

  it("skips unknown keys, a __proto__ key among them, and values that are not text", () => {
    const before = Object.getOwnPropertyNames(Object.prototype);
    const text =
      '{"__proto__": "x", "stress.setup.titel": "Belastung", "stress.setup.title": 12.5, ' +
      '"stress.load.force": null, "stress.setup.faces": true, "toString": "x"}';
    expect(parseOverrides(text, english)).toEqual({
      lines: new Map(),
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

  it.each(["bell\u0007", "two\nlines", "next\u0085line", "\u202eevil", "\u2066isolated\u2069", "del\u007f"])(
    "refuses the control character in %j",
    (line) => {
      expect(checkLine(line, "Stress setup")).toBe("control-character");
    },
  );

  it("lets a left to right mark through", () => {
    expect(checkLine("\u200eStress", "Stress setup")).toBeNull();
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
    expect(["stress.load.force", "", long, "a\u202Eb.c\u0007d", "e\u2066f\nf", "\u200Eg h"].map(shownKey)).toEqual([
      "stress.load.force",
      "",
      long.slice(0, 80),
      "a\uFFFDb.c\uFFFDd",
      "e\uFFFDf\uFFFDf",
      "\u200Eg h",
    ]);
  });
});
