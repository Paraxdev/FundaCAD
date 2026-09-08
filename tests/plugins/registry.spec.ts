// The built-in capability registry, and the two promises it makes.
//
// FIRST: a capability hides, it never deletes. That was featureFlags' rule and
// it survives the move, which is why the "off" cases below assert on what a
// gate returns and never on what a document holds.
//
// SECOND, and new: what somebody already chose is still chosen. This module
// replaced `fundacad.features` with `fundacad.plugins`, and a migration nobody
// tests is a migration that silently resets everyone's settings on the build it
// ships in. Every case that matters here is really about that.
//
// The state is read once at module load, so each case re-imports the module
// against a fresh localStorage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "fundacad.plugins";
const FLAGS_KEY = "fundacad.features";
const FLAGS_OLD = "sindricad.features";

async function load(stored?: Record<string, string>) {
  localStorage.clear();
  for (const [k, v] of Object.entries(stored ?? {})) localStorage.setItem(k, v);
  vi.resetModules();
  return import("../../src/plugins/registry");
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("what is on before anybody says anything", () => {
  it("keeps the two capabilities the app always had, and leaves the third off", async () => {
    const m = await load();
    // On. These were not optional before this existed, and an upgrade that
    // silently took away a working printer connection would be a regression
    // wearing the word "plugin".
    expect(m.printingEnabled()).toBe(true);
    expect(m.spaceMouseEnabled()).toBe(true);
    // Off, as it shipped. It answers to hardware nobody has said they own.
    expect(m.multiMaterialEnabled()).toBe(false);
  });

  it("describes every built-in in terms the install screen can render", async () => {
    // builtinPlugins() throws on an entry its own parser refuses, so calling it
    // is the assertion. Naming the ids as well keeps a silently emptied table
    // from passing.
    const m = await load();
    expect(m.builtinPlugins().map((p) => p.manifest.id)).toEqual([
      "FundaCAD.MultiColor",
      "FundaCAD.Printing",
      "FundaCAD.SpaceMouse",
    ]);
    for (const p of m.builtinPlugins()) {
      expect(p.manifest.kind).toBe("builtin");
      expect(p.manifest.grants.length).toBeGreaterThan(0);
    }
  });
});

describe("the setting somebody already made", () => {
  it("carries multi-material forward from the feature flags it replaced", async () => {
    const m = await load({ [FLAGS_KEY]: JSON.stringify({ multiColor: true }) });
    expect(m.multiMaterialEnabled()).toBe(true);
    // The control. Without it this test passes just as well against a module
    // that has started returning true for everything.
    const off = await load({ [FLAGS_KEY]: JSON.stringify({ multiColor: false }) });
    expect(off.multiMaterialEnabled()).toBe(false);
  });

  it("reaches back through the older names too", async () => {
    // readSetting walks the rename chain. Somebody who last opened the app two
    // names ago has their answer under the oldest key and nothing under the
    // newer ones.
    const m = await load({ [FLAGS_OLD]: JSON.stringify({ multiColor: true }) });
    expect(m.multiMaterialEnabled()).toBe(true);
  });

  it("carries the capabilities forward through their rename", async () => {
    // The ids gained a publisher segment. These three are in people's stored
    // state right now under the old spelling, and dropping them would put every
    // capability back to its default: multi-material would switch itself back
    // ON for everyone who had turned it off, which is precisely what a toggle
    // exists to prevent.
    const m = await load({
      [KEY]: JSON.stringify({ "multi-material": true, printing: false, spacemouse: false }),
    });
    expect(m.multiMaterialEnabled()).toBe(true);
    expect(m.printingEnabled()).toBe(false);
    expect(m.spaceMouseEnabled()).toBe(false);

    // The control. Without it this passes just as well against a module that
    // ignores the stored value and answers from somewhere else.
    const other = await load({
      [KEY]: JSON.stringify({ "multi-material": false, printing: true, spacemouse: true }),
    });
    expect(other.multiMaterialEnabled()).toBe(false);
    expect(other.printingEnabled()).toBe(true);
  });

  it("lets the new name win when both are stored", async () => {
    // A state holding both is a session that toggled something after upgrading,
    // and what it did then is more recent than what it did before.
    const m = await load({
      [KEY]: JSON.stringify({ printing: false, "FundaCAD.Printing": true }),
    });
    expect(m.printingEnabled()).toBe(true);
  });

  it("prefers its own key once there is one", async () => {
    const m = await load({
      [KEY]: JSON.stringify({ "FundaCAD.MultiColor": false }),
      [FLAGS_KEY]: JSON.stringify({ multiColor: true }),
    });
    // The new key is the answer to the question this module asks; the old one
    // is an answer to a question that was asked before it existed.
    expect(m.multiMaterialEnabled()).toBe(false);
  });

  it("does not let one capability's stored value decide another's", async () => {
    // The reason the state is a map sanitised per field rather than
    // all-or-nothing: a capability added in a later version must not cost
    // somebody the setting they chose for an older one.
    const m = await load({ [KEY]: JSON.stringify({ "FundaCAD.Printing": false }) });
    expect(m.printingEnabled()).toBe(false);
    expect(m.spaceMouseEnabled()).toBe(true);
    expect(m.multiMaterialEnabled()).toBe(false);
  });

  it("treats an unreadable value as no value rather than as a reason to fail", async () => {
    const m = await load({ [KEY]: "{not json" });
    expect(m.printingEnabled()).toBe(true);
    expect(m.multiMaterialEnabled()).toBe(false);
  });

  it("ignores a stored entry that is not a yes or a no", async () => {
    const m = await load({ [KEY]: JSON.stringify({ printing: "yes", spacemouse: null }) });
    expect(m.printingEnabled()).toBe(true);
    expect(m.spaceMouseEnabled()).toBe(true);
  });
});

describe("turning one on and off", () => {
  it("persists the change and tells whoever is listening", async () => {
    const m = await load();
    let told = 0;
    const off = m.onPluginChange(() => told++);

    m.setPluginEnabled("FundaCAD.Printing", false);
    expect(m.printingEnabled()).toBe(false);
    expect(told).toBe(1);
    expect(JSON.parse(localStorage.getItem(KEY)!)["FundaCAD.Printing"]).toBe(false);

    // Setting it to what it already is is not a change, and must not wake
    // every surface in the window.
    m.setPluginEnabled("FundaCAD.Printing", false);
    expect(told).toBe(1);

    off();
    m.setPluginEnabled("FundaCAD.Printing", true);
    expect(told).toBe(1);
    expect(m.printingEnabled()).toBe(true);
  });

  it("hands out a new object each time, so a holder can compare identity", async () => {
    const m = await load();
    const before = m.pluginState();
    m.setPluginEnabled("FundaCAD.Printing", false);
    expect(m.pluginState()).not.toBe(before);
    // And the old one is unchanged, which is what makes the comparison mean
    // something.
    expect(before["FundaCAD.Printing"]).toBe(true);
  });

  it("refuses an id this build does not have", async () => {
    const m = await load();
    m.setPluginEnabled("not-a-capability", true);
    expect(m.pluginEnabled("not-a-capability")).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(null);
  });
});
