// A theme change repaints the committed sketches, which are built once with the colours of that moment.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installViewportWiring } from "../../src/app/viewportWiring";
import type { Engine } from "../../src/app/engine";
import { DEFAULT_THEME_ID, setTheme } from "../../src/ui/theme";

function lenient<T extends object>(base: T): T {
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k as keyof T] : () => []),
    set: (t, k, v) => {
      (t as Record<string | symbol, unknown>)[k] = v;
      return true;
    },
  });
}

function rig(document: { features: unknown[] }, active = false) {
  const update = vi.fn();
  const requestRender = vi.fn();
  const e = lenient({
    viewport: lenient({ domElement: window.document.createElement("canvas"), requestRender }),
    sketch: { active },
    nudge: lenient({}),
    store: lenient({ buildState: { result: null }, document }),
    tools: lenient({ move: lenient({}) }),
    overlay: lenient({ regions: [], update }),
    geometryBrowser: { selectionChanged: vi.fn(), pickingRows: vi.fn(() => false) },
    toolBusy: () => false,
  }) as unknown as Engine;
  return { e, update, requestRender };
}

afterEach(() => setTheme(DEFAULT_THEME_ID));

describe("theme change and committed sketches", () => {
  it("redraws them from the document at each change, with a frame asked for", () => {
    setActivePinia(createPinia());
    const doc = { features: [{ id: "s1" }, { id: "s2" }] };
    const { e, update, requestRender } = rig(doc);
    installViewportWiring(e);
    update.mockClear();

    setTheme("fundacad-light");
    expect(update.mock.calls).toEqual([[doc]]);
    setTheme("colorblind-safe");
    expect(update.mock.calls).toEqual([[doc], [doc]]);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("leaves the open sketch to its own redraw", () => {
    setActivePinia(createPinia());
    const { e, update } = rig({ features: [{ id: "s1" }] }, true);
    installViewportWiring(e);
    update.mockClear();

    setTheme("high-contrast-light");
    expect(update).not.toHaveBeenCalled();
  });

  it("follows the document that is open now, not the one open at install", () => {
    setActivePinia(createPinia());
    const { e, update } = rig({ features: [{ id: "old" }] });
    installViewportWiring(e);
    const next = { features: [{ id: "new1" }, { id: "new2" }, { id: "new3" }] };
    (e.store as unknown as { document: unknown }).document = next;
    update.mockClear();

    setTheme("solarized-light");
    expect(update.mock.calls).toEqual([[next]]);
  });
});
