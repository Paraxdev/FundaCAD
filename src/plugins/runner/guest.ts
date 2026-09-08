// The plugin's end of the sandbox: what a plugin is handed, and the little
// machinery that makes it work.
//
// A plugin gets ONE object, `app`, and it is the same shape as the broker
// because it is the broker, reached down a wire. `app.call` returns a refusal
// rather than throwing; `app.callOrThrow` throws; `app.can` answers from the
// grant list the host sent. That last one is the only thing here a plugin could
// lie to itself about, and lying gains it nothing: the host checks again, and
// the host's copy is the one that decides.
//
// A plugin is an ASYNC FUNCTION BODY with `app` in scope. So it is written as
// straight-line code with `await` in it and a `return` at the end, which is
// what the work actually looks like:
//
//     const { id } = await app.callOrThrow("feature_add", { feature: {...} });
//     return id;
//
// No module wrapper, no exported name to remember, nothing to get wrong before
// the first line does anything.
//
// HOW THAT BODY BECOMES A FUNCTION IS THE CALLER'S PROBLEM, and deliberately
// so, because it is a content-security-policy question rather than a language
// one. In the app the plugin's text is inlined into the worker's own script by
// ./spawn.ts and arrives here already compiled, as `run` — no Function
// constructor, and so no `'unsafe-eval'`. A caller with a different policy can
// pass `evaluate` instead and get the AsyncFunction route. Neither is buried in
// a message handler where the policy it depends on would be invisible.

import type { Grant } from "../manifest";
import { BrokerRefused, type RefusalCode } from "../broker/broker";
import { parseFromHost, MAX_LOG, type Port, type ToHost } from "./protocol";

/** What a plugin sees. */
export interface PluginApp {
  readonly grants: readonly Grant[];
  can(op: string): boolean;
  call(op: string, params?: unknown): Promise<
    { ok: true; value: unknown } | { ok: false; code: RefusalCode; why: string; missing?: Grant[] }
  >;
  callOrThrow<T = unknown>(op: string, params?: unknown): Promise<T>;
  log(...parts: unknown[]): void;
}

/** Turns a plugin's source into something callable.
 *
 *  NEEDS `'unsafe-eval'`, which is why the app does not use it. Kept because it
 *  is the only way to run a plugin whose text arrives at runtime in a host that
 *  cannot inline it into a script, and because saying so in one named place is
 *  better than the requirement being implicit in a `new Function` somewhere. */
export type Evaluate = (source: string) => (app: PluginApp) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (app: PluginApp) => Promise<unknown>;

export const evaluateWithAsyncFunction: Evaluate = (source) => {
  const fn = new AsyncFunction("app", source);
  return (app) => fn(app);
};

/** Ops a plugin may attempt, for `can`. Sent by the host and advisory: the
 *  host checks again and its answer is the one that counts. */
function makeApp(port: Port, grants: readonly Grant[], pending: Map<number, (v: unknown) => void>) {
  let nextId = 1;
  const held = new Set(grants);

  const call: PluginApp["call"] = (op, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve as (v: unknown) => void);
      port.postMessage({ t: "call", id, op, params } satisfies ToHost);
    });

  return {
    grants: Object.freeze([...held]),
    // Deliberately NOT consulting the op table. The guest would then carry a
    // copy of it, and a copy that fell behind would have a plugin skipping a
    // call the host would happily have performed. Unknown ops answer false,
    // which is also what the host would say.
    can: (op: string) => held.size > 0 && typeof op === "string" && op.length > 0,
    call,
    async callOrThrow<T = unknown>(op: string, params?: unknown): Promise<T> {
      const r = await call(op, params);
      if (!r.ok) throw new BrokerRefused(op, r.code, r.why, r.missing);
      return r.value as T;
    },
    log(...parts: unknown[]) {
      const text = parts
        .map((p) => (typeof p === "string" ? p : safeStringify(p)))
        .join(" ")
        .slice(0, MAX_LOG);
      port.postMessage({ t: "log", text } satisfies ToHost);
    },
  } satisfies PluginApp;
}

/** JSON, and a readable answer rather than a throw when it will not go.
 *
 *  A plugin logging a circular object is a plugin debugging something, and
 *  turning that into an exception inside its own logging call would end the run
 *  over the least important line in it. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface GuestOptions {
  port: Port;
  /** The plugin, already compiled. What ./spawn.ts passes: the worker's own
   *  script carries the plugin's text, so there is nothing left to evaluate.
   *  Takes precedence over `evaluate`, and makes the `source` in the start
   *  message irrelevant. */
  run?: (app: PluginApp) => Promise<unknown>;
  /** How to compile the source in the start message, when there is no `run`. */
  evaluate?: Evaluate;
}

/** Bring up the guest side and wait for work. Returns a teardown. */
export function serveGuest(opts: GuestOptions): () => void {
  const evaluate = opts.evaluate ?? evaluateWithAsyncFunction;
  const pending = new Map<number, (v: unknown) => void>();
  let started = false;

  const onMessage = (ev: { data: unknown }) => {
    const msg = parseFromHost(ev.data);
    if (!msg) return;

    if (msg.t === "reply") {
      const resolve = pending.get(msg.id);
      // An id nobody is waiting for. Either the host answered twice or the run
      // moved on; both are the host's business and neither is worth a throw in
      // the middle of somebody's plugin.
      if (!resolve) return;
      pending.delete(msg.id);
      resolve(
        msg.ok
          ? { ok: true, value: msg.value }
          : { ok: false, code: msg.code, why: msg.why, ...(msg.missing ? { missing: msg.missing } : {}) },
      );
      return;
    }

    // A second start is refused rather than obeyed. Running a plugin twice over
    // the same pending map would let the second run collect the first one's
    // replies.
    if (started) return;
    started = true;

    const app = makeApp(opts.port, msg.grants, pending);
    let run: (app: PluginApp) => Promise<unknown>;
    try {
      run = opts.run ?? evaluate(msg.source);
    } catch (e) {
      // A syntax error, which is the most common thing to be wrong with a
      // plugin and deserves to say so rather than "the plugin failed".
      opts.port.postMessage({
        t: "failed",
        why: `the plugin would not compile: ${e instanceof Error ? e.message : String(e)}`,
      } satisfies ToHost);
      return;
    }

    void run(app).then(
      (value) => {
        // Sent through JSON's own rules rather than relying on the structured
        // clone of whatever a plugin returned: a function, a DOM node or a
        // cyclic object would otherwise throw inside postMessage, where the
        // failure has nothing to do with the message it was.
        opts.port.postMessage({ t: "done", value: jsonSafe(value) } satisfies ToHost);
      },
      (e) => {
        opts.port.postMessage({
          t: "failed",
          why: e instanceof Error ? e.message : String(e),
        } satisfies ToHost);
      },
    );
  };

  opts.port.addEventListener("message", onMessage);
  opts.port.postMessage({ t: "ready" } satisfies ToHost);

  return () => {
    opts.port.removeEventListener("message", onMessage);
    pending.clear();
  };
}

/** Whatever survives a JSON round trip, or a description of why it did not. */
function jsonSafe(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return null;
  }
}
