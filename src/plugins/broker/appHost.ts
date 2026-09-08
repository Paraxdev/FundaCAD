// The broker's host, backed by the document the window actually has open.
//
// This is the other implementation of `BrokerHost`; ./testing.ts is the one a
// plugin's tests get. They serve the same op table, which is what makes a
// plugin that passed its tests mean something here.
//
// EDITS GO THROUGH THE STORE, never around it. Every op below calls the same
// methods the app's own tools call, so a plugin's change is one undo step, it
// re-evaluates the parameter cascade, it triggers the rebuild, and the person
// watching sees it happen. A host that reached into `document` and mutated it
// would produce a document the store did not know had changed, which is a class
// of bug with no good failure mode.
//
// FILES GO THROUGH RUST, when there is a Rust to go through. `file_pick`,
// `file_read`, `file_write` and `app_info` are handed to a `NativeBridge`; see
// ./native.ts for why they are ops on the same table rather than a channel of
// their own. Without a bridge, a browser session, a test that did not pass one,
// they refuse by name, because "the desktop app is not here" and "you did not
// ask for this" are different things a plugin author has to be able to tell
// apart.
//
// WHAT IS STILL NOT SERVED, and refuses by name rather than pretending:
// `build`, `inspect`, `view` and `export` want the geometry engine, which a
// plugin cannot reach yet. `doc_open` and `doc_save` are a different case and
// will keep refusing: both take a PATH, which is the one thing a plugin may not
// have, so their refusals name the ops to compose instead. A plugin holding
// `geometry.build` gets past the broker and then gets a refusal from here that
// says which of the two stopped it. Two refusals with two reasons is worth more
// than one that could mean either.
//
// The store is injected rather than imported. The alternative is a module-level
// singleton, which is the same coupling with a worse test story.

import type { CadDocument, Feature } from "../../types";
import type { DocumentStore } from "../../document/store";
import type { BrokerHost } from "./broker";
import type { NativeBridge } from "./native";
import type { Op } from "./ops";

/** Refused by the host, as opposed to refused by the broker. Caught by the
 *  broker and handed to the plugin as `{ ok: false, code: "failed" }`. */
export class HostRefused extends Error {}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new HostRefused(`${what} must be a string`);
  return v;
};

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new HostRefused(`${what} must be an object`);
  }
  return v as Record<string, unknown>;
};

/** Ops this host cannot serve, and the reason, which is the whole value of the
 *  entry. "not implemented" tells a plugin author nothing about whether to wait
 *  or to do something else.
 *
 *  Exported so ./testing.ts can refuse the same ops in the same words rather
 *  than keeping its own copy. A test double that served something the app
 *  refuses would be a lie in the one direction that costs the most: a plugin
 *  whose tests passed and which fails the first time anybody runs it. */
export const UNSERVED: Partial<Record<Op, string>> = {
  // These two name a path, and a plugin has no paths. The refusal names what to
  // do instead, because "not supported" would send somebody looking for a
  // version where it is, and there will not be one.
  doc_open:
    "a plugin cannot name a file. Use file_pick, then file_read, then doc_set",
  doc_save: "a plugin cannot name a file. Use doc_get, then file_write",
  export:
    "exporting needs the geometry engine, which a plugin cannot reach yet. Once it can, the file half is doc_get and file_write",
  build: "the geometry engine is not reachable from a plugin yet",
  inspect: "the geometry engine is not reachable from a plugin yet",
  view: "the geometry engine is not reachable from a plugin yet",
};

export interface AppHostOptions {
  store: DocumentStore;
  /** Whose host this is. Every file a plugin is handed is recorded against this
   *  id on the Rust side, so one plugin cannot read another's file even if it
   *  somehow learned the handle. A host built without it serves the file ops to
   *  nobody. */
  plugin?: string;
  /** The feature types this build knows, for `schema`. Passed in because the
   *  list belongs to whatever renders the tool palette, not here. */
  featureTypes?: () => string[];
  /** The way out to the operating system. Absent in a browser session and in
   *  any test that did not ask for one, and the file ops then refuse rather
   *  than pretending to have opened a dialog nobody saw. */
  native?: NativeBridge;
}

export function appHost(opts: AppHostOptions): BrokerHost {
  const { store } = opts;

  /** The bridge, or a refusal that says which half is missing. */
  const bridge = (op: Op): { native: NativeBridge; plugin: string } => {
    if (!opts.native) {
      throw new HostRefused(
        `${op}: files are handled by the desktop app, and this is not running in it`,
      );
    }
    if (!opts.plugin) {
      throw new HostRefused(
        `${op}: this host was built without a plugin id, so a file could not be recorded against anybody`,
      );
    }
    return { native: opts.native, plugin: opts.plugin };
  };

  /** Text a plugin sent, for a dialog title or a suggested name. Bounded here
   *  as well as in Rust: the two caps are for different things, this one so a
   *  megabyte of "purpose" is not put on an IPC message at all. */
  const words = (v: unknown, fallback: string): string => {
    const t = typeof v === "string" ? v.trim() : "";
    return (t || fallback).slice(0, 200);
  };

  const features = (): Feature[] => store.document.features ?? [];
  const has = (id: string) => features().some((f) => f.id === id);

  const need = (id: string) => {
    if (!has(id)) {
      const ids = features().map((f) => f.id);
      throw new HostRefused(
        `no feature ${JSON.stringify(id)}, have ${ids.join(", ") || "none"}`,
      );
    }
  };

  return {
    async perform(op: Op, args: Record<string, unknown>): Promise<unknown> {
      const unserved = UNSERVED[op];
      if (unserved) throw new HostRefused(`${op}: ${unserved}`);

      switch (op) {
        case "app_info":
          return await bridge(op).native.info();

        case "file_pick": {
          const { native, plugin } = bridge(op);
          const raw = args.extensions;
          const extensions = Array.isArray(raw)
            ? raw.filter((e): e is string => typeof e === "string").slice(0, 16)
            : [];
          // null, not an error. A dismissed dialog is a complete answer, and a
          // plugin that reported it as a failure would show somebody an error
          // for having changed their mind.
          return await native.pick({
            plugin,
            purpose: words(args.purpose, "choose a file"),
            extensions,
          });
        }

        case "file_read": {
          const { native, plugin } = bridge(op);
          return await native.read({ plugin, handle: str(args.handle, "handle") });
        }

        case "file_write": {
          const { native, plugin } = bridge(op);
          const text = args.text;
          const base64 = args.base64;
          if (typeof text !== "string" && typeof base64 !== "string") {
            throw new HostRefused("pass `text` or `base64`");
          }
          if (typeof text === "string" && typeof base64 === "string") {
            throw new HostRefused("pass `text` or `base64`, not both");
          }
          return await native.write({
            plugin,
            purpose: words(args.purpose, "save a file"),
            suggested: words(args.suggested, ""),
            ...(typeof text === "string" ? { text } : { base64: base64 as string }),
          });
        }

        case "schema":
          return { types: (opts.featureTypes?.() ?? []).sort() };

        case "doc_get":
          // A copy. The store's document is live and shared with the viewport;
          // handing the real one out would let a plugin edit it behind the
          // store's back, which is the one thing this whole file exists to
          // prevent.
          return clone(store.document);

        case "doc_new":
          store.newDocument();
          return { ok: true };

        case "doc_set": {
          const next = clone(obj(args.document, "document")) as unknown as CadDocument;
          next.parameters ??= {};
          next.features ??= [];
          store.loadDocument(next);
          return { ok: true };
        }

        case "param_set": {
          const name = str(args.name, "name");
          const expr = args.expr;
          if (typeof expr !== "string" && typeof expr !== "number") {
            throw new HostRefused("expr must be a number or an expression");
          }
          const unit = args.unit === "deg" || args.unit === "count" ? args.unit : "mm";
          // The store validates and returns a message rather than throwing, so
          // a bad expression names itself instead of arriving as "failed".
          const bad =
            name in (store.document.paramDefs ?? {})
              ? store.setParamExpr(name, String(expr), unit)
              : store.addParam(name, String(expr), unit);
          if (bad) throw new HostRefused(bad);
          return { ok: true, name };
        }

        case "param_remove": {
          const name = str(args.name, "name");
          const bad = store.deleteParam(name);
          if (bad) throw new HostRefused(bad);
          return { ok: true };
        }

        case "feature_add": {
          const f = clone(obj(args.feature, "feature")) as unknown as Feature;
          if (!f.type) throw new HostRefused("a feature needs a `type`");
          if (f.id === undefined) f.id = store.nextId();
          else if (has(String(f.id))) {
            throw new HostRefused(`feature id ${JSON.stringify(f.id)} is already used`);
          }
          const at = args.at;
          store.addFeature(f, typeof at === "number" ? Math.max(0, at) : undefined);
          return { id: f.id };
        }

        case "feature_update": {
          const id = str(args.id, "id");
          need(id);
          const patch = obj(args.patch, "patch");
          if (args.replace === true) {
            const before = features().find((f) => f.id === id)!;
            store.replaceFeature(id, {
              ...clone(patch),
              id,
              type: before.type,
            } as unknown as Feature);
          } else {
            // A null in the patch removes the field, as it does everywhere else
            // in this vocabulary. The store merges, so the removal is done here.
            const before = features().find((f) => f.id === id)! as unknown as Record<string, unknown>;
            const out: Record<string, unknown> = { ...before };
            for (const [k, v] of Object.entries(patch)) {
              if (v === null) delete out[k];
              else out[k] = clone(v);
            }
            out.id = id;
            store.replaceFeature(id, out as unknown as Feature);
          }
          return { ok: true, id };
        }

        case "feature_remove": {
          const id = str(args.id, "id");
          need(id);
          store.removeFeature(id);
          return { ok: true };
        }

        case "feature_move": {
          const id = str(args.id, "id");
          need(id);
          const to = args.to;
          if (typeof to !== "number") throw new HostRefused("to must be a number");
          const list = features();
          const from = list.findIndex((f) => f.id === id);
          const moved = clone(list);
          const [f] = moved.splice(from, 1);
          moved.splice(Math.max(0, Math.min(moved.length, to)), 0, f as Feature);
          store.mutate((d) => {
            d.features = moved;
          }, true);
          return { ok: true };
        }

        // Listed so this switch is exhaustive over Op and adding one to the
        // table does not compile until it is decided here. Unreachable: every
        // one of them is in UNSERVED above.
        case "doc_open":
        case "doc_save":
        case "build":
        case "inspect":
        case "view":
        case "export":
          throw new HostRefused(`${op} is not served here`);
      }
    },
  };
}
