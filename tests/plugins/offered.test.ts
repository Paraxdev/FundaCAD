// The plugins this build offers, and the bundle it will actually download.
//
// The install only succeeds if three things agree: what the app offers, the
// screen the user answered, and the `manifest.json` inside the zip. That used
// to be three separate artefacts, and the join that could silently come apart
// was the first against the third, in the worst possible place: at the end of a
// download, in front of somebody who had just said yes. This file held them
// together at build time.
//
// IT IS NOW ONE FILE, and these tests changed shape accordingly. The app reads
// plugins/<id>/manifest.json directly and the packager puts that same file at
// the top of the zip, so there is no second copy left to drift. What is worth
// checking is therefore no longer "do the two agree", they cannot disagree,
// but that the single copy really is single, and that what it asks for is what
// we meant to ask for.
//
// The URL rules are duplicated from src-tauri/src/plugins/bundle.rs on purpose.
// That copy is the one that is enforced; this one fails the suite before a
// build can ship an entry the enforced copy would refuse.

import { describe, expect, it } from "vitest";
import shippedRaw from "../../plugins/FundaCAD.Screws/manifest.json?raw";
import { parseManifest, promiseOf } from "../../src/plugins/manifest";
import { officialPlugins, pluginReleaseTag } from "../../src/plugins";
import { bundleAsset } from "../../src/plugins/shipped";

const RELEASES = "https://github.com/Paraxdev/fundacad/releases/download/";

describe("the plugins this build offers", () => {
  it("offers only entries that could be installed", () => {
    // officialPlugins() throws on an entry its own parser refuses, so calling
    // it is the assertion. Listing the ids as well keeps a silently emptied
    // list from passing.
    const offered = officialPlugins();
    expect(offered.map((p) => p.manifest.id)).toContain("FundaCAD.Screws");
  });

  it("offers every plugin this repository has, builtins included", () => {
    // This used to assert the opposite: no builtin, because a builtin had no
    // bundle on any release and offering to download one would have been a 404
    // behind a consent screen somebody had just answered. Every one of them is
    // packaged now, so holding any of them back would be hiding a plugin that
    // exists.
    const offered = officialPlugins().map((p) => p.manifest.id).sort();
    expect(offered).toEqual([
      "FundaCAD.ExtraParameters",
      "FundaCAD.MultiColor",
      "FundaCAD.PrintToolbox",
      "FundaCAD.Printing",
      "FundaCAD.Screws",
      "FundaCAD.SpaceMouse",
      "FundaCAD.Texture",
    ]);
    // ...and one of them really is a builtin, so this is not passing because
    // the kind has quietly stopped being used.
    expect(officialPlugins().some((p) => p.manifest.kind === "builtin")).toBe(true);
  });

  it("asks for the asset the packager actually writes", () => {
    // One function names it on both sides. Without that, the app can come to
    // expect a file the release does not carry, and the way you find out is a
    // download that 404s.
    for (const p of officialPlugins()) {
      expect(p.asset).toBe(bundleAsset(p.manifest.id));
    }
  });

  it("downloads from this project's own releases and nowhere else", () => {
    for (const p of officialPlugins()) {
      expect(p.url.startsWith(RELEASES)).toBe(true);
      expect(p.url).not.toContain("..");
      expect(p.url).not.toContain("@");
      expect(p.url.slice(RELEASES.length)).toBe(`${p.tag}/${p.asset}`);
    }
  });

  it("installs from the release built with the same engine as the app", () => {
    // A Rust engine build runs plugin geometry as components, which its own
    // release carries from the same commit as its host.
    expect(pluginReleaseTag("python")).toBe("beta");
    expect(pluginReleaseTag("rust")).toBe("alpha");
    for (const p of officialPlugins(pluginReleaseTag("rust"))) {
      expect(p.url).toBe(`${RELEASES}alpha/${p.asset}`);
    }
  });
});

describe("a bundle and the entry that describes it", () => {
  const shipped = parseManifest(JSON.parse(shippedRaw));
  const offered = officialPlugins().find((p) => p.manifest.id === "FundaCAD.Screws")!;

  it("ships a manifest of its own that parses", () => {
    expect(shipped.ok ? "" : shipped.why).toBe("");
  });

  it("is described from that file and not from a copy of it", () => {
    // The point of the restructure, asserted rather than trusted. This suite
    // reads plugins/FundaCAD.Screws/manifest.json off disk with ?raw; the app
    // reaches the same bytes through import.meta.glob. If the app ever grows a
    // second copy, this is what tells you before a release does.
    if (!shipped.ok) throw new Error(shipped.why);
    expect(offered.manifest).toEqual(shipped.manifest);
    expect(promiseOf(offered.manifest)).toBe(promiseOf(shipped.manifest));
  });

  it("would notice a manifest that had drifted", () => {
    // The control for the test above: the comparison can still fail. Without
    // it, `toEqual` on two references to one object passes no matter what
    // either of them says.
    if (!shipped.ok) throw new Error(shipped.why);
    const greedier = parseManifest({
      ...JSON.parse(shippedRaw),
      grants: [...shipped.manifest.grants, "process.spawn"],
    });
    if (!greedier.ok) throw new Error(greedier.why);
    expect(greedier.manifest).not.toEqual(offered.manifest);
    expect(promiseOf(greedier.manifest)).not.toBe(promiseOf(offered.manifest));
  });

  it("does not quietly hold the permissions it has no business holding", () => {
    if (!shipped.ok) throw new Error(shipped.why);
    // Not a style preference. `network` and `process.spawn` are the two that
    // would turn a fastener library into a thing that can do anything.
    expect(shipped.manifest.grants).not.toContain("network");
    expect(shipped.manifest.grants).not.toContain("process.spawn");
    expect(shipped.manifest.hosts).toEqual([]);
  });
});
