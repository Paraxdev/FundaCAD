// A whole app, for a plugin's tests, in one object.
//
// The ask this answers was "plugins may request a dummy, injectable instance of
// all core elements". The core elements are not what a plugin touches: it
// touches the broker, and only the broker, so what a plugin needs injected is
// one host. That is the difference between a test double that stays true and a
// mock surface that grows a method every time the app does and quietly stops
// resembling it.
//
// WHAT IS REAL HERE. The document ops. Parameters and the feature timeline are
// plain data with rules over them, so this runs those rules: ids are assigned
// the way ./appHost.ts assigns them, a bad edit is refused before anything is
// written, and a plugin that adds a feature and reads the document back sees it.
//
// WHAT IS NOT, AND SAYS SO. `build`, `inspect`, `view` and `export` need the
// geometry kernel, which is a separate process with OCCT in it and cannot be
// stood up inside a unit test. They are answered from `answers`, which the test
// supplies, and refuse by default with a message naming the option to set. A
// canned success would be worse than a refusal: a plugin whose test passed
// against a made-up bounding box has been told something false about its own
// arithmetic.

import type { CadDocument, Feature } from "../../types";
import { allOpGrants, type Op } from "./ops";
import type { Grant } from "../manifest";
import { createBroker, type Broker, type BrokerHost } from "./broker";
import { UNSERVED } from "./appHost";

/** How the app names a new feature, mirroring `DocumentStore.nextId()`.
 *
 *  THIS IS NOT THE ONLY SCHEME IN THE SYSTEM, and an earlier version of this
 *  file said it was. `plugins/FundaCAD.MCP/model.py` names features by type, `bx1` for a
 *  box and `ex1` for an extrude; the app names them `f1`, `f2`, counting from
 *  the number it already has. Both are hosts for the same op vocabulary and
 *  both are right, because an id is an id.
 *
 *  This double follows the APP, because ./appHost.ts is the host a compute
 *  plugin actually runs against. The lesson for a plugin author is the one that
 *  holds either way and is worth learning here rather than in the field: read
 *  the id `feature_add` returns, never predict it. */
const nextFeatureId = (existing: readonly string[]): string => {
  const used = new Set(existing);
  let n = used.size + 1;
  while (used.has(`f${n}`)) n += 1;
  return `f${n}`;
};

const ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Thrown inside the host, caught by the broker, and handed to the plugin as
 *  `{ ok: false, code: "failed" }`. Named so a test can tell a refused edit
 *  from a bug in the double itself. */
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

/** A canned reply, or a function of the arguments for a test that wants the
 *  reply to depend on what was asked.
 *
 *  Spelled out rather than `unknown | fn`, which collapses to `unknown` and
 *  takes the argument type of the function branch down with it. The cost is
 *  that a reply cannot itself be a function, which nothing an op returns is:
 *  every one of them is JSON on the wire. */
type Plain = string | number | boolean | null | readonly unknown[] | { [k: string]: unknown };
export type Answer = ((args: Record<string, unknown>) => unknown) | Plain;

export interface TestHostOptions {
  /** The document the session starts with. Empty if omitted. */
  document?: CadDocument;
  /** The pretend disk: file name to contents. This is what a person could
   *  choose from when the plugin calls `file_pick`, and where `file_write`
   *  puts things. Names, not paths, because that is all a plugin ever sees. */
  files?: Record<string, string>;
  /** Answers for the ops a unit test cannot really perform.
   *
   *  The four geometry ops refuse until one is given. `file_pick` and
   *  `file_write` do not — they have a sensible default — but taking an answer
   *  is how a test says WHAT THE PERSON DID: a file name to choose that one, or
   *  `null` for a dialog that was dismissed. The dismissal branch is the one
   *  every plugin author forgets, and it has to be reachable. */
  answers?: Partial<Record<Op, Answer>>;
  /** What `schema` reports. Empty unless a test cares. */
  featureTypes?: string[];
  /** What `app_info` reports. */
  appInfo?: { version: string; platform: string; arch: string };
}

export interface TestHost extends BrokerHost {
  /** The document as it stands. A copy: a test that mutated it would be editing
   *  the app's state from outside the door this whole design is about. */
  document(): CadDocument;
  /** The pretend disk, likewise copied. */
  files(): Record<string, string>;
  /** Every op the host was asked to perform, in order, after the broker allowed
   *  it. Refusals are not here; they never reached the host, which is exactly
   *  what makes this list worth asserting on. */
  calls(): { op: Op; args: Record<string, unknown> }[];
}

const EMPTY: CadDocument = { parameters: {}, features: [] };

export function testHost(opts: TestHostOptions = {}): TestHost {
  let doc: CadDocument = clone(opts.document ?? EMPTY);
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  const log: { op: Op; args: Record<string, unknown> }[] = [];
  /** Handles minted by `file_pick`, exactly as the real one keeps them: a
   *  plugin can read what it was handed and nothing else. */
  const handed = new Map<string, string>();
  let nextHandle = 1;

  const features = (): Feature[] => (doc.features ??= []);
  const ids = () => features().map((f) => f.id);

  const findIndex = (id: string): number => {
    const i = features().findIndex((f) => f.id === id);
    if (i < 0) {
      throw new TestHostError(
        `no feature ${JSON.stringify(id)}, have ${ids().join(", ") || "none"}`,
      );
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
    return typeof answer === "function"
      ? (answer as (a: Record<string, unknown>) => unknown)(args)
      : answer;
  };

  /** What the test said the person did, or undefined for "decide it yourself". */
  const said = (op: Op, args: Record<string, unknown>): unknown => {
    const answer = opts.answers?.[op];
    if (answer === undefined) return undefined;
    return typeof answer === "function"
      ? (answer as (a: Record<string, unknown>) => unknown)(args)
      : answer;
  };

  /** Which file a person would plausibly pick, given the filter.
   *
   *  Advisory, exactly as the real dialog's filter is: it narrows what is
   *  offered first, it does not narrow what could be chosen. A test wanting a
   *  different answer says so with `answers: { file_pick: "other.stl" }`. */
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
          return { ok: true };
        }

        // Refused, in the app's own words, because the app refuses them. These
        // two used to be served here against the pretend disk, which made this
        // double a liar in the one direction that costs the most: a plugin
        // whose tests passed on `doc_open` would have met a refusal the first
        // time anybody ran it. Both take a PATH, and a plugin has no paths.
        case "doc_open":
        case "doc_save":
          throw new TestHostError(`${op}: ${UNSERVED[op]}`);

        case "app_info":
          return (
            opts.appInfo ?? { version: "0.0.0-test", platform: "test", arch: "test" }
          );

        case "file_pick": {
          // `null` means the person dismissed the dialog. Distinguished from
          // "the test said nothing" so that dismissal is reachable at all.
          const answer = said(op, args);
          const name =
            answer === undefined ? wouldPick(args.extensions) : answer === null ? null : String(answer);
          if (name === null) return null;
          if (!(name in files)) {
            throw new TestHostError(
              `answers.file_pick chose ${JSON.stringify(name)}, which is not in files`,
            );
          }
          const handle = `f${nextHandle++}`;
          handed.set(handle, name);
          return { handle, name, len: files[name]!.length };
        }

        case "file_read": {
          const handle = str(args.handle, "handle");
          const name = handed.get(handle);
          // The real one answers the same way for a handle that does not exist
          // and for one belonging to somebody else, so this does too: a plugin
          // that branches on the difference would be branching on nothing.
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
          const name =
            answer === undefined
              ? str(args.suggested, "suggested")
              : String(answer);
          // base64 is kept as it arrived. The pretend disk holds text, and a
          // double that decoded it would be claiming to know an encoding the
          // real one hands straight to the filesystem.
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
          // Numbers only. The real table evaluates expressions over other
          // parameters, and a half-working evaluator here would be a second
          // expression language for plugin authors to learn the quirks of.
          const value = typeof expr === "number" ? expr : Number(expr);
          if (!Number.isFinite(value)) {
            throw new TestHostError(
              `the test double takes numbers, not expressions like ${JSON.stringify(expr)}`,
            );
          }
          const unit = args.unit === "deg" || args.unit === "count" ? args.unit : "mm";
          (doc.paramDefs ??= {})[name] = { expr: String(expr), value, unit };
          doc.parameters[name] = value;
          // No `value` in the reply, matching ./appHost.ts, which cannot give
          // one: the real store validates synchronously and commits the
          // cascade asynchronously, so the evaluated number is not available
          // when the call returns. A plugin that needs it reads the document
          // back. tests/plugins/appHost.spec.ts is what caught the two
          // disagreeing about this.
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
          return geometry(op, args);
      }
    },
  };
}

export interface TestBroker extends Broker {
  /** The app behind the door, for a test that wants to assert on the state
   *  afterwards rather than only on what came back. */
  host: TestHost;
}

/** A broker over a test host. Grants default to everything the op table asks
 *  for, so a plugin's own tests are about the plugin; a test ABOUT permissions
 *  passes the narrower set it wants to prove is enough. */
export function testBroker(
  opts: TestHostOptions & { grants?: readonly Grant[]; plugin?: string } = {},
): TestBroker {
  const host = testHost(opts);
  const broker = createBroker({
    plugin: opts.plugin ?? "test-plugin",
    grants: opts.grants ?? allOpGrants(),
    host,
  });
  return { ...broker, host };
}
