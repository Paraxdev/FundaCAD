// The update the Plugins section offers for an installed plugin: a newer
// version, or a bundle whose version is current and whose files the engine
// cannot run, which the Python beta's plugin bundles are.

import { describe, expect, it } from "vitest";
import { officialPlugins, type InstalledPlugin } from "../../src/plugins";
import { compareVersions, updateFor } from "../../src/plugins/updates";

function installed(id: string, over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const offer = officialPlugins().find((p) => p.manifest.id === id)!;
  const m = offer.manifest;
  return {
    id,
    version: m.version,
    promise: "",
    source: offer.url,
    sha256: "",
    installedAt: 0,
    dir: "",
    consented: { kind: m.kind, version: m.version, grants: [...m.grants], hosts: [...m.hosts] },
    official: true,
    component: true,
    ...over,
  };
}

describe("plugin updates", () => {
  it("compares versions number by number", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
  });

  it("offers the same version when the installed copy has no component the engine can run", () => {
    const offered = officialPlugins();
    const rec = installed("FundaCAD.PrintToolbox", { component: false });
    const u = updateFor(rec, offered);
    expect(u).not.toBeNull();
    expect(u!.offer.manifest.id).toBe("FundaCAD.PrintToolbox");
    expect(u!.reason).toMatch(/no component for FundaCAD 1\.0/);
    expect(u!.covered).toBe(true);
  });

  it("offers nothing for a current copy that runs", () => {
    expect(updateFor(installed("FundaCAD.Screws"), officialPlugins())).toBeNull();
  });

  it("does not ask for a component from a plugin that has no geometry", () => {
    const rec = installed("FundaCAD.SpaceMouse", { component: false });
    expect(updateFor(rec, officialPlugins())).toBeNull();
  });

  it("offers a newer version over an older one", () => {
    const rec = installed("FundaCAD.Screws", { version: "1.0.0" });
    const u = updateFor(rec, officialPlugins());
    expect(u?.reason).toMatch(/^Version \d+\.\d+\.\d+ is available\.$/);
  });

  it("asks again when the new version wants more than was agreed to", () => {
    const rec = installed("FundaCAD.Screws", { version: "0.1.0" });
    rec.consented.grants = [];
    const u = updateFor(rec, officialPlugins());
    const wants = officialPlugins().find((p) => p.manifest.id === "FundaCAD.Screws")!.manifest.grants;
    expect(u?.covered).toBe(wants.length === 0);
  });
});
