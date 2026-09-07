// Reading a bundle nobody has seen before.
//
// The interesting part is not the fetch, which Rust does; it is what happens to
// the manifest that comes back. That file is written by whoever published the
// bundle and is therefore the least trustworthy thing in the whole flow, and it
// is also the only source for every sentence on the screen the user answers. So
// it goes through the same parser a suggested entry goes through, and a
// manifest that does not fully parse is refused rather than shown with the
// unreadable parts left out.
//
// The screen is the point of all of it. A plugin described incompletely is
// worse than one not offered.

import { describe, expect, it } from "vitest";

import { candidateFrom, originOf, type RawInspected } from "../../src/plugins/index";
import { promiseOf } from "../../src/plugins/manifest";

const GOOD = {
  id: "widgets",
  name: "Widgets",
  version: "1.2.0",
  kind: "compute",
  summary: "Adds some widgets.",
  grants: ["document.read"],
};

const raw = (manifest: unknown, over: Partial<RawInspected> = {}): RawInspected => ({
  manifest,
  sha256: "a".repeat(64),
  source: "https://plugins.example.com/widgets.zip",
  official: false,
  ...over,
});

describe("reading a stranger's bundle", () => {
  it("describes one whose manifest parses", () => {
    const c = candidateFrom(raw(GOOD), "url");
    expect(c.manifest.id).toBe("widgets");
    expect(c.manifest.grants).toEqual(["document.read"]);
    expect(c.origin).toBe("plugins.example.com");
    expect(c.from).toBe("url");
    expect(c.official).toBe(false);
  });

  it("refuses one asking for a permission this app cannot name", () => {
    // The whole reason the same parser is used: an unknown grant means the
    // screen cannot say what the plugin wants, and the only safe reading of
    // that is no.
    expect(() => candidateFrom(raw({ ...GOOD, grants: ["document.read", "gpu.direct"] }), "url"))
      .toThrow(/gpu.direct/);
  });

  it("refuses one whose permissions and their scope disagree", () => {
    expect(() => candidateFrom(raw({ ...GOOD, grants: ["network"] }), "url")).toThrow(
      /without naming any hosts/,
    );
    expect(() =>
      candidateFrom(raw({ ...GOOD, hosts: ["api.example.com"] }), "url"),
    ).toThrow(/without asking for network/);
  });

  it("refuses one that is barely a manifest at all", () => {
    for (const bad of [null, 42, "a string", [], {}, { ...GOOD, kind: "native" }]) {
      expect(() => candidateFrom(raw(bad), "url"), JSON.stringify(bad)).toThrow(
        /not installable/,
      );
    }
  });

  it("carries the digest through untouched, because the install pins on it", () => {
    const c = candidateFrom(raw(GOOD, { sha256: "b".repeat(64) }), "url");
    expect(c.sha256).toBe("b".repeat(64));
  });

  it("records the promise the screen will have shown", () => {
    // What is consented to is the grants and the kind, not the version: a later
    // version asking for the same or less must not re-prompt, and one asking
    // for more must.
    const c = candidateFrom(raw(GOOD), "url");
    expect(promiseOf(c.manifest)).toBe("compute|document.read");
  });
});

describe("official is a label", () => {
  it("comes from the far side and is not read out of the bundle", () => {
    // A bundle that says it is ours in its own manifest is exactly the one that
    // must not be believed for saying so. There is nowhere in a manifest to
    // claim it, and adding a field that looks like one changes nothing.
    const lying = { ...GOOD, official: true, publisher: "FundaCAD" };
    expect(candidateFrom(raw(lying, { official: false }), "url").official).toBe(false);
    // Control: the flag does come through when the far side sets it.
    expect(candidateFrom(raw(GOOD, { official: true }), "url").official).toBe(true);
  });

  it("is never set for a file off the disk", () => {
    // Not asserted here so much as recorded: Rust passes false for every file
    // install, because a file cannot demonstrate where it came from.
    const c = candidateFrom(raw(GOOD, { source: "C:\\Users\\x\\widgets.zip" }), "file");
    expect(c.origin).toBe("a file on this computer");
  });
});

describe("the origin shown on the screen", () => {
  it("is the host, which after the checks in Rust is the host that answers", () => {
    expect(originOf("https://plugins.example.com/a/b.zip", "url")).toBe("plugins.example.com");
    expect(originOf("https://plugins.example.com:8443/b.zip", "url")).toBe(
      "plugins.example.com:8443",
    );
    expect(originOf("https://github.com/Paraxdev/fundacad/releases/download/beta/x.zip", "url")).toBe(
      "github.com",
    );
  });

  it("says so plainly for a file", () => {
    expect(originOf("C:\\Users\\x\\widgets.zip", "file")).toBe("a file on this computer");
    expect(originOf("/home/x/widgets.zip", "file")).toBe("a file on this computer");
  });

  it("degrades to the least reassuring true thing, never to the URL", () => {
    // Unreachable in practice; Rust refuses these long before here. What
    // matters is which way it fails: a sentence about who is being trusted must
    // not fall back to echoing whatever string it was handed.
    expect(originOf("not a url at all", "url")).toBe("an unknown place");
    expect(originOf("", "url")).toBe("an unknown place");
  });
});
