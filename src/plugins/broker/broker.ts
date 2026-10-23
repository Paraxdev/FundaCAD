// Everything a plugin does goes through `call`, which checks grants before the host sees it: one entry point to audit.
// Nothing here throws at a plugin. A refusal is a value, so a plugin's bug cannot become the app's crash.

import type { Grant } from "../manifest";
import { OP_TABLE, isOp, type Op } from "./ops";

/** The app implements this over the document store and the geometry engine, a test over a dictionary. */
export interface BrokerHost {
  perform(op: Op, params: Record<string, unknown>): Promise<unknown>;
}

export type RefusalCode =
  /** not in the op table at all */
  | "unknown-op"
  /** an op, but this plugin did not ask for what it needs */
  | "not-granted"
  /** the request itself was malformed before any op ran */
  | "bad-request"
  /** the op ran and did not work: the host's answer, not a refusal by the broker */
  | "failed";

export type BrokerResponse =
  { ok: true; value: unknown } | { ok: false; code: RefusalCode; why: string; missing?: Grant[] };

/** Told about every call after it settles, for the UI audit line and for tests. It cannot refuse anything:
 *  a hook that could veto would be a second permission model. */
export type CallObserver = (entry: { plugin: string; op: string; ok: boolean; code?: RefusalCode; ms: number }) => void;

/** A refusal as an exception, for plugin code that prefers straight lines. Carries the same fields as the value
 *  form. */
export class BrokerRefused extends Error {
  constructor(
    readonly op: string,
    readonly code: RefusalCode,
    readonly why: string,
    readonly missing?: Grant[],
  ) {
    super(`${op}: ${why}`);
    this.name = "BrokerRefused";
  }
}

export interface Broker {
  readonly plugin: string;
  readonly grants: readonly Grant[];
  /** Whether an op would pass the check, without performing it, so a menu does not offer what will be refused. */
  can(op: string): boolean;
  call(op: string, params?: unknown): Promise<BrokerResponse>;
  /** `call` unwrapped. Spares authors `(await b.call(op)).value`, which turns a refusal into a TypeError naming neither
   *  the op nor the missing grant. The exception stays in the plugin: the runners use `call`. */
  callOrThrow<T = unknown>(op: string, params?: unknown): Promise<T>;
}

export interface BrokerOptions {
  plugin: string;
  grants: readonly Grant[];
  host: BrokerHost;
  observe?: CallObserver;
  /** Wall clock, injected so a test can assert on the observer without one. */
  now?: () => number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createBroker(opts: BrokerOptions): Broker {
  // Copied, so whoever handed us the array cannot edit the grant set decided at install.
  const held = new Set<Grant>(opts.grants);
  const grants = Object.freeze([...held]);
  const now = opts.now ?? (() => Date.now());

  /** The missing grants rather than a boolean, so the refusal names the manifest line to add. */
  const shortfall = (op: Op): Grant[] => OP_TABLE[op].needs.filter((g) => !held.has(g));

  const can = (op: string): boolean => isOp(op) && shortfall(op).length === 0;

  // An arrow, not a method, so `callOrThrow` reaches it directly: a `this` would be one destructure away from
  // undefined.
  const call = async (op: string, params?: unknown): Promise<BrokerResponse> => {
    const started = now();
    const done = (r: BrokerResponse): BrokerResponse => {
      opts.observe?.({
        plugin: opts.plugin,
        op: typeof op === "string" ? op : String(op),
        ok: r.ok,
        ...(r.ok ? {} : { code: r.code }),
        ms: now() - started,
      });
      return r;
    };

    if (!isOp(op)) {
      return done({
        ok: false,
        code: "unknown-op",
        why: `there is no operation called ${JSON.stringify(op)}`,
      });
    }

    const missing = shortfall(op);
    if (missing.length > 0) {
      return done({
        ok: false,
        code: "not-granted",
        why: `${op} needs ${missing.join(", ")}, which this plugin did not ask for`,
        missing,
      });
    }

    // Checked after the grants, and only that there is a bag of arguments. Each op's schema is the host's business.
    const args = params === undefined ? {} : params;
    if (!isPlainObject(args)) {
      return done({
        ok: false,
        code: "bad-request",
        why: `${op} takes named arguments, and got ${Array.isArray(args) ? "a list" : typeof args}`,
      });
    }

    try {
      return done({ ok: true, value: await opts.host.perform(op, args) });
    } catch (e) {
      return done({
        ok: false,
        code: "failed",
        why: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const callOrThrow = async <T = unknown>(op: string, params?: unknown): Promise<T> => {
    const r = await call(op, params);
    if (!r.ok) throw new BrokerRefused(op, r.code, r.why, r.missing);
    return r.value as T;
  };

  return { plugin: opts.plugin, grants, can, call, callOrThrow };
}
