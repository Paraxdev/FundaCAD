// A plugin running in a sandbox, both halves, over a real channel.
//
// The host and the guest are wired to the two ends of a MessageChannel and run
// in the same process. That is not a stub of the arrangement, it is the
// arrangement: the same two modules, the same messages, the same serialisation.
// What a Worker adds is isolation, which is the browser's job and not something
// a unit test could confirm anyway. What it costs is that a test can drive a
// deadline without waiting for one.
//
// The failures worth catching here are the ones where a sandbox looks like it
// works:
//
//   * a plugin reaching an op it did not ask for and getting it
//   * a plugin that never returns holding the app open forever
//   * a plugin holding more slow work open than the app agreed to carry
//   * a run that has ended still being answered afterwards
//
// Each has a control that must fail.

import { describe, expect, it, vi } from "vitest";

import { runInSandbox, DEFAULT_LIMITS, type RunOutcome } from "../../src/plugins/runner/host";
import { serveGuest, type PluginApp } from "../../src/plugins/runner/guest";
import { testHost } from "../../src/plugins/broker/testing";
import type { Grant } from "../../src/plugins/manifest";
import type { Port } from "../../src/plugins/runner/protocol";

/** A MessageChannel port, adapted to the two members the protocol asks for.
 *  `start()` matters: a MessagePort added with addEventListener does not
 *  deliver until it is started, and a test that forgot would hang rather than
 *  fail. */
function ends(): { host: Port; guest: Port; close: () => void } {
  const ch = new MessageChannel();
  ch.port1.start();
  ch.port2.start();
  return {
    host: ch.port1 as unknown as Port,
    guest: ch.port2 as unknown as Port,
    close: () => {
      ch.port1.close();
      ch.port2.close();
    },
  };
}

interface RunArgs {
  source: string;
  grants?: Grant[];
  limits?: Partial<typeof DEFAULT_LIMITS>;
  /** Replaces the evaluator, for a test about the sandbox rather than about
   *  compiling a string. */
  evaluate?: (source: string) => (app: PluginApp) => Promise<unknown>;
  answers?: Parameters<typeof testHost>[0] extends infer O
    ? O extends { answers?: infer A }
      ? A
      : never
    : never;
}

/** Run a plugin and give back both the outcome and the app it worked on. */
async function run(args: RunArgs): Promise<{ out: RunOutcome; app: ReturnType<typeof testHost> }> {
  const app = testHost(args.answers ? { answers: args.answers } : {});
  const { host, guest, close } = ends();
  const stopGuest = serveGuest({ port: guest, ...(args.evaluate ? { evaluate: args.evaluate } : {}) });

  const out = await runInSandbox({
    plugin: "under-test",
    grants: args.grants ?? ["document.read", "document.write"],
    host: app,
    source: args.source,
    port: host,
    ...(args.limits ? { limits: args.limits } : {}),
    dispose: () => {
      stopGuest();
      close();
    },
  });
  return { out, app };
}

describe("a plugin that works", () => {
  it("runs, reaches the document, and hands a value back", async () => {
    const { out, app } = await run({
      source: `
        await app.callOrThrow("param_set", { name: "wall", expr: 3 });
        const { id } = await app.callOrThrow("feature_add", { feature: { type: "box" } });
        return { id };
      `,
    });

    expect(out.ok).toBe(true);
    expect(out.ok && out.value).toEqual({ id: "f1" });
    expect(app.document().parameters).toEqual({ wall: 3 });
    expect(app.document().features).toHaveLength(1);
    expect(out.calls).toBe(2);
  });

  it("can log, and the lines come back with the outcome", async () => {
    const { out } = await run({
      source: `app.log("hello", { n: 1 }); app.log("again"); return 1;`,
    });
    expect(out.log).toEqual(["hello {\"n\":1}", "again"]);
  });

  it("gets a refusal as a value from call, and a throw from callOrThrow", async () => {
    const { out, app } = await run({
      grants: ["document.read"],
      source: `
        const r = await app.call("feature_add", { feature: { type: "box" } });
        let threw = null;
        try { await app.callOrThrow("doc_new"); } catch (e) { threw = e.message; }
        return { code: r.code, missing: r.missing, threw };
      `,
    });

    expect(out.ok).toBe(true);
    expect(out.ok && out.value).toMatchObject({
      code: "not-granted",
      missing: ["document.write"],
    });
    expect((out.ok && (out.value as { threw: string }).threw) || "").toContain("document.write");
    // The refusal was a refusal all the way down: nothing was written.
    expect(app.document().features).toEqual([]);
  });
});

describe("the grants are the host's, not the plugin's", () => {
  it("refuses an op the plugin did not ask for, however it asks", async () => {
    const { out, app } = await run({
      grants: ["document.read"],
      source: `
        const tries = [];
        for (const op of ["doc_new", "doc_set", "feature_add", "param_set"]) {
          tries.push((await app.call(op, { document: {}, feature: { type: "box" }, name: "x", expr: 1 })).ok);
        }
        return tries;
      `,
    });
    expect(out.ok && out.value).toEqual([false, false, false, false]);
    expect(app.document()).toEqual({ parameters: {}, features: [] });
  });

  it("and allows exactly those it did, which is the control", async () => {
    const { out } = await run({
      grants: ["document.read", "document.write"],
      source: `
        const tries = [];
        for (const op of ["doc_new", "doc_set", "feature_add", "param_set"]) {
          tries.push((await app.call(op, { document: {}, feature: { type: "box" }, name: "x", expr: 1 })).ok);
        }
        return tries;
      `,
    });
    expect(out.ok && out.value).toEqual([true, true, true, true]);
  });

  it("cannot widen itself by claiming grants it was not given", async () => {
    // `app.grants` is a copy the host sent for the plugin's own planning. A
    // plugin that overwrites it, or lies to `can`, changes nothing: the check
    // that matters happened on the other end of the port.
    const { out, app } = await run({
      grants: ["document.read"],
      source: `
        try { app.grants.push("document.write"); } catch {}
        return (await app.call("doc_new")).ok;
      `,
    });
    expect(out.ok && out.value).toBe(false);
    expect(app.calls().map((c) => c.op)).toEqual([]);
  });

  it("cannot reach an op that does not exist", async () => {
    const { out } = await run({
      source: `return (await app.call("rm_rf", { path: "/" })).code;`,
    });
    expect(out.ok && out.value).toBe("unknown-op");
  });
});

describe("a plugin that misbehaves", () => {
  it("is stopped at its deadline rather than left running", async () => {
    let fire: (() => void) | null = null;
    const app = testHost();
    const { host, guest, close } = ends();
    const stopGuest = serveGuest({ port: guest });

    const promise = runInSandbox({
      plugin: "slow",
      grants: ["document.read"],
      host: app,
      // Never returns. The deadline is the only thing that ends this.
      source: `await new Promise(() => {}); return 1;`,
      port: host,
      dispose: () => { stopGuest(); close(); },
      setTimer: (fn) => { fire = fn; return 1; },
      clearTimer: () => {},
    });

    // Let the guest start and hit its wait, then let the clock strike.
    await new Promise((r) => setTimeout(r, 0));
    expect(fire).not.toBeNull();
    fire!();

    const out = await promise;
    expect(out).toMatchObject({ ok: false, reason: "timed-out" });
    expect(out.ok === false && out.why).toContain("did not finish");
  });

  it("is stopped when it makes more requests than it may", async () => {
    const { out, app } = await run({
      limits: { totalCalls: 3 },
      source: `for (let i = 0; i < 50; i++) await app.call("doc_get"); return "never";`,
    });
    expect(out).toMatchObject({ ok: false, reason: "over-limit" });
    expect(out.ok === false && out.why).toContain("more than 3 requests");
    // It got its three and not a fourth.
    expect(app.calls()).toHaveLength(3);
  });

  it("is stopped when it keeps more work outstanding than it may", async () => {
    // The in-flight cap is about CONCURRENCY, not rate: it counts ops the host
    // is still working on. An instant op never accumulates, because every
    // reply's microtask drains before the next message event arrives, which is
    // why this uses a host that does not answer. Rate is the other cap.
    const stuck = { perform: () => new Promise<unknown>(() => {}) };
    const { host, guest, close } = ends();
    const stopGuest = serveGuest({ port: guest });

    const out = await runInSandbox({
      plugin: "flooder",
      grants: ["document.read"],
      host: stuck,
      source: `
        const all = [];
        for (let i = 0; i < 40; i++) all.push(app.call("doc_get"));
        await Promise.all(all);
        return "never";
      `,
      port: host,
      limits: { inFlight: 4 },
      dispose: () => { stopGuest(); close(); },
    });

    expect(out).toMatchObject({ ok: false, reason: "over-limit" });
    expect(out.ok === false && out.why).toContain("in flight");
    // Exactly the cap got through, and the one past it ended the run.
    expect(out.calls).toBe(4);
  });

  it("lets a well-behaved plugin make many quick calls in a row", async () => {
    // The control for the cap above. A plugin that awaits each call has one
    // outstanding at a time however many it makes, and must not be stopped for
    // being busy.
    const { out } = await run({
      limits: { inFlight: 2, totalCalls: 50 },
      source: `for (let i = 0; i < 30; i++) await app.call("doc_get"); return "fine";`,
    });
    expect(out.ok).toBe(true);
    expect(out.calls).toBe(30);
  });

  it("has its output truncated rather than kept", async () => {
    const { out } = await run({
      limits: { logLines: 3 },
      source: `for (let i = 0; i < 100; i++) app.log("line " + i); return 1;`,
    });
    expect(out.ok).toBe(true);
    expect(out.log).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("reports a syntax error as one, not as a mystery", async () => {
    const { out } = await run({ source: `this is not javascript(` });
    expect(out).toMatchObject({ ok: false, reason: "plugin-failed" });
    expect(out.ok === false && out.why).toContain("would not compile");
  });

  it("reports a throw with the plugin's own message", async () => {
    const { out } = await run({ source: `throw new Error("I gave up");` });
    expect(out).toMatchObject({ ok: false, reason: "plugin-failed", why: "I gave up" });
  });

  it("returning something unserialisable does not take the run down with it", async () => {
    const { out } = await run({ source: `const a = {}; a.self = a; return a;` });
    // A cycle cannot cross the wire. The run still finished, and said so.
    expect(out.ok).toBe(true);
    expect(out.ok && out.value).toBeNull();
  });
});

describe("the run is over when it is over", () => {
  it("ignores anything the sandbox says after it has finished", async () => {
    const app = testHost();
    const { host, guest, close } = ends();
    const stopGuest = serveGuest({ port: guest });

    const out = await runInSandbox({
      plugin: "chatty",
      grants: ["document.read", "document.write"],
      host: app,
      source: `return "done";`,
      port: host,
      dispose: () => stopGuest(),
    });
    expect(out.ok).toBe(true);

    // The host has stopped listening. A late request must not be performed.
    (guest as unknown as MessagePort).postMessage({
      t: "call",
      id: 99,
      op: "doc_new",
      params: {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(app.calls().map((c) => c.op)).toEqual([]);
    close();
  });

  it("finishes when the sandbox has gone, rather than waiting out the deadline", async () => {
    // A Worker that has been terminated, or a port that has been closed: the
    // send throws. That has to end the run then and there, because the
    // alternative is holding whatever is awaiting this for the full deadline
    // over a sandbox that is already gone.
    let listener: ((ev: { data: unknown }) => void) | null = null;
    const broken: Port = {
      postMessage() {
        throw new Error("the worker is gone");
      },
      addEventListener: (_t, fn) => { listener = fn; },
      removeEventListener: () => { listener = null; },
    };

    const promise = runInSandbox({
      plugin: "lost",
      grants: [],
      host: testHost(),
      source: "return 1;",
      port: broken,
      // No deadline is allowed to be what saves this test.
      setTimer: () => 0,
      clearTimer: () => {},
    });

    // The guest says hello; the host's answer is what cannot be delivered.
    listener!({ data: { t: "ready" } });

    const out = await promise;
    expect(out).toMatchObject({ ok: false, reason: "sandbox-lost" });
    expect(out.ok === false && out.why).toContain("closed");
  });
});

describe("messages that are not messages", () => {
  it("drops junk from the sandbox rather than acting on part of it", async () => {
    const app = testHost();
    const { host, guest, close } = ends();
    const seen = vi.fn();

    const promise = runInSandbox({
      plugin: "junk",
      grants: ["document.write"],
      host: { perform: (op, args) => { seen(op); return app.perform(op, args); } },
      source: "unused",
      port: host,
      dispose: () => close(),
      setTimer: () => 0,
      clearTimer: () => {},
    });

    const port = guest as unknown as MessagePort;
    port.start();
    for (const junk of [
      null,
      42,
      "call",
      [],
      { t: "call" },                              // no id, no op
      { t: "call", id: "1", op: "doc_new" },      // id is not a number
      { t: "call", id: -1, op: "doc_new" },       // an id this side never issues
      { t: "call", id: 1.5, op: "doc_new" },      // nor this one
      { t: "call", id: 1 },                       // no op
      { t: "nonsense", id: 1, op: "doc_new" },
    ]) {
      port.postMessage(junk);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).not.toHaveBeenCalled();

    // The control: a well-formed one does get through, so the silence above is
    // the parser refusing rather than the channel being dead.
    port.postMessage({ t: "call", id: 1, op: "doc_new", params: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveBeenCalledWith("doc_new");

    port.postMessage({ t: "done", value: null });
    await promise;
  });
});
