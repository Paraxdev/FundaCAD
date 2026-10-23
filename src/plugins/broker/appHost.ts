// The broker's host for the open document. Edits go through the store, so a plugin's change is one undo step and
// reruns the parameter cascade and rebuild. File ops need a NativeBridge and refuse by name without one.

import { storedSettings } from "../settings";
import type { CadDocument, Feature } from "../../types";
import type { DocumentStore } from "../../document/store";
import { ensureBodyIds } from "../../document/bodyIds";
import type { BrokerHost } from "./broker";
import type { NativeBridge } from "./native";
import type { Op } from "./ops";

/** Refused by the host, not the broker. The broker hands it to the plugin as `{ ok: false, code: "failed" }`. */
export class HostRefused extends Error {}

const WRITES = new Set<Op>([
  "doc_set",
  "param_set",
  "param_remove",
  "feature_add",
  "feature_update",
  "feature_remove",
  "feature_move",
]);

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

/** The reason tells a plugin author whether to wait or do something else. Shared with ./testing.ts so a test
 *  double never serves something the app refuses. */
export const UNSERVED: Partial<Record<Op, string>> = {
  // These name a path, and a plugin has no paths, so the refusal names what to do instead.
  doc_open: "a plugin cannot name a file. Use file_pick, then file_read, then doc_set",
  doc_import: "a plugin cannot name a file. Use file_pick, then file_read, then doc_set",
  doc_save: "a plugin cannot name a file. Use doc_get, then file_write",
  export:
    "exporting needs the geometry engine, which a plugin cannot reach yet. Once it can, the file half is doc_get and file_write",
  build: "the geometry engine is not reachable from a plugin yet",
  inspect: "the geometry engine is not reachable from a plugin yet",
  view: "the geometry engine is not reachable from a plugin yet",
  interference: "the geometry engine is not reachable from a plugin yet",
  measure: "the geometry engine is not reachable from a plugin yet",
  section: "the geometry engine is not reachable from a plugin yet",
  stress: "the geometry engine is not reachable from a plugin yet",
  printability: "the geometry engine is not reachable from a plugin yet",
  sketch_merge: "the geometry engine is not reachable from a plugin yet",
  sketch_tie: "not served to plugins yet",
  edit: "not served to plugins yet. Call the single ops (feature_add, feature_update, param_set) one by one",
};

export interface AppHostOptions {
  store: DocumentStore;
  /** Files a plugin is handed are recorded against this id in Rust, so one plugin cannot read another's file.
   *  Without it no file op is served. */
  plugin?: string;
  /** For `schema`. Passed in because the list belongs to whatever renders the tool palette. */
  featureTypes?: () => string[];
  /** Absent in a browser session and in tests that did not ask for one; the file ops then refuse. */
  native?: NativeBridge;
}

export function appHost(opts: AppHostOptions): BrokerHost {
  const { store } = opts;

  const bridge = (op: Op): { native: NativeBridge; plugin: string } => {
    if (!opts.native) {
      throw new HostRefused(`${op}: files are handled by the desktop app, and this is not running in it`);
    }
    if (!opts.plugin) {
      throw new HostRefused(
        `${op}: this host was built without a plugin id, so a file could not be recorded against anybody`,
      );
    }
    return { native: opts.native, plugin: opts.plugin };
  };

  /** Capped here as well as in Rust, so a megabyte of "purpose" never goes on an IPC message. */
  const words = (v: unknown, fallback: string): string => {
    const t = typeof v === "string" ? v.trim() : "";
    return (t || fallback).slice(0, 200);
  };

  const features = (): Feature[] => store.document.features ?? [];
  const has = (id: string) => features().some((f) => f.id === id);

  const need = (id: string) => {
    if (!has(id)) {
      const ids = features().map((f) => f.id);
      throw new HostRefused(`no feature ${JSON.stringify(id)}, have ${ids.join(", ") || "none"}`);
    }
  };

  // A host serves one plugin run, and the run works on the document open when it started. Once the user closes that
  // document, every write of the run is refused, a read of the next one included; only its own doc_new moves it on.
  let session = store.session;
  const sameDocument = (op: Op) => {
    if (session.alive || !(WRITES.has(op) || op === "doc_new")) return;
    throw new HostRefused(`${op}: the document this plugin run was working on was closed, nothing was applied`);
  };

  return {
    async perform(op: Op, args: Record<string, unknown>): Promise<unknown> {
      const unserved = UNSERVED[op];
      if (unserved) throw new HostRefused(`${op}: ${unserved}`);
      sameDocument(op);

      switch (op) {
        case "app_info":
          return await bridge(op).native.info();

        case "settings_get":
          if (!opts.plugin)
            throw new HostRefused(`${op}: this host was built without a plugin id, so it has no settings to read`);
          return storedSettings(opts.plugin);

        case "file_pick": {
          const { native, plugin } = bridge(op);
          const raw = args.extensions;
          const extensions = Array.isArray(raw)
            ? raw.filter((e): e is string => typeof e === "string").slice(0, 16)
            : [];
          // null, not an error: a dismissed dialog is a complete answer, not a failure to report.
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
          // The document as a save writes it, so doc_set of it loses nothing. A deep copy,
          // since toObject shares the live features and versions a plugin must not edit in place.
          return clone(store.toObject());

        case "doc_new":
          store.newDocument();
          session = store.session;
          return { ok: true };

        case "doc_set": {
          // The import lands in whatever document is open when its read ends, and this one may be another file.
          if (store.importRunning) {
            throw new HostRefused(
              `${op}: an import is still being read into the open document, nothing was applied, try again once it has landed`,
            );
          }
          const next = clone(obj(args.document, "document")) as unknown as CadDocument;
          next.parameters ??= {};
          next.features ??= [];
          ensureBodyIds(next);
          store.loadDocument(next, { replace: true });
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
              if (k === "id" || k === "type") continue;
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

        // Listed so the switch stays exhaustive over Op and a new op does not compile until decided here.
        // Unreachable, since all of them are in UNSERVED.
        case "doc_open":
        case "doc_import":
        case "doc_save":
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
          throw new HostRefused(`${op} is not served here`);
      }
    },
  };
}
