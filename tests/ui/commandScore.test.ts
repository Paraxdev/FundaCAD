// The palette's ranking is the whole reason it is usable, a scorer that ranks
// "Fillet" below "Offset plane from face" for the query "fil" makes Ctrl+K
// slower than the ribbon. These pin the ordering properties, not the numbers.

import { describe, it, expect } from "vitest";
import { score } from "../../src/ui/commandScore";

/** Rank labels by score, best first, dropping non-matches, what the palette does. */
function rank(q: string, labels: string[]): string[] {
  return labels
    .map((l) => ({ l, s: score(q.toLowerCase(), l.toLowerCase()) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.l);
}

describe("score", () => {
  it("treats an empty query as a match for everything", () => {
    expect(score("", "anything")).toBe(1);
  });

  it("requires every query character, in order", () => {
    expect(score("abc", "a b c")).toBeGreaterThan(0);
    expect(score("cba", "a b c")).toBe(0); // out of order
    expect(score("abcd", "a b c")).toBe(0); // missing a character
  });

  it("ranks a prefix match above a mid-word one", () => {
    expect(rank("fil", ["Profile", "Fillet"])[0]).toBe("Fillet");
  });

  it("ranks a contiguous run above the same characters scattered", () => {
    expect(rank("ext", ["Export STL", "Extrude"])[0]).toBe("Extrude");
  });

  it("prefers the shorter label when matches are otherwise equivalent", () => {
    expect(rank("box", ["Box", "Box pattern along a path"])[0]).toBe("Box");
  });

  it("is case-insensitive at the call site's discretion", () => {
    // score() itself is literal; the palette lowercases both sides. Guard that
    // contract so a caller that forgets is caught by its own test, not by users.
    expect(score("f", "Fillet")).toBe(0); // no lowercase f in "Fillet"
    expect(score("f", "fillet")).toBeGreaterThan(0);
  });
});
