// An import read for one document never lands in the next one, whichever way the first one ended: the read is
// dropped with one warning naming the file, even when the engine answers it in full afterwards.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { Geometry } from "../../src/geometry/client";
import type { TransportSink } from "../../src/geometry/transport";
import { importPath } from "../../src/io/files";

vi.stubGlobal("window", globalThis);
const toasts: string[] = [];
vi.mock("../../src/ui/toast", () => ({ toast: (m: string) => toasts.push(m) }));

function engine() {
  const sent: { id: string; op: string }[] = [];
  let sink!: TransportSink;
  const g = new Geometry({
    open: true,
    async start(s: TransportSink) {
      sink = s;
    },
    send(raw: string) {
      const m = JSON.parse(raw) as { id: string; op: string };
      sent.push({ id: m.id, op: m.op });
    },
  });
  void g.init();
  const store = new DocumentStore(g, { parameters: {}, features: [] });
  g.bindSessions(store.sessions);
  const reply = (id: string, v: object) => sink.message(JSON.stringify({ id, ...v }));
  return { g, store, sent, reply };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const WARNING = "sv08.step was not imported, its document was closed while it was read.";
const fullRead = { ok: true, result: { geom: "h1", name: "sv08", solid: true, faces: 6 } };

const ends: Record<string, (s: DocumentStore) => void> = {
  New: (s) => s.newDocument(),
  Open: (s) => s.load(JSON.stringify({ parameters: {}, features: [] })),
  discard: (s) => s.newDocument(),
  close: (s) => s.sessions.begin("close"),
};

describe("an import read when its document ends", () => {
  for (const [how, end] of Object.entries(ends)) {
    it(`is dropped on ${how} and the next documents stay clean`, async () => {
      toasts.length = 0;
      const e = engine();
      const done = importPath(e.store, e.g, "C:/models/sv08.step");
      await settle();
      const read = e.sent.find((s) => s.op === "import")!;
      const busyBefore = e.store.busyState.label;
      end(e.store);
      e.reply(read.id, fullRead);
      await done;
      await settle();
      const b = {
        features: e.store.document.features.map((f) => f.id),
        materials: e.store.materialLibrary.length,
        canUndo: e.store.canUndo,
        busy: e.store.busyState.label,
        toasts: [...toasts],
      };
      e.store.load(
        JSON.stringify({ parameters: {}, features: [{ id: "c1", type: "box", length: 1, width: 1, height: 1 }] }),
      );
      await settle();
      expect({
        busyBefore,
        b,
        c: { features: e.store.document.features.map((f) => f.id), toasts: [...toasts] },
      }).toEqual({
        busyBefore: "Importing sv08.step",
        b: {
          features: [],
          materials: new DocumentStore(e.g, { parameters: {}, features: [] }).materialLibrary.length,
          canUndo: false,
          busy: expect.not.stringMatching(/Importing/),
          toasts: [WARNING],
        },
        c: { features: ["c1"], toasts: [WARNING] },
      });
    });
  }

  it("an import its document keeps lands there as before", async () => {
    toasts.length = 0;
    const e = engine();
    const done = importPath(e.store, e.g, "C:/models/sv08.step");
    await settle();
    const read = e.sent.find((s) => s.op === "import")!;
    e.reply(read.id, fullRead);
    await settle();
    expect({ types: e.store.document.features.map((f) => f.type), toasts }).toEqual({ types: ["import"], toasts: [] });
    e.store.newDocument();
    await done.catch(() => {});
    await settle();
    expect({ features: e.store.document.features, toasts }).toEqual({ features: [], toasts: [] });
  });
});
