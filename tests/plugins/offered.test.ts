// The plugins this build offers, and the bundle it will actually download.
//
// The install only succeeds if three things agree: the entry compiled into the
// app, the screen the user answered, and the `plugin.json` inside the zip. The
// middle one is rendered from the first, so the join that can silently come
// apart is the first against the third, and it comes apart in the worst
// possible place: at the end of a download, in front of somebody who has just
// said yes. Hence this file, which holds them together at build time.
//
// The URL rules are duplicated from src-tauri/src/plugins/bundle.rs on purpose.
// That copy is the one that is enforced; this one fails the suite before a
// build can ship an entry the enforced copy would refuse.

import { describe, expect, it } from "vitest";
import shippedRaw from "../../plugins/mcp/plugin.json?raw";
import { parseManifest, promiseOf } from "../../src/plugins/manifest";
import { mcpConfigJson, mcpLaunch, officialPlugins } from "../../src/plugins";

const RELEASES = "https://github.com/Paraxdev/fundacad/releases/download/";

describe("the plugins this build offers", () => {
  it("offers only entries that could be installed", () => {
    // officialPlugins() throws on an entry its own parser refuses, so calling
    // it is the assertion. Listing the ids as well keeps a silently emptied
    // list from passing.
    const offered = officialPlugins();
    expect(offered.map((p) => p.manifest.id)).toContain("mcp");
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

describe("the MCP bundle against the entry that describes it", () => {
  const shipped = parseManifest(JSON.parse(shippedRaw));
  const offered = officialPlugins().find((p) => p.manifest.id === "mcp")!;

  it("ships a manifest of its own that parses", () => {
    expect(shipped.ok ? "" : shipped.why).toBe("");
  });

  it("asks for exactly what the install screen says it will", () => {
    if (!shipped.ok) throw new Error(shipped.why);
    // The same comparison grants_match() makes on the far side of the
    // download, made here where it is cheap to fix.
    expect(shipped.manifest.kind).toBe(offered.manifest.kind);
    expect([...shipped.manifest.grants].sort()).toEqual([...offered.manifest.grants].sort());
    expect([...shipped.manifest.hosts].sort()).toEqual([...offered.manifest.hosts].sort());
    expect(promiseOf(shipped.manifest)).toBe(promiseOf(offered.manifest));
  });

  it("would notice if the bundle grew a permission", () => {
    // The control for the test above. Without it, that test passes just as
    // happily against a comparison that has stopped comparing.
    if (!shipped.ok) throw new Error(shipped.why);
    const greedier = parseManifest({
      ...JSON.parse(shippedRaw),
      grants: [...shipped.manifest.grants, "process.spawn"],
    });
    if (!greedier.ok) throw new Error(greedier.why);
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
    const win = mcpLaunch("C:\\Users\\a\\AppData\\Roaming\\dev.fundacad.app\\plugins\\mcp", runtime);
    expect(win.args).toEqual([
      "C:\\Users\\a\\AppData\\Roaming\\dev.fundacad.app\\plugins\\mcp\\server.py",
    ]);
    const posix = mcpLaunch("/home/a/.local/share/dev.fundacad.app/plugins/mcp", runtime);
    expect(posix.args).toEqual(["/home/a/.local/share/dev.fundacad.app/plugins/mcp/server.py"]);
  });

  it("carries the packages and the engine's whereabouts", () => {
    const cfg = mcpLaunch("/plugins/mcp", runtime);
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
    const cfg = mcpLaunch("/plugins/mcp", { ...runtime, pythonpath: null });
    expect("PYTHONPATH" in cfg.env).toBe(false);
  });

  it("is the block an MCP host expects, not just a hint at one", () => {
    const parsed = JSON.parse(mcpConfigJson("/plugins/mcp", runtime));
    expect(parsed.mcpServers.fundacad.args).toEqual(["/plugins/mcp/server.py"]);
    expect(parsed.mcpServers.fundacad.command).toBe(runtime.python);
  });
});
