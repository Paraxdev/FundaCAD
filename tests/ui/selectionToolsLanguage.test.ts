import { afterEach, describe, expect, it } from "vitest";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import { setLanguage } from "../../src/i18n";
import { appearanceOffers, selectionCountText, selectionOffers, toolbarOffers } from "../../src/ui/selectionTools";

afterEach(async () => {
  resetContributions();
  await setLanguage("system");
});

const pairs = (offers: { tool?: string; id?: string; label: string }[]) => offers.map((o) => [o.tool ?? o.id, o.label]);

describe("the selection rail in the chosen language", () => {
  it("names a two body selection's tools as the Modify flyout does", async () => {
    await setLanguage("de");
    expect(pairs(toolbarOffers({ body: 2 }))).toEqual([
      ["fillet", "Verrundung"],
      ["chamfer", "Fase"],
      ["move", "Verschieben"],
      ["pattern-linear", "Lineares Muster"],
      ["pattern-circular", "Kreismuster"],
      ["pattern-rect", "Rechteckmuster"],
      ["mirror", "Spiegeln"],
      ["boolean-union", "Vereinigen"],
      ["boolean-subtract", "Subtrahieren"],
      ["boolean-intersect", "Schneiden"],
    ]);
  });

  it("follows a language switch without a new selection", async () => {
    await setLanguage("ja");
    expect(pairs(selectionOffers({ edge: 3 }))).toEqual([
      ["fillet", "フィレット"],
      ["chamfer", "面取り"],
    ]);
    await setLanguage("en");
    expect(pairs(selectionOffers({ edge: 3 }))).toEqual([
      ["fillet", "Fillet"],
      ["chamfer", "Chamfer"],
    ]);
  });

  it("keeps a plugin tool in the plugin's words, and an app id a plugin claims in the app's", async () => {
    contribute("Acme.Widgets", {
      tools: [
        { id: "acme-emboss", label: "Emboss", iconName: "dot", consumes: ["face"], source: "selection" },
        { id: "presspull", label: "Push It", iconName: "dot", consumes: ["face"], source: "selection" },
      ],
    });
    await setLanguage("de");
    const offers = selectionOffers({ face: 2 });
    expect(offers.find((o) => o.tool === "acme-emboss")?.label).toBe("Emboss");
    expect(offers.find((o) => o.tool === "presspull")?.label).toBe("Drücken/Ziehen");
  });

  it("counts the appearance verbs for one body and for many", async () => {
    await setLanguage("de");
    expect(pairs(appearanceOffers({ body: 1 }))).toEqual([
      ["material", "Material"],
      ["hide", "Körper ausblenden"],
      ["isolate", "Körper isolieren"],
    ]);
    await setLanguage("fr");
    expect(pairs(appearanceOffers({ body: 4 }))).toEqual([
      ["material", "Matériau pour 4 corps"],
      ["hide", "Masquer 4 corps"],
      ["isolate", "Isoler 4 corps"],
    ]);
    expect(appearanceOffers({ face: 3 })).toEqual([]);
  });

  it("keeps the English appearance words", () => {
    expect(pairs(appearanceOffers({ body: 1 }))).toEqual([
      ["material", "Material"],
      ["hide", "Hide body"],
      ["isolate", "Isolate body"],
    ]);
    expect(pairs(appearanceOffers({ body: 7 }))).toEqual([
      ["material", "Material for 7 bodies"],
      ["hide", "Hide 7 bodies"],
      ["isolate", "Isolate 7 bodies"],
    ]);
  });

  it("counts the winning kind under Deselect All", async () => {
    expect(selectionCountText({})).toBe("");
    expect(selectionCountText({ body: 1 })).toBe("1 body");
    await setLanguage("de");
    expect(selectionCountText({ body: 1 })).toBe("1 Körper");
    expect(selectionCountText({ edge: 5, face: 2 })).toBe("5 Kanten");
    expect(selectionCountText({ "sketch-region": 3, body: 1 })).toBe("3 Profile");
    await setLanguage("es");
    expect(selectionCountText({ face: 2, body: 3 })).toBe("2 caras");
  });
});
