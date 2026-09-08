// A plugin is a directory under plugins/ with a manifest.json in it.
//
// That sentence is the structure, and three separate programs now depend on it
// being true: the app reads those manifests to draw the Plugins screen,
// scripts/build-plugins.py reads them to decide what to package, and the
// installer reads the packaged copy back out of the zip to check it against
// what the user agreed to. This file is where the rule is checked once for all
// three, at the only moment it is cheap to fix.
//
// WHAT USED TO BE HERE INSTEAD: nothing, because there was nothing to check.
// The shipped manifests were JSON literals inside registry.ts and index.ts, and
// the plugin's own directory carried a second copy for the bundle. Two copies
// of a permission list is two lists that can disagree, and the copy that would
// have won an argument is the one the consent screen never showed.

import { describe, expect, it } from "vitest";

import { bundleAsset, shippedPlugins } from "../../src/plugins/shipped";
import { PLUGIN_KINDS } from "../../src/plugins/manifest";

// Every file at the top of every plugin directory. `?raw` because what is
// wanted is the file LIST; the contents are incidental, and the plugins are
// small enough that reading them costs nothing.
const FILES = import.meta.glob("../../plugins/*/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const has = (id: string, name: string) =>
  Object.keys(FILES).some((p) => p.endsWith(`/plugins/${id}/${name}`));

/** What a plugin of each kind must contain to be worth shipping. Mirrors ENTRY
 *  in scripts/build-plugins.py, which is the copy that refuses to package one
 *  without it. This copy fails a test instead of a release. */
const ENTRY: Record<string, string> = {
  // A builtin's entry point is BUILT from main.ts by
  // scripts/build-plugin-code.mjs, so what is on disk is the source.
  builtin: "main.ts",
  process: "server.py",
  compute: "plugin.js",
  panel: "index.html",
};

describe("the plugins in this repository", () => {
  it("has some at all", () => {
    // The control for every case below. A glob resolving to nothing would make
    // all of them pass while checking not one directory.
    expect(shippedPlugins().length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(FILES).length).toBeGreaterThan(10);
  });

  it("names each one after the directory it lives in", () => {
    // shippedPlugins() throws on a mismatch, so calling it is the assertion.
    // The directory name is what the release asset is named after and what the
    // app installs into; a manifest that said something else would install
    // under one name and be looked for under another.
    for (const { manifest, dir } of shippedPlugins()) {
      expect(manifest.id).toBe(dir);
    }
  });

  it("describes each one in terms the install screen can render", () => {
    // Also a call-is-the-assertion: shippedPlugins() runs every manifest
    // through the same parseManifest a stranger's bundle gets, so one of ours
    // that could not be installed cannot be offered either.
    for (const { manifest } of shippedPlugins()) {
      expect(PLUGIN_KINDS).toContain(manifest.kind);
      expect(manifest.name).not.toBe("");
      expect(manifest.summary).not.toBe("");
      expect(manifest.grants.length).toBeGreaterThan(0);
    }
  });

  it("is every directory, with nothing held back for shipping inside the app", () => {
    // There used to be two lists here, and the split was the point of the test:
    // a builtin's code WAS the app's code, so it had no bundle on any release
    // and offering to download one would have been a 404 behind a consent
    // screen somebody had just answered.
    //
    // Nothing ships inside the app now. `builtin` still means something and
    // what it means is REACH — it runs in the application's own JavaScript
    // context — which was always a fact about what a plugin can do rather than
    // about where it came from.
    expect(shippedPlugins().map((p) => p.manifest.id)).toEqual([
      "FundaCAD.MCP",
      "FundaCAD.MultiColor",
      "FundaCAD.Printing",
      "FundaCAD.SpaceMouse",
      "FundaCAD.Texture",
    ]);
  });

  it("gives every plugin the entry point its kind needs", () => {
    // A bundle missing its entry point installs perfectly and then does
    // nothing, which is the most annoying shape a failure can have.
    for (const { manifest, dir } of shippedPlugins()) {
      const entry = ENTRY[manifest.kind];
      expect(entry, `no entry point defined for kind ${manifest.kind}`).toBeTruthy();
      expect(has(dir, entry!), `plugins/${dir} is kind ${manifest.kind} and has no ${entry}`).toBe(true);
    }
    // The control: the check can fail. Without it, a `has()` that had stopped
    // matching anything would pass every case above.
    expect(has("FundaCAD.MCP", "server.py")).toBe(true);
    expect(has("FundaCAD.MCP", "not-a-file.py")).toBe(false);
  });

  it("explains itself in a README beside the manifest", () => {
    // JSON has no comments, and the reasoning behind a grant list is the part
    // worth keeping: why the printer connection asks for process.spawn and why
    // the MCP server does not. That reasoning used to sit next to the JSON
    // literals in registry.ts and had nowhere to go when they left.
    for (const { dir } of shippedPlugins()) {
      expect(has(dir, "README.md"), `plugins/${dir} has no README.md`).toBe(true);
    }
  });

  it("names a plugin's asset the one way", () => {
    // The app builds a download URL from this and the packager writes a file
    // with it. Two spellings is a download that 404s.
    expect(bundleAsset("FundaCAD.MCP")).toBe("plugin-FundaCAD.MCP.zip");
  });
});
