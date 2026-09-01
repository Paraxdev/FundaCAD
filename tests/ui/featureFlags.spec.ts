// The feature-flag store, and the one promise a flag makes: it hides, it does
// not delete.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "fundacad.features";
const LEGACY_KEY = "sindricad.features";

/** Each case wants the module re-read from a fresh localStorage, and the value
 *  is read once at module load, so the module is re-imported per case. */
async function load(stored?: string, legacy?: string) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(KEY, stored);
  if (legacy !== undefined) localStorage.setItem(LEGACY_KEY, legacy);
  vi.resetModules();
  return import("../../src/ui/featureFlags");
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("featureFlags", () => {
  it("is off with nothing stored", async () => {
    // The whole point. A fresh install must not carry a feature that answers to
    // hardware the user has not said they own.
    const m = await load();
    expect(m.featureFlags().multiColor).toBe(false);
    expect(m.multiColorEnabled()).toBe(false);
    expect(m.DEFAULT_FLAGS.multiColor).toBe(false);
  });

  it("remembers being turned on", async () => {
    const m = await load();
    m.setFeatureFlag("multiColor", true);
    expect(m.multiColorEnabled()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ multiColor: true });

    const again = await load(localStorage.getItem(KEY)!);
    expect(again.multiColorEnabled()).toBe(true);
  });

  it("tells its subscribers, and stops when they leave", async () => {
    const m = await load();
    let calls = 0;
    const stop = m.onFeatureFlagsChange(() => { calls++; });
    m.setFeatureFlag("multiColor", true);
    expect(calls).toBe(1);
    // No event for a write that changes nothing: the viewport repaint hangs off
    // this, and repainting on every Preferences render would defeat the
    // render-on-demand the viewport is built around.
    m.setFeatureFlag("multiColor", true);
    expect(calls).toBe(1);
    stop();
    m.setFeatureFlag("multiColor", false);
    expect(calls).toBe(1);
  });

  it("hands out a fresh object so a holder can compare identity", async () => {
    const m = await load();
    const before = m.featureFlags();
    m.setFeatureFlag("multiColor", true);
    expect(m.featureFlags()).not.toBe(before);
    expect(before.multiColor).toBe(false); // the old one is not mutated under them
  });

  it("falls back to off on anything it cannot read", async () => {
    // Failing CLOSED is the right way round: a corrupt value costs the user a
    // checkbox rather than turning a feature on behind their back.
    for (const junk of ["", "{", "null", "[]", '"multiColor"', "42", '{"multiColor":"yes"}']) {
      const m = await load(junk);
      expect(m.multiColorEnabled(), junk).toBe(false);
    }
  });

  it("refuses a non-boolean written through the setter", async () => {
    const m = await load();
    m.setFeatureFlag("multiColor", "true" as unknown as boolean);
    expect(m.multiColorEnabled()).toBe(false);
  });

  it("keeps a setting stored under the pre-rename key", async () => {
    const m = await load(undefined, JSON.stringify({ multiColor: true }));
    expect(m.multiColorEnabled()).toBe(true);
    // and copies it forward, so the old name stops being load-bearing
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ multiColor: true }));
  });

  it("leaves the Color menu out entirely rather than empty", async () => {
    // The one thing a shared gate has to get right. Two surfaces offer this
    // menu — the browser row and the viewport body menu — and if the gate lived
    // at each of them, the states available would be "an entry with a submenu"
    // and "an entry whose submenu opens onto nothing". So the helper returns the
    // ENTRY, and the answer when the feature is off is no entry at all.
    //
    // Imported after the reset in load(), so both modules see the same instance.
    const m = await load();
    const { bodyColorMenu } = await import("../../src/ui/browserTree");
    const store = {
      colorPalette: [{ name: "Slot 1", color: "#f00" }, { name: "Slot 2", color: "#0f0" }],
      bodyColorSlot: () => undefined,
      setBodyColorSlot: () => {},
    } as unknown as import("../../src/document/store").DocumentStore;

    expect(bodyColorMenu(store, "b1")).toEqual([]);

    m.setFeatureFlag("multiColor", true);
    const on = bodyColorMenu(store, "b1");
    expect(on).toHaveLength(1);
    expect(on[0]!.label).toBe("Color");
    // two slots plus "None"
    expect(on[0]!.children).toHaveLength(3);
  });

  it("sanitises field by field", async () => {
    // A second flag added later must not be able to cost the user the first.
    // asFeatureFlags is the gate, so state it directly rather than waiting for
    // there to be two.
    const m = await load();
    expect(m.asFeatureFlags({ multiColor: true, somethingElse: "junk" })).toEqual({ multiColor: true });
    expect(m.asFeatureFlags({ multiColor: 1 })).toEqual({ multiColor: false });
  });
});
