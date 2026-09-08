// Which plugins run.
//
// TWO QUESTIONS, and the point of this file is that both are asked. A plugin
// runs when it is INSTALLED on this machine and has not been SWITCHED OFF.
// Neither answers the other: a bundle whose source lives in this repository is
// not the same as somebody having it, and something installed and turned off is
// still installed.
//
// A third source exists and only in a development build: the plugin directories
// of this repository, compiled straight into the dev bundle so an edit is
// visible on reload rather than after a package-publish-install round trip.
//
// The decision is tested here as the pure function it is. That is not a
// convenience: the alternative is driving it through a dynamic import of an
// `import.meta.glob`, and a test cannot stand in for that glob — an earlier
// version of this file tried, the mock silently did not apply, and what it
// actually exercised was all four real plugins starting at once. A test that
// looks like it controls its inputs and does not is worse than no test.

import { describe, expect, it } from "vitest";

import { activeIds } from "../../src/plugins/activate";
import { shippedPlugins } from "../../src/plugins/shipped";

/** Nothing switched off. */
const allOn = () => true;

describe("which plugins are active", () => {
  it("runs what is installed", () => {
    expect(activeIds(["A.One", "B.Two"], [], allOn)).toEqual(["A.One", "B.Two"]);
  });

  it("runs nothing when nothing is installed", () => {
    // The ordinary state of a fresh install: the app ships the loader and
    // nothing to load.
    expect(activeIds([], [], allOn)).toEqual([]);
  });

  it("does not run something merely because its source is in this repository", () => {
    // The distinction the whole arrangement rests on. Every plugin here has a
    // directory, a manifest and code; none of that is somebody having it.
    const inRepo = shippedPlugins().map((p) => p.dir);
    expect(inRepo.length).toBeGreaterThan(3);
    expect(activeIds([], [], allOn)).toEqual([]);
  });

  it("runs what a development build compiled in", () => {
    // The dev half, and the only reason the second argument exists: an edit to
    // a plugin has to be visible on reload rather than after a
    // package-publish-install round trip.
    expect(activeIds([], ["A.One"], allOn)).toEqual(["A.One"]);
  });

  it("counts a plugin once when it is both installed and compiled in", () => {
    // The ordinary state of `vite dev` against a machine that also has the
    // released bundle installed. Starting it twice would contribute its menus
    // twice and leave one teardown holding nothing.
    expect(activeIds(["A.One"], ["A.One"], allOn)).toEqual(["A.One"]);
  });

  it("does not run one that is switched off", () => {
    // Installed and off is a real state: somebody keeping a plugin they are not
    // using, usually to find out whether it was the cause of something. Its
    // bundle stays on disk and its surfaces do not.
    const enabled = (id: string) => id !== "B.Two";
    expect(activeIds(["A.One", "B.Two"], [], enabled)).toEqual(["A.One"]);
  });

  it("switches off a dev-compiled one too", () => {
    // The control for the case above: a switch that only reached installed
    // plugins would be dead for the whole of development, which is where it
    // would most often be reached for.
    const enabled = (id: string) => id !== "A.One";
    expect(activeIds([], ["A.One", "B.Two"], enabled)).toEqual(["B.Two"]);
  });

  it("is in a fixed order however the two sets are given", () => {
    // The order plugins start in decides the order their menu rows and ribbon
    // groups appear. Leaving it to Set insertion order would make that depend
    // on which of the two happened to name one first.
    expect(activeIds(["C.Three", "A.One"], ["B.Two"], allOn))
      .toEqual(["A.One", "B.Two", "C.Three"]);
    expect(activeIds(["B.Two"], ["A.One", "C.Three"], allOn))
      .toEqual(["A.One", "B.Two", "C.Three"]);
  });
});
