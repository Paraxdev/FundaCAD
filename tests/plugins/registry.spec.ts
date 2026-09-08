// Which installed plugins are switched off, and what survives an upgrade.
//
// OFF IS THE EXCEPTION. A plugin runs because somebody installed it, so nothing
// has to be recorded for that; what is recorded is the smaller and more
// surprising fact, that somebody installed one and then turned it off. Every
// case here is really about one of two things: that the exception is honoured,
// and that a choice somebody already made is still their choice after an
// upgrade.
//
// This file used to test the opposite arrangement, an on/off state per
// capability compiled into the app, with a default per capability read from its
// manifest, because "installed" was not a question those three had an answer
// to. Nothing ships inside the app now.
//
// The state is read once at module load, so each case re-imports the module
// against a fresh localStorage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "fundacad.plugins";
const ID = "FundaCAD.Printing";
const OTHER = "FundaCAD.SpaceMouse";

async function load(stored?: Record<string, string>) {
  localStorage.clear();
  for (const [k, v] of Object.entries(stored ?? {})) localStorage.setItem(k, v);
  vi.resetModules();
  return import("../../src/plugins/registry");
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("what is running before anybody says anything", () => {
  it("runs everything, because installing it was the answer", async () => {
    const m = await load();
    expect(m.pluginEnabled(ID)).toBe(true);
    expect(m.pluginEnabled("Someone.Else")).toBe(true);
    expect([...m.disabledPlugins()]).toEqual([]);
  });
});

describe("turning one off and on", () => {
  it("persists the change and tells whoever is listening", async () => {
    const m = await load();
    let heard = 0;
    const off = m.onPluginChange(() => { heard++; });

    m.setPluginEnabled(ID, false);
    expect(m.pluginEnabled(ID)).toBe(false);
    expect(heard).toBe(1);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([ID]);

    m.setPluginEnabled(ID, true);
    expect(m.pluginEnabled(ID)).toBe(true);
    expect(heard).toBe(2);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);

    off();
    m.setPluginEnabled(ID, false);
    expect(heard).toBe(2); // and stops when asked to
  });

  it("says nothing when nothing changed", async () => {
    // Every surface that listens rebuilds itself, and a plugin's own activate()
    // runs off this. A write that re-announced the state it was already in
    // would restart everything on every no-op.
    const m = await load();
    let heard = 0;
    m.onPluginChange(() => { heard++; });
    m.setPluginEnabled(ID, true); // already on
    m.setPluginEnabled(ID, true);
    expect(heard).toBe(0);
  });

  it("hands out a new set each time, so a holder can compare identity", async () => {
    const m = await load();
    const before = m.disabledPlugins();
    m.setPluginEnabled(ID, false);
    expect(m.disabledPlugins()).not.toBe(before);
    expect(before.has(ID)).toBe(false); // and the old one was not mutated
  });

  it("takes an id this build has never heard of", async () => {
    // It used to refuse one, because the set of capabilities was fixed at build
    // time and an unknown id could only be a mistake. Anybody may publish a
    // plugin now, so an id this build does not recognise is the ordinary case
    // and switching it off has to work.
    const m = await load();
    m.setPluginEnabled("Someone.Else", false);
    expect(m.pluginEnabled("Someone.Else")).toBe(false);
  });
});

describe("the setting somebody already made", () => {
  it("reads the map this key used to hold", async () => {
    // The older shape was {id: boolean}, with an entry per capability compiled
    // into the app. A stored `false` there means exactly what an entry in the
    // list means now, so the migration is a read; the next write saves the new
    // shape and the old one is never written again.
    const m = await load({
      [KEY]: JSON.stringify({ [ID]: false, [OTHER]: true }),
    });
    expect(m.pluginEnabled(ID)).toBe(false);
    expect(m.pluginEnabled(OTHER)).toBe(true);
  });

  it("saves the new shape once anything changes", async () => {
    const m = await load({ [KEY]: JSON.stringify({ [ID]: false }) });
    m.setPluginEnabled(OTHER, false);
    expect(JSON.parse(localStorage.getItem(KEY)!).sort()).toEqual([ID, OTHER].sort());
  });

  it("does not let one plugin's stored value decide another's", async () => {
    const m = await load({ [KEY]: JSON.stringify([ID]) });
    expect(m.pluginEnabled(ID)).toBe(false);
    expect(m.pluginEnabled(OTHER)).toBe(true);
  });

  it("ignores a stored entry that is not an id", async () => {
    const m = await load({ [KEY]: JSON.stringify([ID, 7, null, "", { x: 1 }]) });
    expect([...m.disabledPlugins()]).toEqual([ID]);
  });

  it("treats an unreadable value as no value rather than as a reason to fail", async () => {
    // Failing this way round matters: a corrupt value costs a remembered choice
    // rather than silently stopping something somebody installed on purpose.
    const m = await load({ [KEY]: "{not json" });
    expect(m.pluginEnabled(ID)).toBe(true);
    expect([...m.disabledPlugins()]).toEqual([]);
  });

  it("treats a value of the wrong shape as no value", async () => {
    const m = await load({ [KEY]: JSON.stringify("off") });
    expect([...m.disabledPlugins()]).toEqual([]);
  });
});

describe("asDisabledSet", () => {
  it("is the gate both stored shapes go through", async () => {
    const { asDisabledSet } = await load();
    expect([...asDisabledSet([ID])]).toEqual([ID]);
    expect([...asDisabledSet({ [ID]: false, [OTHER]: true })]).toEqual([ID]);
    expect([...asDisabledSet(null)]).toEqual([]);
    expect([...asDisabledSet(42)]).toEqual([]);
    // The control: it is not simply returning empty for everything.
    expect(asDisabledSet([ID]).has(ID)).toBe(true);
  });
});
