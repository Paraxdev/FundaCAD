// engine.selectedFeature must READ the selection store, not hold a copy.
//
// It was `e.selectedFeature = null` in createEngine, and selectFeature only ever
// wrote the pinia store, so the field kept its construction-time null forever.
// Every non-Vue reader, Del on a selected feature, Edit ▸ Delete, Edit ▸
// Suppress, "select a plane and Split", silently did nothing, because "no
// feature is selected" and "the wiring is broken" look identical from there.
//
// Guarding the accessor rather than the keyboard handler is deliberate: the
// handler was always correct, and a test of it would have passed against the
// broken engine.

import { describe, it, expect, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createSelection } from "../../src/app/selection";
import { useSelectionStore } from "../../src/stores/selection";
import type { Engine } from "../../src/app/engine";

/** The narrowest thing createSelection touches on the way to selectFeature. */
function fakeEngine() {
  const highlighted: (string | null)[] = [];
  const e = {
    viewport: { highlightDatum: (id: string | null) => highlighted.push(id) },
  } as unknown as Engine;
  Object.assign(e, createSelection(e));
  return { e, highlighted };
}

describe("engine.selectedFeature", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("starts null and follows selectFeature", () => {
    const { e } = fakeEngine();
    expect(e.selectedFeature).toBeNull();
    e.selectFeature("f3");
    expect(e.selectedFeature).toBe("f3");
    e.selectFeature(null);
    expect(e.selectedFeature).toBeNull();
  });

  it("survives Object.assign, which is how the engine installs it", () => {
    // The reason the property is defined on `e` inside createSelection instead
    // of being returned with selectFeature: Object.assign COPIES a getter's
    // value. Returning it would re-freeze the bug in a new place.
    const { e } = fakeEngine();
    Object.assign(e, createSelection(e)); // installed twice, as engine.ts does after other blocks
    e.selectFeature("f9");
    expect(e.selectedFeature).toBe("f9");
  });

  it("sees a selection made through the store by a Vue panel", () => {
    // The browser tree and timeline both write via selectFeature today, but the
    // inspector renders from the store directly; a one-way accessor keeps those
    // two paths from disagreeing.
    const { e } = fakeEngine();
    useSelectionStore().featureId = "f7";
    expect(e.selectedFeature).toBe("f7");
  });

  it("still highlights the matching datum plane", () => {
    const { e, highlighted } = fakeEngine();
    e.selectFeature("dp1");
    expect(highlighted).toEqual(["dp1"]);
  });
});
