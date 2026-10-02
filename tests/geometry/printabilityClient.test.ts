import { describe, expect, it } from "vitest";
import { Geometry, type PrintabilityOptions } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";

// Geometry.printability: one plain JSON request with the options beside the
// document, its id handed back for Cancel, and the three ways it settles.

interface Inner {
  outbox: string[];
  onMessage(data: string): void;
}

const doc = { version: 5, parameters: {}, features: [] } as unknown as CadDocument;
const opts: PrintabilityOptions = {
  bodies: ["body1", "body2"],
  nozzle: 0.4,
  layer: 0.2,
  overhang: 45,
  minGap: 0.2,
  maxBridge: 10,
  up: "+Z",
};

function start(o: PrintabilityOptions = opts) {
  const g = new Geometry();
  const inner = g as unknown as Inner;
  let started: string | null = null;
  const done = g.printability(doc, o, (id) => { started = id; });
  const sent = JSON.parse(inner.outbox[0]!) as Record<string, unknown>;
  const reply = (v: object) => inner.onMessage(JSON.stringify({ id: sent.id, ...v }));
  return { done, sent, reply, started: () => started };
}

describe("Geometry.printability", () => {
  it("sends the op with the options beside the document, and hands back its id", () => {
    const { sent, started } = start();
    expect(sent).toMatchObject({ op: "printability", document: doc, ...opts });
    expect(sent.layFlat).toBeUndefined();
    expect(sent.binary).toBeUndefined();
    expect(started()).toBe(sent.id);
  });

  it("sends lay flat in place of up", () => {
    const { sent } = start({ bodies: ["body1"], layFlat: true });
    expect(sent.layFlat).toBe(true);
    expect(sent.up).toBeUndefined();
  });

  it("passes the reply through", async () => {
    const { done, reply } = start();
    const result = { header: "+Z up as modelled, bed at z = 0", report: "", bodies: [], findings: [], errors: [] };
    reply({ ok: true, result });
    expect(await done).toEqual({ ok: true, result });
  });

  it("tells a cancel apart from a refusal", async () => {
    const a = start();
    a.reply({ ok: false, cancelled: true, error: { message: "cancelled" } });
    expect(await a.done).toEqual({ ok: false, cancelled: true, message: "printability check cancelled" });
    const b = start();
    b.reply({ ok: false, error: { message: "no body named Lid" } });
    expect(await b.done).toEqual({ ok: false, message: "no body named Lid" });
  });
});
