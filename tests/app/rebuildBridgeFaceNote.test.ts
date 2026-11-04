// The note a committed rebuild gives when it takes away the face a face material
// was on: once per material, never for a preview or a rolled back timeline.
import { describe, it, expect, vi } from "vitest";
import { installRebuildBridge } from "../../src/app/rebuildBridge";
import type { Engine } from "../../src/app/engine";
import type { RebuildState } from "../../src/document/store";
import { SessionHost } from "../../src/document/session";

const { toasts, failures } = vi.hoisted(() => ({
  toasts: [] as { count: string; kind: unknown }[],
  failures: [] as { message: string; detail: unknown }[],
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (m: string, o: { kind?: string; detail?: unknown }) => {
    if (/ failed: /.test(m)) failures.push({ message: m, detail: o.detail });
    if (/face material/.test(m)) toasts.push({ count: /^(\d+) /.exec(m)?.[1] ?? "1", kind: o.kind });
    return 1;
  },
}));

function bridge() {
  const builds = new Set<(s: RebuildState) => void>();
  const store = {
    document: {
      features: [
        { id: "a", type: "box" },
        { id: "b", type: "fillet" },
      ] as unknown[],
    },
    buildState: { result: null },
    hasPreview: false,
    previewError: null,
    rollbackIndex: 2,
    hidden: [] as string[],
    onBuild: (fn: (s: RebuildState) => void) => builds.add(fn),
    onBuildChunk: () => {},
    onBuildAbort: () => {},
    onOpen: () => {},
    sessions: new SessionHost(),
    materialPaint: () => ({}),
    materialFinishes: () => ({}),
    faceMaterialEntries: () => [],
    hiddenFaceMaterials: () => store.hidden,
    materialLibrary: [],
    importColorSource: () => undefined,
    isBodyVisible: () => true,
  };
  const e = {
    store,
    viewport: new Proxy({}, { get: () => () => {} }),
    ui: { panels: { refreshStressMarks: () => {} } },
    sketch: { active: false },
    toolBusy: () => false,
    overlay: { regions: [] },
    syncDatumPlanes: () => {},
  } as unknown as Engine;
  installRebuildBridge(e);
  return (
    hidden: string[],
    o: { preview?: boolean; rollback?: number; errors?: { feature_id: string; message: string }[] } = {},
  ) => {
    store.hidden = hidden;
    store.hasPreview = !!o.preview;
    store.rollbackIndex = o.rollback ?? 2;
    const result = { mesh: { positions: [0, 0, 0], indices: [], faceIds: [] }, edges: [], bodies: [] };
    for (const fn of builds)
      fn({ building: false, result: { ...result, featureErrors: o.errors ?? [] } } as unknown as RebuildState);
  };
}

describe("the note for a face material whose face a rebuild took", () => {
  it("names each newly hidden one once, and again after its face came back and went", () => {
    toasts.length = 0;
    const build = bridge();
    build([]);
    expect(toasts).toEqual([]);
    build(["fr1"]);
    build(["fr1"]);
    expect(toasts).toEqual([{ count: "1", kind: "warning" }]);
    build(["fr1", "fr2", "fr3"]);
    expect(toasts).toEqual([
      { count: "1", kind: "warning" },
      { count: "2", kind: "warning" },
    ]);
    build([]);
    build(["fr2"]);
    expect(toasts).toEqual([
      { count: "1", kind: "warning" },
      { count: "2", kind: "warning" },
      { count: "1", kind: "warning" },
    ]);
  });

  it("says nothing for a preview or a timeline rolled back by one feature, and nothing once it is rolled forward", () => {
    toasts.length = 0;
    const build = bridge();
    build([]);
    build(["fr1"], { preview: true });
    build(["fr1", "fr2"], { rollback: 1 });
    build(["fr1", "fr2"]);
    expect(toasts).toEqual([]);
    build(["fr1", "fr2", "fr4"], { rollback: 2 });
    expect(toasts).toEqual([{ count: "1", kind: "warning" }]);
  });
});

describe("the message for a feature that failed to build", () => {
  const raw = "Standard_ConstructionError: BRepFilletAPI_MakeFillet radius 7.25 too large";

  it("keeps a plain engine sentence and names the feature", () => {
    failures.length = 0;
    bridge()([], { errors: [{ feature_id: "b", message: "Radius 7.25 is larger than the edge" }] });
    expect(failures.map((f) => f.message)).toEqual(["Fillet failed: Radius 7.25 is larger than the edge"]);
  });

  it("says it in plain words when the engine text is internal, with the raw text in the detail", () => {
    failures.length = 0;
    bridge()([], { errors: [{ feature_id: "a", message: raw }] });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain(" failed: ");
    expect(failures[0]!.message).not.toMatch(/Standard_|BRep|7\.25/);
    expect(String(failures[0]!.detail)).toContain(raw);
  });
});
