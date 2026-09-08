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
// checking is therefore no longer "do the two agree" — they cannot disagree —
// but that the single copy really is single, and that what it asks for is what
// we meant to ask for.
//
// The URL rules are duplicated from src-tauri/src/plugins/bundle.rs on purpose.
// That copy is the one that is enforced; this one fails the suite before a
// build can ship an entry the enforced copy would refuse.

import { describe, expect, it } from "vitest";
import shippedRaw from "../../plugins/FundaCAD.MCP/manifest.json?raw";
import { parseManifest, promiseOf } from "../../src/plugins/manifest";
import { mcpConfigJson, mcpLaunch, officialPlugins } from "../../src/plugins";
import { bundleAsset } from "../../src/plugins/shipped";

const RELEASES = "https://github.com/Paraxdev/fundacad/releases/download/";

describe("the plugins this build offers", () => {
  it("offers only entries that could be installed", () => {
    // officialPlugins() throws on an entry its own parser refuses, so calling
    // it is the assertion. Listing the ids as well keeps a silently emptied
    // list from passing.
    const offered = officialPlugins();
    expect(offered.map((p) => p.manifest.id)).toContain("FundaCAD.MCP");
  });

  it("offers every plugin this repository has, builtins included", () => {
    // This used to assert the opposite: no builtin, because a builtin had no
    // bundle on any release and offering to download one would have been a 404
    // behind a consent screen somebody had just answered. Every one of them is
    // packaged now, so holding any of them back would be hiding a plugin that
    // exists.
    const offered = officialPlugins().map((p) => p.manifest.id).sort();
    expect(offered).toEqual([
      "FundaCAD.MCP",
      "FundaCAD.MultiColor",
      "FundaCAD.Printing",
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
});

describe("the MCP bundle and the entry that describes it", () => {
  const shipped = parseManifest(JSON.parse(shippedRaw));
  const offered = officialPlugins().find((p) => p.manifest.id === "FundaCAD.MCP")!;

  it("ships a manifest of its own that parses", () => {
    expect(shipped.ok ? "" : shipped.why).toBe("");
  });

  it("is described from that file and not from a copy of it", () => {
    // The point of the restructure, asserted rather than trusted. This suite
    // reads plugins/FundaCAD.MCP/manifest.json off disk with ?raw; the app
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
    // would turn the MCP server from a thing that drives this app into a thing
    // that can do anything, and it reaches its engine over loopback and starts
    // only the engine this app shipped.
    expect(shipped.manifest.grants).not.toContain("network");
    expect(shipped.manifest.grants).not.toContain("process.spawn");
    expect(shipped.manifest.hosts).toEqual([]);
  });
});

describe("the command line an MCP host is given", () => {
  const runtime = {
    python: "C:\\Users\\a\\AppData\\Roaming\\dev.fundacad.app\\python\\python.exe",
    pythonpath: "C:\\resources\\sidecar-runtime\\site-packages",
    sidecarDir: "C:\\resources\\sidecar-runtime\\app",
  };

  it("points at the installed server with the separator the path already uses", () => {
    const win = mcpLaunch("C:\\Users\\a\\AppData\\Roaming\\dev.fundacad.app\\plugins\\FundaCAD.MCP", runtime);
    expect(win.args).toEqual([
      "C:\\Users\\a\\AppData\\Roaming\\dev.fundacad.app\\plugins\\FundaCAD.MCP\\server.py",
    ]);
    const posix = mcpLaunch("/home/a/.local/share/dev.fundacad.app/plugins/FundaCAD.MCP", runtime);
    expect(posix.args).toEqual(["/home/a/.local/share/dev.fundacad.app/plugins/FundaCAD.MCP/server.py"]);
  });

  it("carries the packages and the engine's whereabouts", () => {
    const cfg = mcpLaunch("/plugins/FundaCAD.MCP", runtime);
    expect(cfg.command).toBe(runtime.python);
    expect(cfg.env.PYTHONPATH).toBe(runtime.pythonpath);
    // Without this an installed plugin looks for the engine beside itself,
    // under the app data directory, where there has never been one.
    expect(cfg.env.FUNDACAD_SIDECAR_DIR).toBe(runtime.sidecarDir);
  });

  it("leaves out what it does not have rather than setting it empty", () => {
    // An empty PYTHONPATH is not the same as no PYTHONPATH: it puts the
    // current directory on the path in some interpreters, which is exactly the
    // kind of surprise a launch command should not carry.
    const cfg = mcpLaunch("/plugins/FundaCAD.MCP", { ...runtime, pythonpath: null });
    expect("PYTHONPATH" in cfg.env).toBe(false);
  });

  it("is the block an MCP host expects, not just a hint at one", () => {
    const parsed = JSON.parse(mcpConfigJson("/plugins/FundaCAD.MCP", runtime));
    expect(parsed.mcpServers.fundacad.args).toEqual(["/plugins/FundaCAD.MCP/server.py"]);
    expect(parsed.mcpServers.fundacad.command).toBe(runtime.python);
  });
});
