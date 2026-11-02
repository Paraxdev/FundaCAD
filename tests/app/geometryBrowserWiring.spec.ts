// The controller hears the one selection slot and the body selection, beside what already listens there. mountUi needs
// the whole app, so its subscription order is read from the source.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installViewportWiring } from "../../src/app/viewportWiring";
import type { Engine } from "../../src/app/engine";

const engineSource = Object.values(
  import.meta.glob("../../src/app/engine.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
)[0]!;

const promptCalls = vi.hoisted(() => [] as (string | null)[]);
vi.mock("../../src/ui/prompt", async (actual) => ({
  ...(await actual<typeof import("../../src/ui/prompt")>()),
  setPrompt: (text: string | null) => promptCalls.push(text),
}));

function lenient<T extends object>(base: T): T {
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k as keyof T] : () => []),
    set: (t, k, v) => {
      (t as Record<string | symbol, unknown>)[k] = v;
      return true;
    },
  });
}

function engine() {
  const selectionChanged = vi.fn();
  const viewport = lenient({
    domElement: document.createElement("canvas"),
    getSelectedBodies: () => ["body2"],
    selectedEdgeLines: () => [],
    selectedFacesForPressPull: () => null,
    getSelectedFaceIds: () => [],
  }) as unknown as Record<string, (...a: unknown[]) => void>;
  const e = lenient({
    viewport,
    sketch: { active: false },
    nudge: lenient({}),
    store: lenient({ buildState: { result: null }, document: { features: [] } }),
    tools: lenient({ move: lenient({}) }),
    overlay: lenient({ regions: [] }),
    geometryBrowser: { selectionChanged },
    toolBusy: () => true,
  });
  return { e: e as unknown as Engine, viewport, selectionChanged };
}

beforeEach(() => {
  setActivePinia(createPinia());
  promptCalls.length = 0;
});

describe("geometry browser wiring", () => {
  it("fans a face or edge selection out, and the prompt still follows it", () => {
    const { e, viewport, selectionChanged } = engine();
    installViewportWiring(e);
    (e as unknown as { toolBusy(): boolean }).toolBusy = () => false;
    promptCalls.length = 0;
    viewport.onSelectionChange!();
    expect(selectionChanged).toHaveBeenCalledTimes(1);
    expect(promptCalls.length).toBeGreaterThan(0);
  });

  it("hears a body selection, even while a tool is busy", () => {
    const { e, viewport, selectionChanged } = engine();
    installViewportWiring(e);
    viewport.onBodySelectionChange!();
    expect(selectionChanged).toHaveBeenCalledTimes(1);
  });

  it("subscribes to builds after the rebuild bridge, so edge rows read the drawn model", () => {
    const source = engineSource.replace(/\r/g, "");
    const mount = /export function mountUi\(e: Engine\): void \{\n([\s\S]*?)\n\}\n/.exec(source)![1]!;
    const bridge = mount.indexOf("installRebuildBridge(e);");
    const listen = mount.indexOf("e.geometryBrowser.buildChanged(s)");
    expect(bridge).toBeGreaterThanOrEqual(0);
    expect(listen).toBeGreaterThan(bridge);
    expect(mount.indexOf("installViewportWiring(e);")).toBeLessThan(bridge);
    // Before mountUi fills the selection slots.
    const create = source.indexOf("e.geometryBrowser = createGeometryBrowser(e);");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(source.indexOf("export function mountUi"));
  });
});
