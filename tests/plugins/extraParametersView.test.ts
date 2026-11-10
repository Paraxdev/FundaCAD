import { afterEach, describe, it, expect } from "vitest";
import { setLanguage } from "../../src/i18n";
import type { CadDocument, ParamDef } from "../../src/types";
import { recompute } from "../../src/params/engine";
import {
  convertControl,
  formatChoices,
  isPlainNumber,
  nextId,
  parseChoices,
  tuneGroups,
} from "../../plugins/FundaCAD.ExtraParameters/view";

const def = (expr: string, extra: Partial<ParamDef> = {}): ParamDef => ({ expr, value: 0, unit: "count", ...extra });

function doc(defs: Record<string, ParamDef>, groups?: { id: string; name: string }[]): CadDocument {
  const d: CadDocument = {
    parameters: {},
    paramDefs: defs,
    features: [],
    ...(groups ? { paramExtras: { groups } } : {}),
  };
  recompute(d);
  return d;
}

describe("Extra Parameters: what the section lists", () => {
  it("lists user parameters by group, ungrouped first, and leaves out model and hidden ones", () => {
    const d = doc(
      {
        rings: def("22", { group: "g2", control: { kind: "slider", min: 1, max: 40, step: 1 } }),
        solidCore: def("1", { group: "g1", control: { kind: "toggle" } }),
        across: def("68", { unit: "mm" }),
        innerX: def("across / 2 - 4", { unit: "mm", hidden: true }),
        pitch: def("across / 50", { unit: "mm" }),
        stale: def("3", { group: "gone" }),
        d1: def("4", { unit: "mm", target: { kind: "feature", feature: "f1", field: "distance" } }),
      },
      [
        { id: "g1", name: "Core" },
        { id: "g2", name: "Rings" },
        { id: "g3", name: "Empty" },
      ],
    );
    const groups = tuneGroups(d);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.name)])).toEqual([
      [null, ["across", "pitch", "stale"]], // a group id nobody defines reads as ungrouped
      ["g1", ["solidCore"]],
      ["g2", ["rings"]],
    ]);
    const pitch = groups[0]!.rows[1]!;
    expect(pitch.editable).toBe(false); // a formula is reported, never overwritten by a control
    expect(pitch.control).toEqual({ kind: "number" });
    expect(groups[0]!.rows[0]!.unit).toBe("mm");
  });

  it("flags a value its control would not allow", () => {
    const d = doc({ rings: def("50", { control: { kind: "slider", min: 1, max: 40 } }) });
    expect(tuneGroups(d)[0]!.rows[0]!.problem).toMatch(/maximum of 40/);
  });

  it("reads and writes a list of choices, and refuses an entry with no number", () => {
    expect(parseChoices("Small = 10, Large=30, 45")).toEqual([
      { label: "Small", value: 10 },
      { label: "Large", value: 30 },
      { label: "45", value: 45 },
    ]);
    expect(parseChoices("Small, Large = 30")).toMatch(/"Small" needs a number/);
    expect(parseChoices(" , ")).toMatch(/at least one/);
    expect(
      formatChoices([
        { label: "Small", value: 10 },
        { label: "45", value: 45 },
      ]),
    ).toBe("Small = 10, 45");
  });

  describe("a list of choices by the language", () => {
    afterEach(() => setLanguage("system"));
    const CHOICES = [
      { label: "Small", value: 2.5 },
      { label: "1.5", value: 1.5 },
      { label: "Large", value: 30 },
    ];

    it("in German takes a decimal comma with a semicolon between choices, and shows them so", async () => {
      await setLanguage("de");
      expect({
        read: [parseChoices("Small = 2,5; 1,5; Large = 30"), parseChoices("Klein = 0.250")],
        shown: formatChoices(CHOICES),
        back: parseChoices(formatChoices(CHOICES)),
      }).toEqual({
        read: [CHOICES, [{ label: "Klein", value: 0.25 }]],
        shown: "Small = 2,5; 1,5; Large = 30",
        back: CHOICES,
      });
    });

    it("in German refuses 1.500 with the reason, and a comma where a semicolon belongs", async () => {
      await setLanguage("de");
      expect([parseChoices("Small = 1.500; Large = 30"), parseChoices("Small = 2,5, Large = 30")]).toEqual([
        '"1.500" is ambiguous, write a comma for decimals or leave the point out',
        '"Small = 2,5, Large = 30" is two choices, put ; between them',
      ]);
    });

    it("in English keeps the comma between choices and reads a point", () => {
      expect({
        read: [parseChoices("Small = 2.5, 1.5, Large = 30"), parseChoices("Small = 1.500")],
        shown: formatChoices(CHOICES),
        semicolon: parseChoices("Small = 10; Large = 30"),
      }).toEqual({
        read: [CHOICES, [{ label: "Small", value: 1.5 }]],
        shown: "Small = 2.5, 1.5, Large = 30",
        semicolon: '"Small = 10; Large = 30" is two choices, put , between them',
      });
    });
  });

  it("keeps a range across a change of control kind, and invents a usable one for a new slider", () => {
    const slider = convertControl({ kind: "number", min: 0.3, step: 0.1 }, "slider", 0.5);
    expect(slider).toEqual({ kind: "slider", min: 0.3, max: 1, step: 0.1 });
    expect(convertControl(slider, "number", 0.5)).toEqual({ kind: "number", min: 0.3, max: 1, step: 0.1 });
    expect(convertControl(undefined, "choice", 22)).toEqual({ kind: "choice", choices: [{ label: "22", value: 22 }] });
    expect(convertControl(slider, "toggle", 1)).toEqual({ kind: "toggle" });
  });

  it("small helpers", () => {
    expect(isPlainNumber(" 2.5 ")).toBe(true);
    expect(isPlainNumber("-3e2")).toBe(true);
    expect(isPlainNumber("5 mm")).toBe(false);
    expect(isPlainNumber("across / 2")).toBe(false);
    expect(nextId("g", ["g1", "g3"])).toBe("g2");
  });
});
