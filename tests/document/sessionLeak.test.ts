// Every kind of engine work a document can start ends with that document. For each op the client can send for a
// document, start it in A, end A by New or Open, answer every held request in full, and B is still a fresh document
// that only ever asked the engine for its own rebuild. Then C opens and nothing of A shows up there either.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { ENGINE_OPS, Geometry } from "../../src/geometry/client";
import type { TransportSink } from "../../src/geometry/transport";
import { importPath } from "../../src/io/files";

vi.stubGlobal("window", globalThis);
const toasts: string[] = [];
vi.mock("../../src/ui/toast", () => ({ toast: (m: string) => toasts.push(m), dismissToast: () => {} }));

type Sent = { id: string; op: string; doc: string | undefined };

function engine() {
  const sent: Sent[] = [];
  let sink!: TransportSink;
  const g = new Geometry({
    open: true,
    async start(s: TransportSink) {
      sink = s;
    },
    send(raw: string) {
      const m = JSON.parse(raw) as { id: string; op: string; doc?: string };
      sent.push({ id: m.id, op: m.op, doc: m.doc });
    },
  });
  void g.init();
  const store = new DocumentStore(g, { parameters: {}, features: [] });
  g.bindSessions(store.sessions);
  const reply = (id: string, v: object) => sink.message(JSON.stringify({ id, ...v }));
  return { g, store, sent, reply };
}
type Env = ReturnType<typeof engine>;

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const EMPTY_BUILD = { protocol: 2, bodies: [], bbox: null };
const box = { id: "b1", type: "box", length: 10, width: 10, height: 10 };
const face = { body: "body1", face: 1 } as never;

// The whole answer an engine could give, the worst case for a request whose document has ended.
const FULL: Record<string, object> = {
  rebuild: EMPTY_BUILD,
  computeAll: EMPTY_BUILD,
  import: { geom: "h1", name: "sv08", solid: true, faces: 6 },
  export: { path: "C:/out/a.step" },
  exportWith: { path: "C:/out/a.3mf" },
  generateShape: { geom: "h2", name: "gear" },
  interference: { pairs: [] },
  stress: { body: "body1" },
  printability: { checks: [] },
  blobWrite: { stored: true },
  blobRead: { size: 1, data: "AA==" },
  faceAxis: { origin: [0, 0, 0], direction: [0, 0, 1] },
  faceAnchor: { point: [0, 0, 0] },
  profileCuts: { cuts: [] },
  patternAxis: { origin: [0, 0, 0], direction: [0, 0, 1] },
  projectGeometry: { results: [] },
  migrateGeometry: { items: [{ id: "i1", geom: "h3" }] },
};

// One row per document op, started the way the app starts it where the app has a headless entry.
const LONG_JOBS: Record<(typeof ENGINE_OPS)[number], (e: Env) => Promise<unknown>> = {
  rebuild: async (e) => e.store.addFeature(box as never),
  computeAll: (e) => e.store.computeAllNow(),
  import: (e) => importPath(e.store, e.g, "C:/models/sv08.step"),
  export: (e) =>
    e.store.runBusy("Exporting a.step", (on) => e.g.export(e.store.document, "step", "C:/out/a.step", {}, on)),
  exportWith: (e) =>
    e.store.runBusy("Exporting a.3mf", (on) => e.g.exportWith(e.store.document, "C:/out/a.3mf", "bambu", {}, on)),
  generateShape: (e) => e.g.generateShape("gear", { teeth: 12 }),
  interference: (e) => e.g.interference(e.store.document),
  stress: (e) => e.store.runBusy("Stress", (on) => e.g.stress(e.store.builtDocument(), "body1", {} as never, on)),
  printability: (e) => e.store.runBusy("Printability", (on) => e.g.printability(e.store.document, {} as never, on)),
  blobWrite: (e) => e.g.blobPut(new Uint8Array([1, 2, 3])),
  blobRead: (e) => e.g.blobGet("00112233445566778899aabbccddeeff"),
  faceAxis: (e) => e.store.faceAxis(face, "body1"),
  faceAnchor: (e) => e.store.faceAnchor(face, "body1", [0, 0, 0]),
  profileCuts: (e) => e.store.profileCuts([0, 0, 0], [0, 0, 1]),
  patternAxis: (e) => e.store.patternAxis(face),
  projectGeometry: (e) => e.store.projectGeometry({} as never, [{ selector: face } as never], null),
  migrateGeometry: (e) => e.g.migrateGeometry([{ id: "i1", brep: "DBRep" }]),
};

const ENDS: Record<string, (s: DocumentStore) => void> = {
  New: (s) => s.newDocument(),
  // As finishOpen does: an opened file is clean.
  Open: (s) => {
    s.load(JSON.stringify({ parameters: {}, features: [] }));
    s.markSaved("C:/docs/b.funda");
  },
};

const WARNING = "sv08.step was not imported, another document was opened while it was read.";

function documentState(e: Env) {
  return {
    features: e.store.document.features.map((f) => f.id),
    parameters: e.store.document.parameters,
    dirty: e.store.dirty,
    canUndo: e.store.canUndo,
    busy: e.store.busyState.active,
    running: e.store.runningOps.length,
    building: e.store.buildState.building,
    error: e.store.buildState.errorMessage,
    bodies: e.store.buildState.result?.bodies?.length ?? 0,
    toasts: [...toasts],
  };
}

describe("a document's engine work ends with its session", () => {
  it("has a row for every op the client sends for a document", () => {
    expect(Object.keys(LONG_JOBS).sort()).toEqual([...ENGINE_OPS].sort());
  });

  for (const [op, start] of Object.entries(LONG_JOBS)) {
    for (const [how, end] of Object.entries(ENDS)) {
      it(`${op} started in a document ended by ${how} never reaches the next ones`, async () => {
        toasts.length = 0;
        const e = engine();
        await settle();
        for (const s of e.sent.filter((x) => x.op === "rebuild")) e.reply(s.id, { ok: true, result: EMPTY_BUILD });
        await settle();
        const a = e.store.session.id;
        const job = start(e).catch(() => {});
        await settle();
        const startedInA = e.sent.some((s) => s.op === op && s.doc === a);
        const held = e.sent.filter((s) => s.doc === a);

        end(e.store);
        const b = e.store.session.id;
        await settle();
        const bAskedBeforeRelease = e.sent.some((s) => s.op === "rebuild" && s.doc === b);
        for (const s of held) e.reply(s.id, { ok: true, result: FULL[s.op] ?? {} });
        await settle();
        for (const s of e.sent.filter((x) => x.op === "rebuild" && x.doc === b))
          e.reply(s.id, { ok: true, result: EMPTY_BUILD });
        await job;
        await settle();
        const inB = documentState(e);
        const bOps = [...new Set(e.sent.filter((s) => s.doc === b).map((s) => s.op))];

        e.store.load(JSON.stringify({ parameters: {}, features: [box] }));
        const c = e.store.session.id;
        await settle();
        const cOps = [...new Set(e.sent.filter((s) => s.doc === c).map((s) => s.op))];
        const docEnds = e.sent.filter((s) => s.op === "doc_end").length;

        const warned = op === "import" ? [WARNING] : [];
        expect({ startedInA, bAskedBeforeRelease, inB, bOps, cOps, docEnds }).toEqual({
          startedInA: true,
          bAskedBeforeRelease: true,
          inB: {
            features: [],
            parameters: {},
            dirty: false,
            canUndo: false,
            busy: false,
            running: 0,
            building: false,
            error: null,
            bodies: 0,
            toasts: warned,
          },
          bOps: ["rebuild"],
          cOps: ["rebuild"],
          docEnds: 2,
        });
        expect({ features: e.store.document.features.map((f) => f.id), toasts }).toEqual({
          features: ["b1"],
          toasts: warned,
        });
      });
    }
  }
});
