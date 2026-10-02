import { describe, expect, it } from "vitest";
import { Geometry, type StressOptions } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";

// Geometry.stress: one plain JSON request with the body and the options beside
// the document, its id handed back for Cancel, and the three ways it settles.

interface Inner {
  outbox: string[];
  onMessage(data: string): void;
}

const doc = { version: 5, parameters: {}, features: [] } as unknown as CadDocument;
const opts: StressOptions = {
  fixed: [{ kind: "face", by: "nearest", point: [0, 0, 0], body: "b1" }],
  loads: [{ faces: [{ kind: "face", by: "nearest", point: [0, 0, 10], body: "b1" }], force: [0, 0, -20] }],
  material: "PLA",
};

function start() {
  const g = new Geometry();
  const inner = g as unknown as Inner;
  let started: string | null = null;
  const done = g.stress(doc, "b1", opts, (id) => { started = id; });
  const sent = JSON.parse(inner.outbox[0]!) as Record<string, unknown>;
  const reply = (v: object) => inner.onMessage(JSON.stringify({ id: sent.id, ...v }));
  return { done, sent, reply, started: () => started };
}

describe("Geometry.stress", () => {
  it("sends the op with the body and options beside the document, and hands back its id", () => {
    const { sent, started } = start();
    expect(sent).toMatchObject({ op: "stress", document: doc, body: "b1", ...opts });
    expect(sent.binary).toBeUndefined();
    expect(started()).toBe(sent.id);
  });

  it("passes the reply through", async () => {
    const { done, reply } = start();
    const result = { body: "b1", name: "Bracket", safetyFactor: 2 };
    reply({ ok: true, result });
    expect(await done).toEqual({ ok: true, result });
  });

  it("tells a cancel apart from a failure", async () => {
    const a = start();
    a.reply({ ok: false, cancelled: true, error: { message: "cancelled" } });
    expect(await a.done).toEqual({ ok: false, cancelled: true, message: "stress analysis cancelled" });
    const b = start();
    b.reply({ ok: false, error: { message: "the body is not closed" } });
    expect(await b.done).toEqual({ ok: false, message: "the body is not closed" });
  });
});
