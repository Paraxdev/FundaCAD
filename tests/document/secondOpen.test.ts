// Opening a document into a store that held another: the second starts clean,
// with nothing of the first left in its file, its undo stack or its view state.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { UnreadableDocumentError } from "../../src/document/documentShape";
import type { CadDocument, Feature } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { box, env, opened, saved, study } from "./storeKit";

vi.stubGlobal("window", globalThis);

const B: CadDocument = { parameters: { t: 2.5 }, features: [box("g1", 3.5, 6.25, 1.75)] };

function busyA() {
  const a = opened({
    parameters: { w: 7.5 },
    features: [box("f1", 10.5)],
    stress: study,
    environment: env(1.75),
    futureKey: { kept: true },
    palette: [{ name: "Slate", color: "#3c4a5b" }],
    elements: [{ id: "e1", name: "Lid" }],
    referenceImages: [{ id: "r1", src: "a.png" }],
  });
  a.addFeature(box("f2", 4.25));
  a.isolateBodies(["body1"]);
  a.toggleSuppress("f1");
  a.setRollback(1);
  a.saveVersion("v");
  a.setBodyName("body1", "Base");
  a.addFeature(box("f3", 2.5));
  a.undo();
  a.carriedSections = [{ kind: 9, name: "x", hash: "h" }] as never;
  return a;
}

describe("open A then open B", () => {
  it("B starts clean after A had a study, an environment, an unknown section, an undo history and Isolate", () => {
    const a = busyA();
    expect([a.canUndo, a.canRedo, a.isolateActive]).toEqual([true, true, true]);
    const seen: string[][] = [];
    let opens = 0;
    a.onDocChange((d) => seen.push(d.features.map((f) => f.id)));
    a.onOpen(() => opens++);
    seen.length = 0;
    a.load(JSON.stringify(B));
    expect(saved(a)).toEqual(saved(opened(B)));
    expect([a.canUndo, a.canRedo, a.isolateActive]).toEqual([false, false, false]);
    expect([a.versionRepo, a.stressStudy, a.documentEnvironment]).toEqual([null, null, null]);
    expect(a.hasUnreadVersions()).toBe(false);
    expect(a.carriedSections).toEqual([]);
    expect(a.bodyElements).toEqual([]);
    expect(a.referenceImages()).toEqual([]);
    expect(seen).toEqual([["g1"]]);
    expect(opens).toBe(1);
  });

  it("B does not get A's unreadable sections", () => {
    const a = opened({ stress: { future: true }, environment: { name: "future", sky: 3 }, versions: { v: 2 } });
    const first = saved(a);
    expect([first.stress, first.environment, first.versions]).toEqual([{ future: true }, { name: "future", sky: 3 }, { v: 2 }]);
    a.load(JSON.stringify(B));
    expect(saved(a)).toEqual(saved(opened(B)));
  });

  it("a garbled B leaves A as it was and says what the parser said", () => {
    const a = busyA();
    const before = a.toJSON();
    let parser = "";
    try { JSON.parse("{\"features\": [") } catch (e) { parser = (e as Error).message; }
    let err: unknown = null;
    try { a.load("{\"features\": ["); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnreadableDocumentError);
    expect((err as Error).message.endsWith(parser)).toBe(true);
    expect((err as Error).message).not.toContain("SyntaxError");
    expect(a.toJSON()).toBe(before);
    expect(a.canUndo).toBe(true);
  });
});

describe("File New after a busy document", () => {
  it("starts clean, with Isolate off", () => {
    const a = busyA();
    a.newDocument();
    const fresh = opened({});
    fresh.newDocument();
    expect(saved(a)).toEqual(saved(fresh));
    expect([a.canUndo, a.canRedo, a.isolateActive]).toEqual([false, false, false]);
    expect([a.versionRepo, a.stressStudy, a.documentEnvironment]).toEqual([null, null, null]);
    expect(a.carriedSections).toEqual([]);
  });
});

describe("a replacing load of the same document", () => {
  it("keeps the carried sections when it shares a feature, and drops them when it shares none", () => {
    const s = opened({ features: [box("a", 1.5)] });
    const carried = [{ kind: 9, name: "x", hash: "h" }] as never;
    s.carriedSections = carried;
    s.load(JSON.stringify({ parameters: {}, features: [box("a", 1.5), box("b", 2)] }), { replace: true });
    expect(s.carriedSections).toEqual(carried);
    s.load(JSON.stringify({ parameters: {}, features: [box("c", 2)] }), { replace: true });
    expect(s.carriedSections).toEqual([]);
  });

  it("keeps them for a restored version that shares no feature with the working state", () => {
    const s = opened({ features: [box("f1", 1.5)] });
    const v = s.saveVersion("a")!;
    s.addFeature(box("f2", 2));
    s.removeFeature("f1");
    const carried = [{ kind: 9, name: "x", hash: "h" }] as never;
    s.carriedSections = carried;
    s.restoreVersion(v.id);
    expect(s.carriedSections).toEqual(carried);
  });

  it("tells meta listeners on a restore even when the document was already unsaved", () => {
    const s = opened({ features: [box("f1", 1.5)] });
    const v = s.saveVersion("a")!;
    s.addFeature(box("f2", 2));
    expect(s.dirty).toBe(true);
    let n = 0;
    s.onMeta(() => n++);
    n = 0;
    s.restoreVersion(v.id);
    expect(n).toBeGreaterThan(0);
  });
});

describe("the projection valve", () => {
  const CURVE0 = { kind: "line", x1: 1.5, y1: -2, x2: 10, y2: 3 };
  const CURVE1 = { kind: "line", x1: 5, y1: 0.5, x2: 15, y2: 6 };
  const upd = (curve: object) => ({ sketch: "s1", entity: "p1", curve: { ...curve }, stale: false });
  const pdoc = () => ({
    parameters: {},
    features: [{
      id: "s1", type: "sketch", plane: "XY", name: "Sketch1",
      entities: [{
        id: "p1", type: "projected",
        source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [1.5, -2, 0], dir: [0.8, 0.6, 0] } } },
        curve: { ...CURVE0 },
      }],
    }],
  });
  const settle = () => new Promise<void>((res) => {
    let i = 0;
    const tick = () => (++i > 30 ? res() : void setTimeout(tick, 0));
    tick();
  });

  it("tripped in one document does not pause projection refresh in the next", async () => {
    const calls: unknown[] = [];
    // six flip-flopping updates trip the valve, the seventh is the next document's one real update
    const next = (n: number) => (n <= 6 ? [upd(n % 2 ? CURVE1 : CURVE0)] : n === 7 ? [upd(CURVE1)] : undefined);
    const reply = async (doc: unknown) => {
      calls.push(doc);
      const u = next(calls.length);
      return {
        ok: true,
        result: {
          mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
          edges: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] },
          ...(u?.length ? { projectionUpdates: u } : {}),
        },
      };
    };
    const backend = { rebuild: reply, computeAll: reply, async init() {}, onStatus() { return () => {}; }, connected: true };
    const store = new DocumentStore(backend as unknown as GeometryBackend, pdoc() as unknown as CadDocument);
    const warnings: string[] = [];
    store.onWarning = (m) => void warnings.push(m);
    store.addFeature({ id: "x1", type: "extrude", sketch: "s1", distance: 5, operation: "new" } as unknown as Feature);
    await settle();
    expect(calls.length).toBe(6);
    expect(warnings.some((w) => w.includes("paused"))).toBe(true);
    store.load(JSON.stringify(pdoc()));
    await settle();
    expect((store.document.features[0] as unknown as { entities: { curve: object }[] }).entities[0]!.curve).toEqual(CURVE1);
    expect(calls.length).toBe(8);
  });
});
