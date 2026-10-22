// A host for a plugin's tests. The document ops run the real rules. The geometry ops answer from `answers` and refuse
// by default, because a made-up bounding box would tell a plugin something false about its own arithmetic.

import type { CadDocument, Feature } from "../../types";
import { allOpGrants, type Op } from "./ops";
import type { Grant } from "../manifest";
import { createBroker, type Broker, type BrokerHost } from "./broker";
import { UNSERVED } from "./appHost";
import { ensureBodyIds } from "../../document/bodyIds";

/** Mirrors `DocumentStore.nextId()` (f1, f2), while the Python MCP server names by type (bx1, ex1).
 *  A plugin should read the id `feature_add` returns, never predict it. */
const nextFeatureId = (existing: readonly string[]): string => {
  const used = new Set(existing);
  let n = used.size + 1;
  while (used.has(`f${n}`)) n += 1;
  return `f${n}`;
};

const ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Handed to the plugin as `{ ok: false, code: "failed" }`. Named so a test can tell a refused edit from a bug in the
 *  double. */
export class TestHostError extends Error {}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new TestHostError(`${what} must be a string`);
  return v;
};

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new TestHostError(`${what} must be an object`);
  }
  return v as Record<string, unknown>;
};

/** A canned reply, or a function of the arguments. Spelled out because `unknown | fn` collapses to `unknown`.
 *  A reply cannot itself be a function, and none is, since replies are JSON on the wire. */
type Plain = string | number | boolean | null | readonly unknown[] | { [k: string]: unknown };
export type Answer = ((args: Record<string, unknown>) => unknown) | Plain;

export interface TestHostOptions {
  /** The document the session starts with. Empty if omitted. */
  document?: CadDocument;
  /** The pretend disk, file name to contents: what `file_pick` offers and where `file_write` puts things.
   *  Names, not paths, because that is all a plugin ever sees. */
  files?: Record<string, string>;
  /** Answers for ops a unit test cannot perform; the geometry ops refuse until given one. For `file_pick` and
   *  `file_write` it says what the person did: a file name, or `null` for a dismissed dialog. */
  answers?: Partial<Record<Op, Answer>>;
  /** What `schema` reports. Empty unless a test cares. */
  featureTypes?: string[];
  /** What `app_info` reports. */
  appInfo?: { version: string; platform: string; arch: string };
  /** What `settings_get` reports: the plugin's settings as a person set them. */
  settings?: Record<string, unknown>;
}

export interface TestHost extends BrokerHost {
  /** A copy, so a test cannot edit the app's state from outside the broker. */
  document(): CadDocument;
  /** The pretend disk, likewise copied. */
  files(): Record<string, string>;
  /** Every op the broker allowed, in order. Refusals never reach the host, so they are not here. */
  calls(): { op: Op; args: Record<string, unknown> }[];
}

const EMPTY: CadDocument = { parameters: {}, features: [] };

export function testHost(opts: TestHostOptions = {}): TestHost {
  let doc: CadDocument = clone(opts.document ?? EMPTY);
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  const log: { op: Op; args: Record<string, unknown> }[] = [];
  /** Handles minted by `file_pick`, as the real host keeps them: a plugin reads what it was handed and nothing else. */
  const handed = new Map<string, string>();
  let nextHandle = 1;

  const features = (): Feature[] => (doc.features ??= []);
  const ids = () => features().map((f) => f.id);

  const findIndex = (id: string): number => {
    const i = features().findIndex((f) => f.id === id);
    if (i < 0) {
      throw new TestHostError(`no feature ${JSON.stringify(id)}, have ${ids().join(", ") || "none"}`);
    }
    return i;
  };

  /** The ops that need a kernel. Refused unless the test said what to answer. */
  const geometry = (op: Op, args: Record<string, unknown>): unknown => {
    const answer = opts.answers?.[op];
    if (answer === undefined) {
      throw new TestHostError(
        `${op} needs the geometry engine, which a unit test does not have. ` +
          `Pass answers: { ${op}: ... } to say what it should reply.`,
      );
    }
    return typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer;
  };

  /** What the test said the person did, or undefined for "decide it yourself". */
  const said = (op: Op, args: Record<string, unknown>): unknown => {
    const answer = opts.answers?.[op];
    if (answer === undefined) return undefined;
    return typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer;
  };

  /** Advisory like the real dialog's filter: it orders what is offered first, not what could be chosen.
   *  A test wanting another file says `answers: { file_pick: "other.stl" }`. */
  const wouldPick = (extensions: unknown): string | null => {
    const names = Object.keys(files).sort();
    const exts = Array.isArray(extensions)
      ? extensions
          .filter((e): e is string => typeof e === "string")
          .map((e) => e.trim().replace(/^\./, "").toLowerCase())
          .filter(Boolean)
      : [];
    if (exts.length > 0) {
      const match = names.find((n) => exts.some((e) => n.toLowerCase().endsWith(`.${e}`)));
      if (match) return match;
    }
    return names[0] ?? null;
  };

  return {
    document: () => clone(doc),
    files: () => ({ ...files }),
    calls: () => log.map((c) => ({ op: c.op, args: clone(c.args) })),

    async perform(op: Op, args: Record<string, unknown>): Promise<unknown> {
      log.push({ op, args: clone(args) });
      switch (op) {
        case "schema":
          // Stands in for the real schema without pretending to be it. A plugin
          // that branches on the content of this is testing the wrong thing.
          return { types: [...(opts.featureTypes ?? [])].sort(), note: "test double" };

        case "doc_get":
          return clone(doc);

        case "doc_new":
          doc = clone(EMPTY);
          return { ok: true };

        case "doc_set": {
          doc = clone(obj(args.document, "document")) as unknown as CadDocument;
          doc.parameters ??= {};
          doc.features ??= [];
          ensureBodyIds(doc);
          return { ok: true };
        }

        // Refused in the app's own words, because the app refuses them: all three take a PATH, and a plugin has no
        // paths.
        case "doc_open":
        case "doc_import":
        case "doc_save":
          throw new TestHostError(`${op}: ${UNSERVED[op]}`);

        case "app_info":
          return opts.appInfo ?? { version: "0.0.0-test", platform: "test", arch: "test" };

        case "settings_get":
          return structuredClone(opts.settings ?? {});

        case "file_pick": {
          // `null` means the person dismissed the dialog. Distinguished from
          // "the test said nothing" so that dismissal is reachable at all.
          const answer = said(op, args);
          const name = answer === undefined ? wouldPick(args.extensions) : answer === null ? null : String(answer);
          if (name === null) return null;
          if (!(name in files)) {
            throw new TestHostError(`answers.file_pick chose ${JSON.stringify(name)}, which is not in files`);
          }
          const handle = `f${nextHandle++}`;
          handed.set(handle, name);
          return { handle, name, len: files[name]!.length };
        }

        case "file_read": {
          const handle = str(args.handle, "handle");
          const name = handed.get(handle);
          // The real host answers the same for a missing handle and for somebody else's, so this does too.
          if (name === undefined) {
            throw new TestHostError("that file was not offered to this plugin");
          }
          const text = files[name]!;
          return { name, len: text.length, text };
        }

        case "file_write": {
          const answer = said(op, args);
          if (answer === null) return null; // the person cancelled the save
          const text = args.text;
          const b64 = args.base64;
          if (typeof text !== "string" && typeof b64 !== "string") {
            throw new TestHostError("pass `text` or `base64`");
          }
          if (typeof text === "string" && typeof b64 === "string") {
            throw new TestHostError("pass `text` or `base64`, not both");
          }
          const name = answer === undefined ? str(args.suggested, "suggested") : String(answer);
          // base64 is kept as it arrived: the real host hands it straight to the filesystem without decoding.
          const body = typeof text === "string" ? text : (b64 as string);
          files[name] = body;
          return { name, len: body.length };
        }

        case "param_set": {
          const name = str(args.name, "name");
          const expr = args.expr;
          if (typeof expr !== "string" && typeof expr !== "number") {
            throw new TestHostError("expr must be a number or an expression");
          }
          // Numbers only: a half-working evaluator here would be a second expression language for plugin authors.
          const value = typeof expr === "number" ? expr : Number(expr);
          if (!Number.isFinite(value)) {
            throw new TestHostError(`the test double takes numbers, not expressions like ${JSON.stringify(expr)}`);
          }
          const unit = args.unit === "deg" || args.unit === "count" ? args.unit : "mm";
          (doc.paramDefs ??= {})[name] = { expr: String(expr), value, unit };
          doc.parameters[name] = value;
          // No `value` in the reply, matching ./appHost.ts: the real store commits the cascade asynchronously, so the
          // number is not ready when the call returns. tests/plugins/appHost.spec.ts caught the two disagreeing.
          return { ok: true, name };
        }

        case "param_remove": {
          const name = str(args.name, "name");
          if (!(name in doc.parameters)) throw new TestHostError(`no parameter ${name}`);
          delete doc.parameters[name];
          if (doc.paramDefs) delete doc.paramDefs[name];
          return { ok: true };
        }

        case "feature_add": {
          const f = clone(obj(args.feature, "feature")) as unknown as Feature;
          if (!f.type) throw new TestHostError("a feature needs a `type`");
          if (f.id === undefined) {
            f.id = nextFeatureId(ids());
          } else if (!ID_RE.test(String(f.id))) {
            throw new TestHostError(`bad feature id ${JSON.stringify(f.id)}`);
          } else if (ids().includes(f.id)) {
            throw new TestHostError(`feature id ${JSON.stringify(f.id)} is already used`);
          }
          const list = features();
          const at = args.at;
          if (typeof at === "number" && at < list.length) list.splice(Math.max(0, at), 0, f);
          else list.push(f);
          return { id: f.id };
        }

        case "feature_update": {
          const id = str(args.id, "id");
          const patch = obj(args.patch, "patch");
          const i = findIndex(id);
          const before = features()[i] as unknown as Record<string, unknown>;
          let out: Record<string, unknown>;
          if (args.replace === true) {
            out = { ...clone(patch), id, type: before.type };
          } else {
            out = { ...before };
            for (const [k, v] of Object.entries(patch)) {
              if (v === null) delete out[k];
              else out[k] = clone(v);
            }
            out.id = id;
          }
          features()[i] = out as unknown as Feature;
          return { ok: true, id };
        }

        case "feature_remove": {
          const id = str(args.id, "id");
          features().splice(findIndex(id), 1);
          return { ok: true };
        }

        case "feature_move": {
          const id = str(args.id, "id");
          const to = args.to;
          if (typeof to !== "number") throw new TestHostError("to must be a number");
          const list = features();
          const [f] = list.splice(findIndex(id), 1);
          list.splice(Math.max(0, Math.min(list.length, to)), 0, f as Feature);
          return { ok: true };
        }

        case "build":
        case "inspect":
        case "view":
        case "export":
        case "interference":
        case "measure":
        case "section":
        case "stress":
        case "printability":
        case "sketch_merge":
        case "sketch_tie":
        case "edit":
          return geometry(op, args);
      }
    },
  };
}

export interface TestBroker extends Broker {
  /** The app behind the door, for asserting on the state afterwards. */
  host: TestHost;
}

/** Grants default to everything the op table asks for, so a plugin's tests are about the plugin.
 *  A test about permissions passes the narrower set it wants to prove is enough. */
export function testBroker(opts: TestHostOptions & { grants?: readonly Grant[]; plugin?: string } = {}): TestBroker {
  const host = testHost(opts);
  const broker = createBroker({
    plugin: opts.plugin ?? "test-plugin",
    grants: opts.grants ?? allOpGrants(),
    host,
  });
  return { ...broker, host };
}
