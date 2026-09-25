// A plain click on a face selects the face. It used to select the feature that
// owned the face as well, which opened that feature's values in the history, so
// clicking the top of a plate a hole had been cut into opened the Hole. Editing
// the owner is the double click.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installViewportWiring } from "../../src/app/viewportWiring";
import type { Engine } from "../../src/app/engine";

/** Whatever the wiring reaches for and this test does not care about answers
 *  as a no-op returning nothing much; what it sets is kept and read back. */
function lenient<T extends object>(known: T): T {
  const noop = () => [];
  return new Proxy(known, {
    get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : noop),
    set: (t, k, v) => { (t as Record<string | symbol, unknown>)[k] = v; return true; },
  });
}

beforeEach(() => setActivePinia(createPinia()));

function engine() {
  const calls = { selected: [] as (string | null)[], edited: [] as string[] };
  const viewport = lenient({
    faceIdAt: () => 7,
    pickDatumAt: () => null,
    getSelectedBodies: () => [],
    domElement: document.createElement("canvas"),
    rayFrom: () => ({ ray: null }),
  } as Record<string, unknown>);
  const e = lenient({
    viewport,
    sketch: { active: false },
    overlay: lenient({ committedRegionAtRay: () => null }),
    store: lenient({ buildState: { result: null }, document: { features: [] } }),
    tools: lenient({ move: lenient({}) }),
    toolBusy: () => false,
    featureForFace: () => "hole1",
    selectFeature: (id: string | null) => { calls.selected.push(id); },
    editFeature: (id: string) => { calls.edited.push(id); },
  } as Record<string, unknown>);
  return { e: e as unknown as Engine, viewport, calls };
}

describe("face click intent", () => {
  it("a single click on a face leaves the owning feature unselected", () => {
    const { e, viewport, calls } = engine();
    installViewportWiring(e);
    const onHit = (viewport as { onHit?: unknown }).onHit;
    if (typeof onHit === "function") onHit({ kind: "face", faceId: 7 }, false);
    expect(calls.selected).toEqual([]);
  });

  it("a double click on the same face still edits its owner", () => {
    const { e, viewport, calls } = engine();
    installViewportWiring(e);
    (viewport as unknown as { onDoubleClick: (x: number, y: number) => void }).onDoubleClick(10, 10);
    expect(calls.edited).toEqual(["hole1"]);
  });
});
