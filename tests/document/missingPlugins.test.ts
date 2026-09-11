// What a document says when the plugin that owns one of its features is gone.
//
// This is the half of the plugin boundary that costs something. A plugin that
// really owns a feature type owns the geometry too, so a document holding one of
// its features cannot be BUILT without it. The trade is only acceptable if the
// failure is legible: the file opens, the values survive, and the person is told
// which plugin to install by name. These tests are that promise, written down.

import { beforeEach, describe, expect, it } from "vitest";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import { missingPluginMessage, missingPlugins } from "../../src/document/missingPlugins";
import type { Feature } from "../../src/types";

const f = (id: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ id, type, ...extra }) as unknown as Feature;

const box = [
  f("s1", "sketch", { plane: "XY", entities: [] }),
  f("e1", "extrude", { sketch: "s1", distance: 5 }),
];

beforeEach(() => resetContributions());

describe("a document whose plugin is missing", () => {
  it("says nothing at all about a document the app can build on its own", () => {
    expect(missingPlugins({ features: box })).toEqual([]);
  });

  it("names the plugin that owns the feature type", () => {
    const [m] = missingPlugins({ features: [...box, f("t1", "texture", { kind: "knurl" })] });
    expect(m?.id).toBe("FundaCAD.Texture");
    expect(m?.name).toBe("Surface Texture");
    expect(m?.types).toEqual(["texture"]);
    expect(m?.count).toBe(1);
  });

  it("says nothing once that plugin is running", () => {
    // The same document, with the contribution the plugin makes on activate.
    // Nothing else changes, which is what makes the report above a statement
    // about the plugin being absent rather than about the feature being odd.
    contribute("FundaCAD.Texture", { features: [{ type: "texture" }] });
    expect(missingPlugins({ features: [...box, f("t1", "texture", { kind: "knurl" })] })).toEqual([]);
  });

  it("counts the features, because one row is a note and forty is a decision", () => {
    const many = [...box, ...Array.from({ length: 7 }, (_, i) => f(`t${i}`, "texture", {}))];
    expect(missingPlugins({ features: many })[0]?.count).toBe(7);
  });

  it("reports a type nobody claims without inventing an owner for it", () => {
    const [m] = missingPlugins({ features: [...box, f("x1", "somebodyElsesThing")] });
    expect(m?.id).toBeNull();
    expect(m?.name).toBe("somebodyElsesThing");
    expect(m?.installable).toBe(false);
    expect(missingPluginMessage(m!)).toContain("somebodyElsesThing");
  });

  it("puts the most-used plugin first, so the summary reads as the real problem", () => {
    const doc = {
      features: [
        ...box,
        f("x1", "somebodyElsesThing"),
        f("t1", "texture"),
        f("t2", "texture"),
        f("t3", "texture"),
      ],
    };
    expect(missingPlugins(doc).map((m) => m.name)).toEqual([
      "Surface Texture",
      "somebodyElsesThing",
    ]);
  });

  describe("the sentence it shows", () => {
    it("promises the values are kept, before it asks for anything", () => {
      const [m] = missingPlugins({ features: [...box, f("t1", "texture")] });
      const msg = missingPluginMessage(m!);
      // The fear this warning creates is "have I lost the part?", and the answer
      // is no. If that reassurance ever stops being in the message, the warning
      // is doing more harm than the problem it reports.
      expect(msg).toContain("kept");
      expect(msg).toContain("saving will not drop them");
      expect(msg).toContain("Surface Texture");
    });

    it("tells someone to switch it on when it ships here, not to go and find it", () => {
      const [m] = missingPlugins({ features: [...box, f("t1", "texture")] });
      // Texture ships in this repository, so it is installed-and-off rather than
      // absent, and "Install Surface Texture" would send someone looking for
      // something already on their disk.
      expect(m?.installable).toBe(true);
      expect(missingPluginMessage(m!)).toContain("Turn");
    });

    it("counts in words that survive being the only one", () => {
      const one = missingPlugins({ features: [...box, f("t1", "texture")] })[0]!;
      const two = missingPlugins({ features: [...box, f("t1", "texture"), f("t2", "texture")] })[0]!;
      expect(missingPluginMessage(one)).toContain("One feature");
      expect(missingPluginMessage(two)).toContain("2 features");
    });
  });
});
