// Cancel stops the op it names: pressed before an import's request went out, it keeps that request off the wire
// instead of stopping whatever was sent last, and pressed after, it sends a cancel for the op's own id.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { Geometry } from "../../src/geometry/client";
import type { TransportSink } from "../../src/geometry/transport";

vi.stubGlobal("window", globalThis);

function rig() {
  const sent: { id: string; op: string; target?: string }[] = [];
  let sink!: TransportSink;
  const transport = {
    open: true,
    async start(s: TransportSink) {
      sink = s;
    },
    send(raw: string) {
      const m = JSON.parse(raw) as { id: string; op: string; target?: string };
      sent.push(m.target ? { id: m.id, op: m.op, target: m.target } : { id: m.id, op: m.op });
    },
  };
  const g = new Geometry(transport);
  void g.init();
  const store = new DocumentStore(g, { parameters: {}, features: [] });
  g.bindSessions(store.sessions);
  const answer = (id: string, v: object) => sink.message(JSON.stringify({ id, ...v }));
  return { g, store, sent, answer };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("Cancel and the op it belongs to", () => {
  it("before the import's id is known it sends nothing and the import never goes out, after it cancels its own id", async () => {
    const r = rig();
    await flush();
    r.sent.splice(0);
    const slow = r.store.runBusy("Importing plate.step", (onStarted) =>
      r.g.importGeometry("plate.step", "step", onStarted),
    );
    const slowId = r.sent[0]!.id;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const sv08 = r.store.runBusy(
      "Importing sv08.step",
      async (onStarted) => {
        await gate;
        return r.g.importGeometry("sv08.step", "step", onStarted);
      },
      { holdHistory: true },
    );
    const early = await r.store.cancelBusy();
    const sentAfterEarly = r.sent.map((s) => s.op);
    release();
    const sv08Reply = await sv08;
    const busyAfterSv08 = r.store.busyState.id;
    const late = r.store.cancelBusy();
    await flush();
    const cancelSent = r.sent.at(-1)!;
    r.answer(cancelSent.id, { ok: true, result: { cancelled: true } });
    r.answer(slowId, { ok: false, cancelled: true, error: { message: "cancelled" } });
    const slowReply = await slow;
    expect({
      early,
      sentAfterEarly,
      sv08Reply,
      busyAfterSv08,
      late: await late,
      cancel: { op: cancelSent.op, target: cancelSent.target },
      slowReply,
      ops: r.sent.map((s) => s.op),
      busy: r.store.busyState.active,
    }).toEqual({
      early: true,
      sentAfterEarly: ["import"],
      sv08Reply: { ok: false, cancelled: true, message: "import cancelled" },
      busyAfterSv08: slowId,
      late: true,
      cancel: { op: "cancel", target: slowId },
      slowReply: { ok: false, cancelled: true, message: "import cancelled" },
      ops: ["import", "cancel"],
      busy: false,
    });
  });

  it("a New ends an op whose request had not gone out without sending it, and the next document starts idle", async () => {
    const r = rig();
    await flush();
    r.sent.splice(0);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const sv08 = r.store
      .runBusy(
        "Importing sv08.step",
        async (onStarted) => {
          await gate;
          return r.g.importGeometry("sv08.step", "step", onStarted);
        },
        { holdHistory: true },
      )
      .catch((e: Error) => e.name);
    r.store.newDocument();
    release();
    const outcome = await sv08;
    await flush();
    const first = { outcome, imports: r.sent.filter((s) => s.op === "import").length };
    r.store.newDocument();
    await flush();
    expect({
      first,
      busyOtherThanItsBuild: r.store.busyState.active && !r.store.busyState.rebuild,
      canUndo: r.store.canUndo,
      features: r.store.document.features,
      importRunning: r.store.importRunning,
    }).toEqual({
      first: { outcome: { ok: false, cancelled: true, message: "import cancelled" }, imports: 0 },
      busyOtherThanItsBuild: false,
      canUndo: false,
      features: [],
      importRunning: false,
    });
  });
});
