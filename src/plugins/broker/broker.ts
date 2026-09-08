// One door.
//
// Everything a plugin does to the app goes through `call`, and `call` checks
// the grants before the host sees the request. The value of that is not that
// the check is clever, it is three lines, but that there is exactly one of
// it. A permission model with two entry points has two, and the second one is
// the one nobody audits.
//
// The host is injected, and that is the whole of the testing story. A plugin
// under test is handed a broker over an in-memory host (./testing.ts) and
// cannot tell the difference, because there is nothing else to tell: the
// broker is the entire surface. That is a much smaller promise to keep than
// "a dummy of every core element", which would be a mock of the document
// store, the geometry client, the selection, the file dialogs and the viewport,
// growing whenever any of them grew and drifting from all five.
//
// NOTHING HERE THROWS AT A PLUGIN. A refusal is a value with a reason in it. A
// host that throws is caught and becomes one. A plugin is untrusted code and an
// exception crossing back out of it, or out of it into the app's stack, is a
// way for a plugin's bug to become the app's crash.

import type { Grant } from "../manifest";
import { OP_TABLE, isOp, type Op } from "./ops";

/** What actually performs an op once it has been allowed. The app implements
 *  this over the document store and the geometry engine; a test implements it
 *  over a dictionary. */
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
  /** the op ran and did not work, which is the host's answer and not a refusal
   *  by this module */
  | "failed";

export type BrokerResponse =
  | { ok: true; value: unknown }
  | { ok: false; code: RefusalCode; why: string; missing?: Grant[] };

/** Told about every call after it settles. For the audit line in the UI, and
 *  for a test that wants to assert a plugin did not quietly call `view` forty
 *  times. Deliberately not able to refuse anything: a hook that could veto
 *  would be a second permission model. */
export type CallObserver = (entry: {
  plugin: string;
  op: string;
  ok: boolean;
  code?: RefusalCode;
  ms: number;
}) => void;

/** A refusal, as an exception, for plugin code that would rather write straight
 *  lines than check a flag after every call. Carries the same three fields the
 *  value form does, so nothing is lost by choosing it. */
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
  /** The plugin this door belongs to. Every door is one plugin's. */
  readonly plugin: string;
  readonly grants: readonly Grant[];
  /** Whether an op would pass the check, without performing it. For a menu that
   *  should not offer what will be refused. */
  can(op: string): boolean;
  call(op: string, params?: unknown): Promise<BrokerResponse>;
  /** `call`, unwrapped: the value on success, `BrokerRefused` thrown otherwise.
   *
   *  Here because the alternative is every plugin author writing it, and the
   *  version they write is `(await b.call(op)).value`, which on a refusal reads
   *  undefined out of a result that carried a perfectly good reason. Ten lines
   *  later it fails as a TypeError about a property, naming neither the op nor
   *  the missing grant. The exception is the plugin's own to catch, and it does
   *  not cross back into the app: `call` is still what the runners use. */
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
  // Copied, not aliased. The grant set is decided at install and must not be
  // reachable for editing by whoever handed us the array.
  const held = new Set<Grant>(opts.grants);
  const grants = Object.freeze([...held]);
  const now = opts.now ?? (() => Date.now());

  /** The missing grants for an op, empty when it would pass. Returned rather
   *  than a boolean so the refusal can name them: a plugin author whose call
   *  was refused needs to know which line of their manifest to add. */
  const shortfall = (op: Op): Grant[] => OP_TABLE[op].needs.filter((g) => !held.has(g));

  const can = (op: string): boolean => isOp(op) && shortfall(op).length === 0;

  // Named rather than a method, so `callOrThrow` reaches it directly. A `this`
  // here would be one spread or one destructure away from being undefined, in
  // the one function whose job is to refuse things.
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

    // After the check, not before: an argument shape is the host's business,
    // and validating it here would put a second copy of every op's schema in
    // the one file that is supposed to know nothing about what ops mean.
    // What is checked is only that there is a bag of arguments at all.
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
