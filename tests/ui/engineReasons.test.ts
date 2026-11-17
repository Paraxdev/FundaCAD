// The engine words why a body has no inside after the body's name (crates/fundacad-geom/src/soundness.rs). Each form
// it sends is pinned here exactly, so a reworded engine line shows up as a failing test, not an English sentence
// in a German panel.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { bodyReason, knownBodyReason } from "../../src/ui/engineReasons";

afterEach(() => setLanguage("system"));

const ENGINE = {
  surface: "is a surface, not a solid, so it has no inside",
  openOne: "is not a closed solid, 1 of its edges bounds only one face, so it has no inside",
  open: "is not a closed solid, 12 of its edges bound only one face, so it has no inside",
  crowdedOne: "is not one clean solid, 1 of its edges is shared by more than two faces, so it has no single inside",
  crowded: "is not one clean solid, 4 of its edges are shared by more than two faces, so it has no single inside",
  flipped: "has faces that point the wrong way, at 3 of its edges the two faces disagree about which side is inside",
  insideOutStuck: "is inside out, its faces point into the material, and it could not be turned over",
  insideOut: "is inside out, its faces point into the material",
};

describe("engine reasons", () => {
  it("read back word for word in English for every form the engine sends", () => {
    for (const reason of Object.values(ENGINE)) {
      expect(knownBodyReason("Rod", reason)).toBe(`Rod ${reason}`);
    }
  });

  it("put an unknown reason after the name as the engine wrote it", () => {
    expect(knownBodyReason("Rod", "open shell")).toBeNull();
    expect(bodyReason("Rod", "open shell")).toBe("Rod open shell");
    expect(bodyReason("Rod", "is a surface, not a solid, so it has no inside yet")).toBe(
      "Rod is a surface, not a solid, so it has no inside yet",
    );
  });

  it("read as whole German and Japanese sentences with the count carried over", async () => {
    await setLanguage("de");
    expect(bodyReason("Stab", ENGINE.surface)).toBe(
      "Stab ist ein Flächenkörper, kein Volumenkörper, und hat daher kein Inneres",
    );
    expect(bodyReason("Stab", ENGINE.openOne)).toContain("1 Kante grenzt nur an eine Fläche");
    expect(bodyReason("Stab", ENGINE.open)).toContain("12 Kanten grenzen nur an eine Fläche");
    expect(bodyReason("Stab", ENGINE.crowded)).toContain("4 Kanten werden von mehr als zwei Flächen geteilt");
    expect(bodyReason("Stab", ENGINE.flipped)).toContain("An 3 Kanten");
    expect(bodyReason("Stab", ENGINE.insideOutStuck)).toContain("das Umkehren ist nicht gelungen");
    expect(bodyReason("Stab", ENGINE.insideOut)).toBe("Stab ist umgestülpt: Die Flächen zeigen ins Material");
    expect(bodyReason("Stab", "open shell")).toBe("Stab open shell");

    await setLanguage("ja");
    expect(bodyReason("ロッド", ENGINE.open)).toBe(
      "ロッド は閉じたソリッドではありません。12 本のエッジが 1 つの面にしか接していないため、内側がありません",
    );
    expect(bodyReason("ロッド", ENGINE.insideOut)).toBe("ロッド は裏返しです。面が材料の内側を向いています");
  });
});
