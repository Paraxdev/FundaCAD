// The door, and the two ways it can be wrong.
//
// A permission check is worth exactly what its controls are worth. "Refused"
// passes just as well when the broker refuses everything, and "allowed" passes
// just as well when it allows everything, so every refusal below is paired with
// the same call succeeding once the missing grant is added, and every success
// is paired with the same call failing once it is taken away.
//
// The exhaustiveness test is the one that will still be earning its keep in a
// year. The op table is a second copy of a list that already exists in
// plugins/FundaCAD.MCP/server.py, and a second copy is a thing that drifts: someone adds a tool
// there, nobody adds a row here, and the new tool is either unreachable or
// reachable without a permission. So the list is read out of that file rather
// than restated.

import { describe, expect, it, vi } from "vitest";

import { BrokerRefused, createBroker, type BrokerHost } from "../../src/plugins/broker/broker";
import { OPS, OP_TABLE, allOpGrants, isOp, type Op } from "../../src/plugins/broker/ops";
import { GRANTS, type Grant } from "../../src/plugins/manifest";

// Read through vite rather than the filesystem: `*.test.ts` runs in the node
// environment but the rest of the suite reads sources this way, and one habit
// beats two.
import serverPy from "../../plugins/FundaCAD.MCP/server.py?raw";

/** The tools the MCP server actually registers, off its source. */
function serverTools(): string[] {
  const src = serverPy;
  return [...src.matchAll(/^\s{8}add\("([a-z_]+)"/gm)].map((m) => m[1]!);
}

/** A host that records and answers everything, so a test that is about the
 *  broker is not also about a document. */
function recordingHost() {
  const seen: { op: Op; args: Record<string, unknown> }[] = [];
  const host: BrokerHost = {
    async perform(op, args) {
      seen.push({ op, args });
      return { performed: op };
    },
  };
  return { host, seen };
}

const broker = (grants: Grant[], host: BrokerHost = recordingHost().host) =>
  createBroker({ plugin: "under-test", grants, host });

describe("the op table", () => {
  it("covers every tool the MCP server registers", () => {
    const tools = serverTools();
    // The control for the whole comparison: a regex that matched nothing would
    // make the two lists agree vacuously.
    expect(tools.length).toBeGreaterThan(10);
    expect([...tools].sort()).toEqual([...OPS].sort());
  });

  it("gives every op a reason, including the ones that need nothing", () => {
    for (const op of OPS) {
      expect(OP_TABLE[op].why.length, `${op} has no reason written down`).toBeGreaterThan(20);
    }
  });

  it("names only grants that exist in the vocabulary", () => {
    for (const op of OPS) {
      for (const g of OP_TABLE[op].needs) {
        expect(GRANTS, `${op} asks for ${g}`).toContain(g);
      }
    }
  });

  it("asks for document.read on everything that hands document content back", () => {
    // build, inspect and view all report measurements of the open document, so
    // geometry.build alone must not be enough to read it out sideways.
    for (const op of ["build", "inspect", "view", "export"] as const) {
      expect(OP_TABLE[op].needs, op).toContain("document.read");
    }
  });

  it("marks exactly the ops that change the document", () => {
    const writes = OPS.filter((op) => OP_TABLE[op].writes);
    expect([...writes].sort()).toEqual(
      [
        "doc_new",
        "doc_open",
        "doc_set",
        "feature_add",
        "feature_move",
        "feature_remove",
        "feature_update",
        "param_remove",
        "param_set",
      ].sort(),
    );
    // and every one of them needs the grant that says so
    for (const op of writes) expect(OP_TABLE[op].needs, op).toContain("document.write");
  });

  it("allOpGrants is the union and nothing else", () => {
    const union = new Set<Grant>();
    for (const op of OPS) for (const g of OP_TABLE[op].needs) union.add(g);
    expect(allOpGrants()).toEqual([...union].sort());
    // Control: the union is a real subset, not the whole vocabulary. If it were
    // everything, "a plugin holding allOpGrants" would be a meaningless bar.
    expect(allOpGrants().length).toBeLessThan(GRANTS.length);
  });
});

describe("isOp fails closed", () => {
  it("accepts the ops", () => {
    for (const op of OPS) expect(isOp(op)).toBe(true);
  });

  it("refuses everything else", () => {
    // The deliberately-left-out op: a plausible name, not in the table. If a
    // future `doc_close` is added to the server and not here, the exhaustiveness
    // test above fails; until then this is what reaching for it does.
    for (const v of ["doc_close", "", "DOC_GET", "doc_get ", "__proto__", null, 7, {}]) {
      expect(isOp(v), String(v)).toBe(false);
    }
  });
});

describe("the grant check", () => {
  it("allows an op whose grants are all held", async () => {
    const r = await broker(["document.read"]).call("doc_get");
    expect(r.ok).toBe(true);
  });

  it("refuses the same op when the grant is missing, and names it", async () => {
    const r = await broker([]).call("doc_get");
    expect(r).toMatchObject({ ok: false, code: "not-granted", missing: ["document.read"] });
    expect(r.ok === false && r.why).toContain("document.read");
  });

  it("refuses when only some of the grants are held", async () => {
    // doc_open needs files.read AND document.write. Holding one is the case a
    // one-grant-per-op table would have got wrong.
    const r = await broker(["files.read"]).call("doc_open", { path: "a.funda" });
    expect(r).toMatchObject({ ok: false, code: "not-granted", missing: ["document.write"] });
  });

  it("allows it once both are held", async () => {
    const r = await broker(["files.read", "document.write"]).call("doc_open", { path: "a.funda" });
    expect(r.ok).toBe(true);
  });

  it("lets geometry.build alone do nothing at all", async () => {
    // The whole reason build/inspect/view carry document.read.
    for (const op of ["build", "inspect", "view", "export"] as const) {
      const r = await broker(["geometry.build"]).call(op);
      expect(r, op).toMatchObject({ ok: false, code: "not-granted" });
    }
  });

  it("never lets a refused call reach the host", async () => {
    const { host, seen } = recordingHost();
    await broker([], host).call("doc_set", { document: {} });
    await broker([], host).call("nope");
    expect(seen).toEqual([]);
    // Control: the host does get called when the check passes, so an empty list
    // is not simply what this host always produces.
    await broker(["document.write"], host).call("doc_set", { document: {} });
    expect(seen.map((c) => c.op)).toEqual(["doc_set"]);
  });

  it("takes a copy of the grant set", async () => {
    const grants: Grant[] = ["document.read"];
    const b = broker(grants);
    grants.push("document.write");
    // Widening the array afterwards must not widen the door.
    expect((await b.call("doc_set", { document: {} })).ok).toBe(false);
    expect(b.grants).toEqual(["document.read"]);
  });

  it("can() agrees with call() on every op", async () => {
    const b = broker(["document.read", "geometry.build"]);
    for (const op of OPS) {
      const allowed = (await b.call(op, { path: "x", name: "n", id: "i", to: 0, feature: { type: "box" }, patch: {}, expr: 1, document: {} })).ok;
      expect(b.can(op), op).toBe(allowed);
    }
    expect(b.can("doc_close")).toBe(false);
  });
});

describe("refusals that are not about permissions", () => {
  it("refuses an op it has never heard of, holding every grant there is", async () => {
    const r = await createBroker({
      plugin: "greedy",
      grants: [...GRANTS],
      host: recordingHost().host,
    }).call("doc_close");
    expect(r).toMatchObject({ ok: false, code: "unknown-op" });
    expect(r.ok === false && r.why).toContain("doc_close");
  });

  it("refuses arguments that are not a bag of named ones", async () => {
    const b = broker(["document.read"]);
    for (const bad of [[1, 2], "x", 7, null]) {
      expect(await b.call("doc_get", bad), String(bad)).toMatchObject({
        ok: false,
        code: "bad-request",
      });
    }
    // Control: omitted and empty both mean no arguments, and both are fine.
    expect((await b.call("doc_get")).ok).toBe(true);
    expect((await b.call("doc_get", {})).ok).toBe(true);
  });

  it("turns a host that throws into a refusal rather than an exception", async () => {
    const host: BrokerHost = {
      async perform() {
        throw new Error("the kernel fell over");
      },
    };
    const r = await broker(["document.read"], host).call("doc_get");
    expect(r).toMatchObject({ ok: false, code: "failed", why: "the kernel fell over" });
  });

  it("survives a host that throws something that is not an Error", async () => {
    const host: BrokerHost = {
      async perform() {
        throw "just a string";
      },
    };
    const r = await broker(["document.read"], host).call("doc_get");
    expect(r).toMatchObject({ ok: false, code: "failed", why: "just a string" });
  });
});

describe("the observer", () => {
  it("sees successes and refusals alike", async () => {
    const observe = vi.fn();
    let t = 0;
    const b = createBroker({
      plugin: "watched",
      grants: ["document.read"],
      host: recordingHost().host,
      observe,
      now: () => (t += 5),
    });
    await b.call("doc_get");
    await b.call("doc_set", { document: {} });
    await b.call("doc_close");
    expect(observe.mock.calls.map((c) => c[0])).toEqual([
      { plugin: "watched", op: "doc_get", ok: true, ms: 5 },
      { plugin: "watched", op: "doc_set", ok: false, code: "not-granted", ms: 5 },
      { plugin: "watched", op: "doc_close", ok: false, code: "unknown-op", ms: 5 },
    ]);
  });

  it("cannot veto anything", async () => {
    // Deliberate: a hook that could refuse would be a second permission model,
    // in a place nobody would think to audit.
    const observe = vi.fn(() => {
      throw new Error("I object");
    });
    const b = createBroker({
      plugin: "watched",
      grants: ["document.read"],
      host: recordingHost().host,
      observe: observe as unknown as () => void,
    });
    // The throw propagates rather than being swallowed into a refusal, which is
    // the honest outcome: a broken observer is the app's bug, not the plugin's.
    await expect(b.call("doc_get")).rejects.toThrow("I object");
  });
});

describe("callOrThrow", () => {
  it("hands back the value on success", async () => {
    const v = await broker(["document.read"]).callOrThrow<{ performed: string }>("doc_get");
    expect(v.performed).toBe("doc_get");
  });

  it("throws a refusal that still carries the reason and the missing grants", async () => {
    let thrown: unknown;
    try {
      await broker([]).callOrThrow("doc_open", { path: "a.funda" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerRefused);
    const err = thrown as BrokerRefused;
    expect(err.op).toBe("doc_open");
    expect(err.code).toBe("not-granted");
    expect(err.missing).toEqual(["files.read", "document.write"]);
    // Nothing is lost by choosing the exception: the message names the op and
    // the reason, which is the whole point of it existing.
    expect(err.message).toContain("doc_open");
    expect(err.message).toContain("files.read");
  });

  it("throws on an unknown op and on a host that fell over", async () => {
    await expect(broker([]).callOrThrow("doc_close")).rejects.toMatchObject({
      code: "unknown-op",
    });
    const host: BrokerHost = {
      async perform() {
        throw new Error("the kernel fell over");
      },
    };
    await expect(broker(["document.read"], host).callOrThrow("doc_get")).rejects.toMatchObject({
      code: "failed",
    });
  });

  it("does not throw when the call is allowed, which is the control for all three", async () => {
    await expect(
      broker(["files.read", "document.write"]).callOrThrow("doc_open", { path: "a.funda" }),
    ).resolves.toBeDefined();
  });

  it("survives being pulled off the broker", async () => {
    // Plugin code destructures. A `this` in here would make that the one call
    // shape that silently does not check anything.
    const { callOrThrow } = broker(["document.read"]);
    await expect(callOrThrow("doc_get")).resolves.toBeDefined();
    await expect(callOrThrow("doc_new")).rejects.toMatchObject({ code: "not-granted" });
  });
});
