import { describe, expect, it } from "vitest";
import { jsonErrorIndex, positionOf } from "../../src/i18n/jsonError";
import { parseOverrides } from "../../src/i18n/overrides";

const english = { "stress.setup.title": "Setup", "stress.load.force": "Force" };

const parses = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

function where(text: string) {
  const index = jsonErrorIndex(text);
  return index === null ? null : positionOf(text, index);
}

describe("where a JSON slip is", () => {
  it("points at the closing brace after a trailing comma", () => {
    const text = '{\n  "stress.setup.title": "Belastung",\n  "stress.load.force": "Kraft",\n  }';
    expect([where(text), text[jsonErrorIndex(text)!]]).toEqual([{ line: 4, column: 3 }, "}"]);
    expect(where('{"a": "x",}')).toEqual({ line: 1, column: 11 });
    expect(where('["a", "b",\n]')).toEqual({ line: 2, column: 1 });
  });

  it("points at the character after a missing quote", () => {
    expect(where('{\n  "stress.setup.title": "Belastung",\n  "stress.load.force: "Kraft"\n}')).toEqual({
      line: 3,
      column: 24,
    });
    expect(where('{\n  stress.setup.title": "x"\n}')).toEqual({ line: 2, column: 3 });
    expect(where('{\n  "a": "x",\n  "b": y"\n}')).toEqual({ line: 3, column: 8 });
    // A string that never closes stops at its line end, where a line break is not allowed.
    expect(where('{"a": "x,\n"b": "y"}')).toEqual({ line: 1, column: 10 });
  });

  it("points at the end of the text when a brace is missing", () => {
    expect(where('{\n  "a": "x"')).toEqual({ line: 2, column: 11 });
    expect(where('{\n  "a": "x"\n')).toEqual({ line: 3, column: 1 });
    expect(where('{\n  "a": ["x",\n    "y"\n')).toEqual({ line: 4, column: 1 });
    expect(where('{\n  "a": "x')).toEqual({ line: 2, column: 10 });
    expect(where("")).toEqual({ line: 1, column: 1 });
  });

  it("points at the first slip of grammar in a value", () => {
    const cases: [string, number][] = [
      ['{"a": tru}', 9],
      ['{"a": nulL}', 9],
      ['{"a": 1.}', 8],
      ['{"a": 01}', 7],
      ['{"a": -}', 7],
      ['{"a": 1e}', 8],
      ['{"a": "\\x"}', 8],
      ['{"a": "\\u12G4"}', 11],
      ['{"a": "\\u12"}', 11],
      ['{"a" "x"}', 5],
      ["{'a': 'x'}", 1],
      ['{"a": "x"} {', 11],
      ['{"a": "x"}}', 10],
      ['{"a": "x"\t"b": "y"}', 10],
      ['{"a": "tab\there"}', 10],
    ];
    expect(cases.map(([text]) => jsonErrorIndex(text))).toEqual(cases.map(([, at]) => at));
  });

  it("counts characters and takes CRLF, CR and LF as one line break each", () => {
    expect(where('{\r\n  "a": "x",\r\n}')).toEqual({ line: 3, column: 1 });
    expect(where('{\r  "a": "x",\r}')).toEqual({ line: 3, column: 1 });
    expect(where('{\n\n\n  "a": "x",\n}')).toEqual({ line: 5, column: 1 });
    // A letter outside the BMP is one character and two UTF-16 units.
    expect(where('{"a": "\u{1f600}\u{1f600}",}')).toEqual({ line: 1, column: 12 });
    expect(where('{"a": "ł\u0142",}')).toEqual({ line: 1, column: 12 });
  });

  it("finds nothing in JSON that parses", () => {
    const texts = [
      "{}",
      "[]",
      ' \n\t{ "a" : [ 1 , -2.5e+3 , true , false , null , "\\u00e9\\n\\"" ] }\r\n',
      '{"a": {"b": [[], {}]}}',
      "0",
      '"x"',
      "-0.5E-2",
    ];
    expect(texts.map((text) => [parses(text), jsonErrorIndex(text)])).toEqual(texts.map(() => [true, null]));
  });

  it("agrees with JSON.parse on text with one character changed, dropped or added", () => {
    const base = '{\n  "a": ["x", -1.5e3, true, null, {"b": "\\u00e9\\n"}],\n  "c": false\n}';
    const slips = ['"', ",", "}", "]", "{", ":", "\\", "x", "\n", "-", "e", " ", "0", "."];
    const texts: string[] = [];
    for (let i = 0; i <= base.length; i++) {
      texts.push(base.slice(0, i) + base.slice(i + 1));
      for (const slip of slips)
        texts.push(base.slice(0, i) + slip + base.slice(i), base.slice(0, i) + slip + base.slice(i + 1));
    }
    const wrong = texts.filter((text) => (jsonErrorIndex(text) === null) !== parses(text));
    expect([texts.length > 500, wrong]).toEqual([true, []]);
    const broken = texts.filter((text) => !parses(text));
    expect(broken.length).toBeGreaterThan(300);
    expect(broken.every((text) => jsonErrorIndex(text)! <= text.length)).toBe(true);
  });

  it("does not choke on nesting a stack could not hold", () => {
    const deep = "[".repeat(200000);
    expect(jsonErrorIndex(deep)).toSatisfy((at: number | null) => at === null || at === deep.length);
  });
});

describe("a language file refused as not JSON", () => {
  it("says the line and column of a trailing comma, a missing quote and a missing brace", () => {
    const files: [string, number, number][] = [
      ['{\n  "stress.setup.title": "Belastung",\n  "stress.load.force": "Kraft",\n}', 4, 1],
      ['{\n  "stress.setup.title": "Belastung",\n  "stress.load.force: "Kraft"\n}', 3, 24],
      ['{\n  "stress.setup.title": "Belastung"', 2, 36],
    ];
    expect(files.map(([text]) => parseOverrides(text, english))).toEqual(
      files.map(([, line, column]) => ({ lines: new Map(), skipped: [], error: "not-json", at: { line, column } })),
    );
  });

  it("counts from after a BOM and leaves a file that parses without a position", () => {
    expect(parseOverrides('\ufeff{\n "stress.setup.title": "x",\n}', english).at).toEqual({ line: 3, column: 1 });
    expect(parseOverrides('\ufeff{"stress.setup.title": "x"\n', english).at).toEqual({ line: 2, column: 1 });
    expect(parseOverrides('{\n "stress.setup.title": "Einrichtung"\n}', english)).toEqual({
      lines: new Map([["stress.setup.title", "Einrichtung"]]),
      skipped: [],
    });
    expect(parseOverrides("[1,]", english).error).toBe("not-json");
    expect(parseOverrides("[1]", english).error).toBe("not-flat");
  });
});
