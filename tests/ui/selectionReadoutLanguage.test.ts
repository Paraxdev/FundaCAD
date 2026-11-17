import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t, type MessageKey } from "../../src/i18n";
import { describeSelection, type Pt3 } from "../../src/ui/selectionMeasure";
import { countLine } from "../../src/ui/selectionTools";

afterEach(() => setLanguage("system"));

const slanted: Pt3[] = [
  [12.5, -7, 3],
  [40.1, 9.3, 21.7],
];
const tilted: Pt3[] = [
  [-3, 5, 2],
  [4, 8, 9],
];
const LANGS = ["en", "de", "fr", "es", "ja", "zh-CN"] as const;

function circleAt(r: number, n = 96): Pt3[] {
  const [cx, cy, cz] = [31, -14, 8];
  const tilt = (20 * Math.PI) / 180;
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const x = r * Math.cos(a);
    const y = r * Math.sin(a);
    return [cx + x, cy + y * Math.cos(tilt), cz + y * Math.sin(tilt)] as Pt3;
  });
}

describe("the selection readout in the chosen language", () => {
  it("counts faces, none, one and many", async () => {
    await setLanguage("de");
    expect([0, 1, 5].map((count) => describeSelection({ kind: "face", count }))).toEqual(["", "1 Fläche", "5 Flächen"]);
    await setLanguage("ja");
    expect(describeSelection({ kind: "face", count: 5 })).toBe("5 面");
  });

  it("gives two slanted edges a total with a decimal comma", async () => {
    await setLanguage("de");
    const total = Math.hypot(27.6, 16.3, 18.7) + Math.hypot(7, 3, 7);
    expect(describeSelection({ kind: "edge", count: 2, edges: [slanted, tilted] })).toBe(
      `2 Kanten · ${String(Number(total.toFixed(2))).replace(".", ",")} mm`,
    );
  });

  it("gives one tilted round edge its length and diameter", async () => {
    await setLanguage("de");
    const text = describeSelection({ kind: "edge", count: 1, edges: [circleAt(10)] });
    expect(text).toMatch(/^1 Kante · 62,\d+ mm · ⌀20 mm$/);
    await setLanguage("ja");
    expect(describeSelection({ kind: "edge", count: 1, edges: [circleAt(10)] })).toMatch(
      /^1 エッジ · 62\.\d+ mm · ⌀20 mm$/,
    );
  });

  it("says the pointer hint for 1 and 3 bodies only when asked", async () => {
    await setLanguage("de");
    expect(describeSelection({ kind: "body", count: 3 })).toBe("3 Körper");
    expect(describeSelection({ kind: "body", count: 1, bodyHint: true })).toMatch(/^1 Körper · .*Fläche/);
    expect(describeSelection({ kind: "body", count: 3, bodyHint: true })).toMatch(/^3 Körper · /);
    await setLanguage("ja");
    expect(describeSelection({ kind: "body", count: 3, bodyHint: true })).toMatch(/^3 ボディ · /);
  });

  it("falls back to the count when an edge selection has no wires yet", async () => {
    expect(describeSelection({ kind: "edge", count: 4, edges: [] })).toBe("4 edges");
  });
});

// Each readout line holds its rail count line, so the readout and the rail never say a count two ways.
const holdsCount = (line: string, kind: "edge" | "body", n: number) => line.includes(countLine(kind, n));

describe("each readout line holds its rail count line", () => {
  const cases: [MessageKey, "edge" | "body"][] = [
    ["readout.edges", "edge"],
    ["readout.edgesCircle", "edge"],
    ["readout.bodiesAuto", "body"],
  ];
  for (const lang of LANGS) {
    it(`in ${lang}`, async () => {
      await setLanguage(lang);
      for (const [key, kind] of cases) {
        for (const n of [1, 2, 5]) {
          expect(holdsCount(t(key, { n, length: "7 mm", diameter: "3 mm" }), kind, n)).toBe(true);
        }
      }
    });
  }

  it("fails a line that drifted from the rail", async () => {
    await setLanguage("de");
    expect(holdsCount("5 Koerper · Klicken", "body", 5)).toBe(false);
  });
});
