// The plugin's end of the sandbox. A plugin is an async function body with one object in scope, `app`, the broker over
// a wire. ./spawn.ts inlines it into the worker's own script as `run`, so the app needs no 'unsafe-eval'.

import type { Grant } from "../manifest";
import { BrokerRefused, type RefusalCode } from "../broker/broker";
import { parseFromHost, MAX_LOG, type Port, type ToHost } from "./protocol";

/** What a plugin sees. */
export interface PluginApp {
  readonly grants: readonly Grant[];
  can(op: string): boolean;
  call(
    op: string,
    params?: unknown,
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: RefusalCode; why: string; missing?: Grant[] }>;
  callOrThrow<T = unknown>(op: string, params?: unknown): Promise<T>;
  log(...parts: unknown[]): void;
}

/** Needs 'unsafe-eval', which is why the app does not use it. For a host that cannot inline a runtime plugin into a
 *  script. */
export type Evaluate = (source: string) => (app: PluginApp) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (app: PluginApp) => Promise<unknown>;

export const evaluateWithAsyncFunction: Evaluate = (source) => {
  const fn = new AsyncFunction("app", source);
  return (app) => fn(app);
};

/** The grants are sent by the host and advisory: the host checks again and its answer is the one that counts. */
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
    // Not the op table: a copy here could fall behind and skip a call the host would perform.
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

/** Never throws: a plugin logging a circular object should not end its run over a log line. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface GuestOptions {
  port: Port;
  /** The plugin already compiled, as ./spawn.ts passes it. Takes precedence over `evaluate` and the start message's
   *  `source`. */
  run?: (app: PluginApp) => Promise<unknown>;
  /** How to compile the source in the start message, when there is no `run`. */
  evaluate?: Evaluate;
}

export function serveGuest(opts: GuestOptions): () => void {
  const evaluate = opts.evaluate ?? evaluateWithAsyncFunction;
  const pending = new Map<number, (v: unknown) => void>();
  let started = false;

  const onMessage = (ev: { data: unknown }) => {
    const msg = parseFromHost(ev.data);
    if (!msg) return;

    if (msg.t === "reply") {
      const resolve = pending.get(msg.id);
      // An id nobody waits for: the host answered twice or the run moved on, not worth a throw in a plugin.
      if (!resolve) return;
      pending.delete(msg.id);
      resolve(
        msg.ok
          ? { ok: true, value: msg.value }
          : { ok: false, code: msg.code, why: msg.why, ...(msg.missing ? { missing: msg.missing } : {}) },
      );
      return;
    }

    // A second start is refused, since it would collect the first run's replies from the same pending map.
    if (started) return;
    started = true;

    const app = makeApp(opts.port, msg.grants, pending);
    let run: (app: PluginApp) => Promise<unknown>;
    try {
      run = opts.run ?? evaluate(msg.source);
    } catch (e) {
      // Most likely a syntax error, which deserves to say so rather than "the plugin failed".
      opts.port.postMessage({
        t: "failed",
        why: `the plugin would not compile: ${e instanceof Error ? e.message : String(e)}`,
      } satisfies ToHost);
      return;
    }

    void run(app).then(
      (value) => {
        // Through JSON rather than structured clone, so a returned function or cyclic object cannot throw inside
        // postMessage.
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

/** Whatever survives a JSON round trip, or null. */
function jsonSafe(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return null;
  }
}
