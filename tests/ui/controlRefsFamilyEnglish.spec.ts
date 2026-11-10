import { describe, expect, it } from "vitest";
import { familyOf } from "../../src/ui/controlRefs";
import type { RailEntry } from "../../src/ui/railDefs";

const de: RailEntry[] = [
  {
    kind: "family",
    id: "cat:CREATE",
    label: "Erstellen",
    icon: "extrude",
    style: "category",
    items: [
      { kind: "tool", action: "extrude", label: "Extrudieren", english: "Extrude", icon: "extrude" },
      { kind: "tool", action: "revolve", label: "Drehen", english: "Revolve", icon: "revolve" },
    ],
  },
  {
    kind: "family",
    id: "fam:circle",
    label: "Kreis",
    icon: "circle",
    style: "variants",
    items: [
      { kind: "tool", action: "circle3", label: "Kreis durch 3 Punkte", english: "3 point circle", icon: "circle" },
      { kind: "tool", action: "circleX", label: "Kreis 3", icon: "circle" },
    ],
  },
];

describe("familyOf with German labels", () => {
  it("finds a tool by its English name, exact or prefix, and by its German label", () => {
    const cat = { family: { ref: "family:cat:CREATE", button: "left" }, pick: "pick:extrude" };
    expect(familyOf("Extrude", de)).toEqual(cat);
    expect(familyOf("Extru", de)).toEqual(cat);
    expect(familyOf("Extrudieren", de)).toEqual(cat);
    expect(familyOf("pick:revolve", de)).toEqual({ ...cat, pick: "pick:revolve" });
    expect(familyOf("3 point", de)).toEqual({
      family: { ref: "family:fam:circle", button: "right" },
      pick: "pick:circle3",
    });
  });

  it("an exact name beats a prefix of another tool, in either language", () => {
    expect(familyOf("Kreis 3", de)?.pick).toBe("pick:circleX");
    expect(familyOf("3 point circle", de)?.pick).toBe("pick:circle3");
    expect(familyOf("Kreis", de)?.pick).toBe("pick:circle3");
  });

  it("returns null when neither name matches", () => {
    expect(familyOf("Loft", de)).toBeNull();
    expect(familyOf("", [])).toBeNull();
  });
});
