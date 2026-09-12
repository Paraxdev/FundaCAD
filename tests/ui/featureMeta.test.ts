// The mark and the word for a feature, now that not every feature is the
// application's.
//
// The case this file was written for is the one that replaced a compile-time
// check. FEATURE_META used to be a total `Record<FeatureType, FeatureMeta>`, so
// adding a feature type and forgetting its mark was a type error. It cannot be
// total any more: the union is the document FORMAT, every type a file may
// contain, and that is a wider thing than every type this build knows how to
// draw, which is what came apart when a tool became a plugin.
//
// So the totality is asserted here instead, and against a stricter question than
// the Record was asking: every type in the union resolves to a mark from
// SOMEWHERE, the application or a plugin in this repository. That holds the
// plugins to it too.

import { afterEach, describe, expect, it } from "vitest";
import { FEATURE_META, featureMeta, labelOf } from "../../src/ui/featureMeta";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import type { Feature, FeatureType } from "../../src/types";

afterEach(() => resetContributions());

/** Every feature type the APPLICATION defines.
 *
 *  Typed as a total Record so the compiler still catches a NEW type with no
 *  entry, the check that was lost when FEATURE_META became partial, moved to
 *  where it can also say who is expected to draw the thing. */
const DRAWN_BY_APP: Record<FeatureType, "app"> = {
  sketch: "app",
  extrude: "app",
  fillet: "app",
  chamfer: "app",
  "press-pull": "app",
  deleteFace: "app",
  mirror: "app",
  revolve: "app",
  loft: "app",
  sweep: "app",
  datumPlane: "app",
  datumPoint: "app",
  datumAxis: "app",
  import: "app",
  split: "app",
  boolean: "app",
  box: "app",
  cylinder: "app",
  cone: "app",
  sphere: "app",
  torus: "app",
  shell: "app",
  offsetFace: "app",
  thicken: "app",
  draft: "app",
  patternRect: "app",
  patternLinear: "app",
  patternCircular: "app",
  simplifyMesh: "app",
  cleanUp: "app",
  scale: "app",
  move: "app",
  duplicate: "app",
  joint: "app",
  removeBody: "app",
};

/** The types a plugin in this repository declares.
 *
 *  A separate table BECAUSE they are not in FeatureType, which is the app's own
 *  union and is exactly what a plugin owning a feature outright takes a type out
 *  of. Listing them by hand rather than reading the manifests is the point: the
 *  assertion below is that nothing in the application draws them, and a table
 *  built from the same manifests the application reads could not say that. */
const DRAWN_BY_PLUGIN: Record<string, string> = {
  texture: "FundaCAD.Texture",
};

const DRAWN_BY: Record<string, string> = { ...DRAWN_BY_APP, ...DRAWN_BY_PLUGIN };

const TYPES = Object.keys(DRAWN_BY);

describe("coverage of the document format", () => {
  it("draws every feature type from the application or from a named plugin", () => {
    for (const type of TYPES) {
      const owner = DRAWN_BY[type];
      const inApp = type in FEATURE_META;
      expect(inApp, `${type} says ${owner} but the application ${inApp ? "does" : "does not"} draw it`)
        .toBe(owner === "app");
    }
  });

  it("gives every mark the application draws a name and an icon", () => {
    for (const [type, meta] of Object.entries(FEATURE_META)) {
      expect(meta!.icon, type).toBeTruthy();
      expect(meta!.label, type).toBeTruthy();
    }
  });
});

describe("featureMeta", () => {
  it("answers from the application's table first", () => {
    expect(featureMeta({ type: "fillet" })).toEqual({ icon: "fillet", label: "Fillet" });
  });

  // A boolean is three commands sharing one feature type, so it is named by its
  // operation and not by its type. That rule has to keep running ahead of
  // anything a plugin says.
  it("still names a boolean by the command that made it", () => {
    expect(featureMeta({ type: "boolean", operation: "subtract" }).label).not.toBe("Boolean");
  });

  // The grey dot IS the right answer for a feature whose plugin is not
  // installed: the document opens, the history has a row, and it reads as
  // something this build does not understand, which is exactly what it is.
  it("falls back to a dot and the raw type when nothing draws it", () => {
    expect(featureMeta({ type: "texture" })).toEqual({ icon: "dot", label: "texture" });
    expect(featureMeta({ type: "from-a-newer-build" })).toEqual({
      icon: "dot", label: "from-a-newer-build",
    });
  });

  it("uses a plugin's mark once it is contributed, and forgets it after", () => {
    const off = contribute("FundaCAD.Texture", {
      features: [{ type: "texture", meta: { icon: "texture", label: "Texture" } }],
    });
    expect(featureMeta({ type: "texture" })).toEqual({ icon: "texture", label: "Texture" });
    expect(labelOf({ type: "texture" } as Feature)).toBe("Texture");
    off();
    expect(featureMeta({ type: "texture" }).label).toBe("texture");
  });

  // Asked AFTER the application's own table, so a plugin cannot rename a
  // feature it does not own by claiming the type.
  it("does not let a plugin rename one of the application's features", () => {
    contribute("Rogue", {
      features: [{ type: "fillet", meta: { icon: "skull", label: "Not Fillet" } }],
    });
    expect(featureMeta({ type: "fillet" }).label).toBe("Fillet");
  });

  it("falls back for a plugin that describes a type without a mark", () => {
    contribute("FundaCAD.Texture", { features: [{ type: "texture" }] });
    expect(featureMeta({ type: "texture" })).toEqual({ icon: "dot", label: "texture" });
  });
});
