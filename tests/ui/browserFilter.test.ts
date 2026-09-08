// Which sections each filter shows. The rule that matters is the one about
// what happens to a section nobody thought about, see the last test.

import { describe, it, expect } from "vitest";
import {
  BROWSER_FILTERS,
  asBrowserFilter,
  sectionVisible,
  type BrowserFilter,
  type BrowserSection,
} from "../../src/ui/browserFilter";

const SECTIONS: BrowserSection[] = ["origin", "planes", "palette", "bodies", "sketches"];
const shown = (f: BrowserFilter) => SECTIONS.filter((s) => sectionVisible(f, s));

describe("sectionVisible", () => {
  it("shows everything under All", () => {
    expect(shown("all")).toEqual(SECTIONS);
  });

  it("shows bodies with their palette, and nothing else", () => {
    // The palette rides with the bodies rather than standing alone: it only
    // renders when bodies exist and it is the surface for their colours.
    expect(shown("bodies")).toEqual(["palette", "bodies"]);
  });

  it("counts Origin as planes and axes", () => {
    // Origin is not a construction plane, so it is its own section, but a user
    // asking for "planes and axes" means both.
    expect(shown("planes")).toEqual(["origin", "planes"]);
  });

  it("shows only sketches under Sketches", () => {
    expect(shown("sketches")).toEqual(["sketches"]);
  });

  it("hides a section no filter has heard of", () => {
    // The table lists what each filter SHOWS, not what it hides, which is what
    // makes this the default. Listing the hidden ones instead would leak every
    // new section into every narrow filter until someone remembered to add it.
    const unknown = "annotations" as BrowserSection;
    expect(sectionVisible("all", unknown)).toBe(true);
    for (const f of ["bodies", "planes", "sketches"] as BrowserFilter[]) {
      expect(sectionVisible(f, unknown)).toBe(false);
    }
  });

  it("gives every filter something to show", () => {
    // A filter that can never produce a row reads as a broken control. This is
    // why there is no Images filter: the app has no reference-image feature.
    for (const f of BROWSER_FILTERS) expect(shown(f.id).length).toBeGreaterThan(0);
  });
});

describe("asBrowserFilter", () => {
  it("passes the listed ids and refuses everything else", () => {
    for (const f of BROWSER_FILTERS) expect(asBrowserFilter(f.id)).toBe(f.id);
    for (const bad of ["images", "Bodies", "", null, 0, {}, ["all"]]) {
      expect(asBrowserFilter(bad)).toBeNull();
    }
  });
});
