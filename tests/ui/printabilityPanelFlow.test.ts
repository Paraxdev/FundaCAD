import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import { KIND_COLORS } from "../../src/ui/printability";
import { EDGE_HOVER_COLOR } from "../../src/viewport/highlight";
import type { PrintabilityOptions, PrintabilityReply, PrintabilityResult } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";

// The Printability panel's facade against a hand-made viewport, store and
// engine: Check covers the selection or every body, Cancel names its own
// request, the flagged faces are tinted on their own layer, a row puts its
// finding forward and frames it, and an edit takes the tints off.

beforeEach(() => setActivePinia(createPinia()));

// body1 has six faces, so the viewport numbers body2's faces from 6.
type Built = { id: string; name: string; faceStart: number; faceCount: number }[];
const BUILT: Built = [
  { id: "body1", name: "Block", faceStart: 0, faceCount: 6 },
  { id: "body2", name: "Lid", faceStart: 6, faceCount: 3 },
];

const reply: PrintabilityReply = {
  header: "+Z up as modelled, bed at z = 0",
  report: "",
  settings: { nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z", layFlat: false },
  bodies: [
    { id: "body1", name: "Block", up: [0, 0, 1], bed: 0, bedFace: 1, openEdges: 0, solids: 1, insideOut: false },
    { id: "body2", name: "Lid", up: [0, 0, 1], bed: 0, bedFace: null, openEdges: 0, solids: 1, insideOut: false },
  ],
  findings: [
    { kind: "overhang", body: "body1", face: 3, other: null, value: 90, limit: 0, area: 100, low: 10, at: [5, 5, 10], extent: 10, note: "" },
    { kind: "wall", body: "body1", face: 4, other: { body: "body1", face: 5 }, value: 0.6, limit: 0.8, area: 50, low: 0, at: [0, 5, 5], extent: 1, note: "" },
    { kind: "gap", body: "body2", face: 1, other: { body: "body1", face: 2 }, value: 0.1, limit: 0.2, area: 20, low: 0, at: [10, 5, 5], extent: 4, note: "" },
  ],
  errors: [],
};

function rig() {
  let selectedBodies: string[] = [];
  const hidden = new Set<string>();
  const openListeners: (() => void)[] = [];
  const docListeners: (() => void)[] = [];
  const marks: { marks: unknown; layer: string | undefined }[] = [];
  const frames: { at: number[]; size: number }[] = [];
  const statuses: string[] = [];
  const calls: PrintabilityOptions[] = [];
  const cancels: (string | undefined)[] = [];
  let settle: (r: PrintabilityResult) => void = () => {};
  const built = { features: [{ id: "shown" }] } as unknown as CadDocument;
  const docs: CadDocument[] = [];

  const viewport = {
    getSelectedBodies: () => selectedBodies,
    setFaceMarks: (m: unknown, layer?: string) => marks.push({ marks: m, layer }),
    frameAround: (at: number[], size: number) => frames.push({ at, size }),
  };
  const store = {
    document: { features: [] } as unknown as CadDocument,
    // What the model on screen was built from: rolled back, suppressions out.
    builtDocument: () => built,
    buildState: { result: { bodies: BUILT } },
    onDocChange: (fn: () => void) => { docListeners.push(fn); fn(); return () => {}; },
    onOpen: (fn: () => void) => { openListeners.push(fn); return () => {}; },
    isBodyVisible: (id: string) => !hidden.has(id),
  };
  const geometry = {
    printability: (doc: CadDocument, opts: PrintabilityOptions, onStarted?: (id: string) => void) => {
      docs.push(doc);
      calls.push(opts);
      onStarted?.(`req-${calls.length}`);
      return new Promise<PrintabilityResult>((res) => { settle = res; });
    },
    cancel: async (id?: string) => { cancels.push(id); return true; },
  };
  const deps = {
    store, viewport, geometry,
    hasBody: () => true,
    setStatus: (t: string) => statuses.push(t),
  } as unknown as PanelsDeps;
  const ui = createPanels(deps);
  /** The last marks drawn on the printability layer. */
  const tints = () => marks.filter((m) => m.layer === "printability").at(-1)?.marks;
  return {
    ui, marks, frames, statuses, calls, cancels, tints, docs, built,
    select: (ids: string[]) => { selectedBodies = ids; },
    hide: (id: string) => hidden.add(id),
    settle: (r: PrintabilityResult) => settle(r),
    editDoc: () => docListeners.forEach((f) => f()),
    /** A build drawn again: setModel drops every mark and the rebuild bridge
     *  asks the panel to tint again, maybe with the bodies' faces anew. */
    rebuild: (bodies: Built = store.buildState.result.bodies) => {
      store.buildState = { result: { bodies } };
      ui.refreshPrintabilityMarks();
    },
    open: () => openListeners.forEach((f) => f()),
  };
}

async function checked(r: ReturnType<typeof rig>) {
  r.ui.showPrintability();
  const run = r.ui.runPrintability();
  r.settle({ ok: true, result: reply });
  await run;
}

async function flush() {
  await new Promise((res) => setTimeout(res, 0));
}

describe("printability panel flow", () => {
  it("checks every body when none is selected, and only the selected ones otherwise", async () => {
    const r = rig();
    r.ui.showPrintability();
    const a = r.ui.runPrintability();
    // None named: the engine checks every body of the document it is sent,
    // which is the one the model on screen was built from.
    expect(r.calls[0]).toEqual({ nozzle: 0.4, layer: 0.2, overhang: 45, minGap: 0.2, maxBridge: 10, up: "+Z" });
    expect(r.docs[0]).toBe(r.built);
    r.settle({ ok: true, result: reply });
    await a;
    r.select(["body2", "gone"]);
    usePanelsStore().printability!.setup.layFlat = true;
    const b = r.ui.runPrintability();
    expect(r.calls[1]!.bodies).toEqual(["body2"]);
    expect(r.calls[1]!.layFlat).toBe(true);
    expect("up" in r.calls[1]!).toBe(false);
    r.settle({ ok: true, result: reply });
    await b;
  });

  it("lists the findings by body and tints their faces by kind on its own layer", async () => {
    const r = rig();
    await checked(r);
    const d = usePanelsStore().printability!;
    expect(d.running).toBe(false);
    expect(d.result!.groups.map((g) => [g.name, g.rows.map((x) => x.text)])).toEqual([
      ["Block", ["Overhang, 100 mm² leaning 90°", "Thin wall 0.6 mm (under 0.8)"]],
      ["Lid", ["Gap 0.1 mm will fuse"]],
    ]);
    expect(r.tints()).toEqual([
      { faceIds: [3], color: KIND_COLORS.overhang },
      { faceIds: [4, 5], color: KIND_COLORS.wall },
      { faceIds: [7, 2], color: KIND_COLORS.gap },
    ]);
    expect(r.marks.every((m) => m.layer === "printability")).toBe(true);
    expect(r.statuses.at(-1)).toBe("Printability: 3 things to look at");
  });

  it("puts a hovered row's faces forward, and a clicked one stays forward and is framed", async () => {
    const r = rig();
    await checked(r);
    r.ui.hoverFinding(1);
    expect(r.tints()).toEqual([
      { faceIds: [3], color: KIND_COLORS.overhang },
      { faceIds: [7, 2], color: KIND_COLORS.gap },
      { faceIds: [4, 5], color: EDGE_HOVER_COLOR },
    ]);
    r.ui.hoverFinding(null);
    r.ui.pickFinding(2);
    expect(r.frames).toEqual([{ at: [10, 5, 5], size: 8 }]);
    expect((r.tints() as { faceIds: number[] }[]).at(-1)).toEqual({ faceIds: [7, 2], color: EDGE_HOVER_COLOR });
    r.ui.pickFinding(1);
    expect(r.frames.at(-1)).toEqual({ at: [0, 5, 5], size: 5 });
  });

  it("does not tint a hidden body, nor a face past its body's faces", async () => {
    const r = rig();
    await checked(r);
    r.hide("body2");
    r.rebuild([{ id: "body1", name: "Block", faceStart: 0, faceCount: 4 }, { id: "body2", name: "Lid", faceStart: 4, faceCount: 3 }]);
    // The gap's own side is on the hidden Lid; its other side, on the Block, still shows.
    const shown = [{ faceIds: [3], color: KIND_COLORS.overhang }, { faceIds: [2], color: KIND_COLORS.gap }];
    expect(r.tints()).toEqual(shown);
    r.ui.hoverFinding(1);
    expect(r.tints()).toEqual(shown);
  });

  it("says nothing was found on a clean model", async () => {
    const r = rig();
    r.ui.showPrintability();
    const run = r.ui.runPrintability();
    r.settle({ ok: true, result: { ...reply, findings: [] } });
    await run;
    expect(r.statuses.at(-1)).toBe("Printability: nothing found");
    expect(r.tints()).toEqual([]);
  });

  it("shows a refusal's message in the panel", async () => {
    const r = rig();
    r.ui.showPrintability();
    const run = r.ui.runPrintability();
    r.settle({ ok: false, message: "face 7 of body1 is not flat" });
    await run;
    expect(usePanelsStore().printability!.error).toBe("face 7 of body1 is not flat");
    expect(usePanelsStore().printability!.result).toBeNull();
  });

  it("does not send settings that are not ready", async () => {
    const r = rig();
    r.ui.showPrintability();
    usePanelsStore().printability!.setup.nozzle = 0;
    await r.ui.runPrintability();
    expect(r.calls).toEqual([]);
    expect(usePanelsStore().printability!.error).toMatch(/nozzle/);
  });

  it("cancels by its own request id and stays quiet about it", async () => {
    const r = rig();
    r.ui.showPrintability();
    const run = r.ui.runPrintability();
    expect(usePanelsStore().printability!.requestId).toBe("req-1");
    await r.ui.cancelPrintability();
    expect(r.cancels).toEqual(["req-1"]);
    r.settle({ ok: false, cancelled: true, message: "printability check cancelled" });
    await run;
    expect(usePanelsStore().printability!.error).toBeNull();
    expect(r.statuses.at(-1)).toBe("Printability check cancelled");
  });
});

describe("printability panel across changes", () => {
  it("an edit takes the tints off and marks the result stale, a redraw alone does not", async () => {
    const r = rig();
    await checked(r);
    r.rebuild();
    expect(usePanelsStore().printability!.stale).toBe(false);
    expect(r.tints()).not.toBeNull();
    r.editDoc();
    r.rebuild();
    expect(usePanelsStore().printability!.stale).toBe(true);
    expect(r.tints()).toBeNull();
    r.ui.hoverFinding(0);
    expect(r.tints()).toBeNull();
  });

  it("leaves the tints off a model edited while it ran", async () => {
    const r = rig();
    r.ui.showPrintability();
    const run = r.ui.runPrintability();
    r.editDoc();
    r.settle({ ok: true, result: reply });
    await run;
    expect(usePanelsStore().printability!.stale).toBe(true);
    expect(r.tints()).toBeNull();
    expect(r.statuses.at(-1)).toMatch(/changed while it ran/);
  });

  it("closing stops a Check in flight, drops its late reply and its tints", async () => {
    const r = rig();
    r.ui.showPrintability();
    const run = r.ui.runPrintability();
    r.ui.closePrintability();
    await flush();
    expect(r.cancels).toEqual(["req-1"]);
    expect(usePanelsStore().printability).toBeNull();
    r.settle({ ok: true, result: reply });
    await run;
    expect(r.tints()).toBeNull();
  });

  it("closes on opening another document", async () => {
    const r = rig();
    await checked(r);
    r.open();
    expect(usePanelsStore().printability).toBeNull();
    expect(r.tints()).toBeNull();
  });

  it("a rebuild with the panel closed only clears its own layer", () => {
    const r = rig();
    r.rebuild();
    expect(r.marks).toEqual([{ marks: null, layer: "printability" }]);
  });
});
