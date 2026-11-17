// Japanese shortcut lines put an aside in full width brackets, so the rows of one window read alike.

import { describe, expect, it } from "vitest";
import ja from "../../src/i18n/locales/ja.json";

const halfWidth = (lines: Record<string, string>) =>
  Object.entries(lines).flatMap(([k, v]) =>
    /[()]/.test(v.replace(/\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\}/g, "")) ? [k] : [],
  );

describe("the half width bracket detector", () => {
  it("flags a half width aside, and not a full width one or an argument", () => {
    expect(
      halfWidth({
        a: "パン (ズーム)",
        b: "パン（ズーム）",
        c: "{n, plural, other {# 個}}",
        d: "面取り(斜め",
        e: "左右",
      }),
    ).toEqual(["a", "d"]);
  });
});

describe("Japanese shortcut lines", () => {
  it("hold no half width bracket", () => {
    const shortcuts = Object.fromEntries(Object.entries(ja).filter(([k]) => k.startsWith("shortcuts.")));
    expect(Object.keys(shortcuts).length).toBeGreaterThan(40);
    expect(halfWidth(shortcuts)).toEqual([]);
  });
});
