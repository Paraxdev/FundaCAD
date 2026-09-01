// What a saved document is called on disk, across two renames.
//
// The rule the module exists to hold is one-way: the extension NEW documents
// are saved as changes with the brand, and every extension the app has ever
// used keeps opening forever. There is no upgrade step that can reach a file
// already sitting on someone's disk, so a name dropped from the read list is
// that person's work refusing to open.

import { describe, expect, it } from "vitest";
import {
  DOC_EXT,
  DOC_EXTS,
  LEGACY_DOC_EXTS,
  isDocumentExt,
  stripDocumentExt,
} from "../../src/io/documentExt";

describe("documentExt", () => {
  it("saves as the current name", () => {
    expect(DOC_EXT).toBe("funda");
  });

  it("still opens both names it used before", () => {
    // Named literally rather than read off the constant: the point of the test
    // is that these two exact strings survive, and asserting the constant
    // against itself would pass with the list emptied.
    expect(LEGACY_DOC_EXTS).toEqual(["neocad", "sindri"]);
    expect(isDocumentExt("neocad")).toBe(true);
    expect(isDocumentExt("sindri")).toBe(true);
  });

  it("opens the current name and bare json too", () => {
    expect(isDocumentExt("funda")).toBe(true);
    expect(isDocumentExt("json")).toBe(true); // pre-v5 documents are plain JSON
    expect(DOC_EXTS).toContain(DOC_EXT);
  });

  it("is case-insensitive, and survives a name with no dot", () => {
    expect(isDocumentExt("FUNDA")).toBe(true);
    expect(isDocumentExt("NeoCad")).toBe(true);
    expect(isDocumentExt(undefined)).toBe(false);
    expect(isDocumentExt(null)).toBe(false);
  });

  it("claims nothing that is not ours", () => {
    expect(isDocumentExt("stl")).toBe(false);
    expect(isDocumentExt("step")).toBe(false);
    expect(isDocumentExt("")).toBe(false);
  });

  it("strips whichever of the three names a file carries", () => {
    // An export derives its name from this, so a missed extension shows up as
    // `bracket.neocad.stl`.
    expect(stripDocumentExt("bracket.funda")).toBe("bracket");
    expect(stripDocumentExt("bracket.neocad")).toBe("bracket");
    expect(stripDocumentExt("bracket.sindri")).toBe("bracket");
    expect(stripDocumentExt("bracket.NEOCAD")).toBe("bracket");
  });

  it("leaves a name that has no extension of ours alone", () => {
    expect(stripDocumentExt("bracket.stl")).toBe("bracket.stl");
    expect(stripDocumentExt("bracket")).toBe("bracket");
    // only the LAST one, and only at the end
    expect(stripDocumentExt("v1.funda.funda")).toBe("v1.funda");
    expect(stripDocumentExt("funda.stl")).toBe("funda.stl");
  });
});
