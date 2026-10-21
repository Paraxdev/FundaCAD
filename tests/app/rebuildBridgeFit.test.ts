import { describe, it, expect, vi } from "vitest";
import { installRebuildBridge } from "../../src/app/rebuildBridge";
import type { Engine } from "../../src/app/engine";
import type { RebuildState } from "../../src/document/store";

vi.mock("../../src/ui/toast", () => ({ toast: () => {} }));

const box = { id: "a", type: "box" };
const imp = { id: "f2", type: "import" };

function bridge() {
  const builds = new Set<(s: RebuildState) => void>();
  const opens = new Set<() => void>();
  const fits: boolean[] = [];
  const store = {
    document: { features: [] as unknown[] },
    buildState: { result: null },
    hasPreview: false,
    previewError: null,
    onBuild: (fn: (s: RebuildState) => void) => builds.add(fn),
    onBuildChunk: () => {},
    onBuildAbort: () => {},
    onOpen: (fn: () => void) => opens.add(fn),
    materialPaint: () => ({}),
    materialFinishes: () => ({}),
    faceMaterialEntries: () => [],
    materialLibrary: [],
    importColorSource: () => undefined,
    isBodyVisible: () => true,
  };
  const viewport = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (k === "setModel" ? (_r: unknown, fit: boolean) => fits.push(fit) : () => {}),
  });
  const e = {
    store,
    viewport,
    ui: { panels: { refreshStressMarks: () => {} } },
    sketch: { active: false },
    toolBusy: () => false,
    overlay: { regions: [] },
    syncDatumPlanes: () => {},
  } as unknown as Engine;
  installRebuildBridge(e);
  const show = (features: unknown[], solid: boolean) => {
    store.document = { features };
    const result = { mesh: { positions: solid ? [0, 0, 0] : [], indices: [], faceIds: [] }, edges: [], bodies: [] };
    for (const fn of builds) fn({ building: false, result } as unknown as RebuildState);
  };
  return { show, open: () => opens.forEach((fn) => fn()), fits };
}

describe("the camera after an import", () => {
  it("fits an import that fills a view emptied by Undo", () => {
    const b = bridge();
    b.show([box], true);
    b.show([], false);
    b.show([imp], true);
    expect(b.fits).toEqual([true, true]);
  });

  it("fits an import into a new document", () => {
    const b = bridge();
    b.show([box], true);
    b.open();
    b.show([imp], true);
    expect(b.fits).toEqual([true, true]);
  });

  it("leaves the camera alone for an import beside a part already on screen", () => {
    const b = bridge();
    b.show([box], true);
    b.show([box, imp], true);
    expect(b.fits).toEqual([true, false]);
  });

  it("leaves the camera alone for a part drawn into an emptied view", () => {
    const b = bridge();
    b.show([box], true);
    b.show([], false);
    b.show([box], true);
    expect(b.fits).toEqual([true, false]);
  });
});
