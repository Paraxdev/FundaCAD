// The message format: arguments, numbers, plurals and choices per language, ICU quoting and every syntax error.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  argNames,
  decimalMarkOf,
  formatMessage,
  MessageSyntaxError,
  parseMessage,
  type MessageArgs,
} from "../../src/i18n/format";

function say(src: string, args: MessageArgs = {}, locale = "en"): string {
  return formatMessage(parseMessage(src), args, locale);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("arguments and numbers", () => {
  it("fills arguments in the order the message puts them", () => {
    expect(say("{a} of {b}", { a: 7, b: 12 })).toBe("7 of 12");
    expect(say("{b} の {a}", { a: 7, b: 12 })).toBe("12 の 7");
    expect(say("{name}", { name: "Bracket 3" })).toBe("Bracket 3");
  });

  it("formats a number for each language from its own cached format, never grouped", () => {
    const src = "{n, number} N";
    expect(say(src, { n: 1234.5 }, "de")).toBe("1234,5 N");
    expect(say(src, { n: 1234.5 }, "en")).toBe("1234.5 N");
    expect(say(src, { n: 1234.5 }, "de")).toBe("1234,5 N");
    expect(say(src, { n: 210000 }, "de")).toBe("210000 N");
    expect(say(src, { n: 210000 }, "en")).toBe("210000 N");
  });

  it("passes text given to a number argument through as the caller formatted it", () => {
    expect(say("{n, number} mm", { n: "12.35" }, "de")).toBe("12.35 mm");
  });

  it("shows a missing argument by its name", () => {
    expect(say("Load on {name}, {n, number} N", { n: 3.5 })).toBe("Load on {name}, 3.5 N");
    expect(say("Load on {name}, {n, number} N", {})).toBe("Load on {name}, {n} N");
  });
});

describe("decimalMarkOf", () => {
  it.each([
    ["en", "."],
    ["de", ","],
    ["fr", ","],
    ["es", ","],
    ["zh-CN", "."],
    ["ja", "."],
    ["de-CH", "."],
    ["de-AT", ","],
    ["pt-BR", ","],
    ["en-IN", "."],
    ["en-XA", "."],
  ])("%s gives %j", (tag, mark) => {
    expect(decimalMarkOf(tag)).toBe(mark);
  });

  it("gives a point for a tag the runtime does not know or cannot read", () => {
    expect(decimalMarkOf("zz")).toBe(".");
    expect(decimalMarkOf("not a tag")).toBe(".");
    expect(decimalMarkOf("")).toBe(".");
  });

  it("keeps each tag's own answer when asked in turn", () => {
    expect([decimalMarkOf("de"), decimalMarkOf("en"), decimalMarkOf("de")]).toEqual([",", ".", ","]);
  });
});

describe("plural", () => {
  const faces = "{n, plural, one {# face} other {# faces}}";

  it("picks the English category for 0, 1, 2 and 21", () => {
    expect([0, 1, 2, 21].map((n) => say(faces, { n }))).toEqual(["0 faces", "1 face", "2 faces", "21 faces"]);
  });

  it("follows each language's own rules", () => {
    expect(say(faces, { n: 0 }, "fr")).toBe("0 face");
    expect(say(faces, { n: 1.5 }, "fr")).toBe("1,5 face");
    expect(say("{n, plural, other {# 面}}", { n: 3 }, "ja")).toBe("3 面");
    const all = "{n, plural, zero {z} one {o} two {t} few {f} many {m} other {x}}";
    expect([0, 1, 2, 3, 11, 100].map((n) => say(all, { n }, "ar"))).toEqual(["z", "o", "t", "f", "m", "x"]);
  });

  it("prefers an exact =N over the category", () => {
    const src = "{n, plural, =0 {no faces} =1 {the face} one {# face} other {# faces}}";
    expect([0, 1, 2].map((n) => say(src, { n }))).toEqual(["no faces", "the face", "2 faces"]);
    expect(say(src, { n: 0 }, "fr")).toBe("no faces");
    expect(say(src, { n: 1.5 }, "fr")).toBe("1,5 face");
  });

  it("reads # as the count in a plural and in a choice nested in it, and keeps it literal elsewhere", () => {
    const nested =
      "{n, plural, one {{kind, select, spot {# spot} other {# face}}} other {{kind, select, spot {# spots} other {# faces}}}}";
    expect(say(nested, { n: 3, kind: "spot" })).toBe("3 spots");
    expect(say(nested, { n: 2.5, kind: "face" }, "de")).toBe("2,5 faces");
    expect(say(nested, { n: 1, kind: "spot" })).toBe("1 spot");
    expect(say("Step # of {n}", { n: 4 })).toBe("Step # of 4");
    expect(say("{kind, select, spot {# spot} other {x}}", { kind: "spot" })).toBe("# spot");
    expect(say("{n, plural, other {'#'# done}}", { n: 5 })).toBe("#5 done");
  });

  it("counts a missing count as 0 and warns once per name in dev", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(say("{spots, plural, one {# spot} other {# spots}}", { n: 4 })).toBe("0 spots");
    expect(say("{spots, plural, =0 {none} other {# spots}}", {})).toBe("none");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(say("{edges, plural, other {# edges}}", {})).toBe("0 edges");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(say("{edges, plural, other {# edges}}", { edges: 6 })).toBe("6 edges");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("stays quiet about a missing count outside dev", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DEV", false);
    expect(say("{holes, plural, other {# holes}}", {})).toBe("0 holes");
    expect(warn).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    expect(say("{holes, plural, other {# holes}}", {})).toBe("0 holes");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("select", () => {
  const src = "{kind, select, spot {Spot} edge {Edge} other {Face}}";

  it("takes the matching option, else other, also when the value is missing", () => {
    expect(say(src, { kind: "edge" })).toBe("Edge");
    expect(say(src, { kind: "hole" })).toBe("Face");
    expect(say(src, {})).toBe("Face");
  });

  it("holds a plural inside an option", () => {
    const counted =
      "{kind, select, spot {{n, plural, one {# spot} other {# spots}}} other {{n, plural, one {# face} other {# faces}}}}";
    expect(say(counted, { kind: "spot", n: 1 })).toBe("1 spot");
    expect(say(counted, { kind: "face", n: 4 })).toBe("4 faces");
  });

  it("takes any word as an option, the plural categories bind only plurals", () => {
    expect(say("{k, select, on {lit} other {dark}}", { k: "on" })).toBe("lit");
  });
});

describe("quoting", () => {
  it("follows ICU's apostrophe rule, so French needs no doubling", () => {
    expect(say("l'appui {n}", { n: 2 })).toBe("l'appui 2");
    expect(say("'{x}' and '}'", { x: 9 })).toBe("{x} and }");
    expect(say("it''s {x}", { x: 9 })).toBe("it's 9");
  });
});

describe("syntax errors", () => {
  it.each([
    ["a stray }", "Done } now"],
    ["an unclosed argument", "Load {n"],
    ["no argument name", "Load {}"],
    ["no comma after the name", "{n number}"],
    ["an unclosed option list", "{n, plural, other {x}"],
    ["an unknown kind", "{n, date}"],
    ["a plural without other", "{n, plural, one {x}}"],
    ["a select without other", "{k, select, spot {x}}"],
    ["an unknown plural category", "{n, plural, on {x} other {y}}"],
    ["an exact value that is not a number", "{n, plural, =x {x} other {y}}"],
    ["an option without a key", "{n, plural, {x} other {y}}"],
    ["an unclosed quote", "Use '{x} here"],
  ])("refuses %s", (_why, src) => {
    expect(() => parseMessage(src)).toThrow(MessageSyntaxError);
  });

  it("accepts every plural category and a many digit exact value", () => {
    expect(() =>
      parseMessage("{n, plural, zero {a} one {b} two {c} few {d} many {e} =12 {f} other {g}}"),
    ).not.toThrow();
  });
});

describe("argNames", () => {
  it("collects the names of none, one and many arguments, nested ones too", () => {
    expect(argNames(parseMessage("Run study"))).toEqual(new Set());
    expect(argNames(parseMessage("{force, number} N"))).toEqual(new Set(["force"]));
    const nested = "{a} {n, plural, one {{b}} other {{kind, select, x {{c, number}} other {#}}}}";
    expect(argNames(parseMessage(nested))).toEqual(new Set(["a", "n", "b", "kind", "c"]));
  });
});
