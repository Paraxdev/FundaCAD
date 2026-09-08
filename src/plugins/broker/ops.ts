// Every operation a plugin can ask the app to perform, and what it must hold to
// ask. This is the whole vocabulary: a plugin reaches the app through exactly
// these, or it does not reach the app.
//
// Most of the names are the MCP server's tool names, unchanged and on purpose.
// That server already speaks a defined protocol over a token-gated socket,
// already has a schema for each of these, and already works. Inventing a second
// vocabulary here would mean a translation table, and a translation table is a
// place for the two halves to disagree about what `feature_move` means. There
// is one vocabulary and MCP is a transport for it.
//
// FOUR ARE NOT MCP'S: file_pick, file_read, file_write and app_info. They are
// what a plugin uses to reach past the window, and they are here rather than in
// a channel of their own because a second channel would be a second permission
// system to keep in step with this one. MCP has no equivalent for a reason
// worth knowing: an MCP server is a process on the machine and can open a file
// by naming it, where a compute plugin cannot name anything. See ./native.ts.
//
// Three rules.
//
// FAIL CLOSED ON THE OP. An op not in this table is refused, exactly as an
// unknown grant is refused at parse. A broker that passed through what it did
// not recognise would be a broker with a hole shaped like every op added after
// it was written.
//
// NEEDS IS EVERY GRANT, NOT THE MOST INTERESTING ONE. `doc_open` reads a file
// AND replaces the open document; `export` reads the document, runs the kernel
// and writes a file. An earlier sketch of this had one grant per op, which
// reads well and is false: it would have let a plugin holding only
// `geometry.build` call `build` and read the open document's body sizes back
// out of the answer.
//
// EVERY ENTRY CARRIES ITS REASON, including the empty ones. A `needs: []` with
// no argument for it is how an op quietly becomes free.

import type { Grant } from "../manifest";

/** The closed set. Adding a name here without adding it to OP_TABLE does not
 *  compile; adding it to neither is what `tests/plugins/broker.test.ts`
 *  catches, by asking the app's own op list rather than this one. */
export const OPS = [
  "schema",
  "doc_new",
  "doc_open",
  "doc_save",
  "doc_get",
  "doc_set",
  "param_set",
  "param_remove",
  "feature_add",
  "feature_update",
  "feature_remove",
  "feature_move",
  "build",
  "inspect",
  "view",
  "export",

  "file_pick",
  "file_read",
  "file_write",
  "app_info",
] as const;

export type Op = (typeof OPS)[number];

export interface OpSpec {
  /** ALL of these are required. Empty is legal and has to be argued for. */
  needs: readonly Grant[];
  /** one line, for a reader deciding whether the row is right */
  why: string;
  /** Whether it changes the open document. Not a permission, `document.write`
   *  is the permission, but the transport needs it: a guest attached to a
   *  running app proposes a replacement and waits for the app to adopt it,
   *  where a read can be answered straight from the session. */
  writes: boolean;
}

export const OP_TABLE: Record<Op, OpSpec> = {
  schema: {
    needs: [],
    why: "the feature schema is documentation compiled into the app; it names no document, reads nothing and changes nothing",
    writes: false,
  },

  doc_get: {
    needs: ["document.read"],
    why: "hands back the whole open document",
    writes: false,
  },
  doc_new: {
    needs: ["document.write"],
    why: "discards what is open, which is the most complete edit there is",
    writes: true,
  },
  doc_open: {
    needs: ["files.read", "document.write"],
    why: "reads a path off the disk and puts what it finds in place of the open document",
    writes: true,
  },
  doc_save: {
    needs: ["document.read", "files.write"],
    why: "reads the open document and writes it to a path",
    writes: false,
  },
  doc_set: {
    needs: ["document.write"],
    why: "replaces the open document wholesale",
    writes: true,
  },

  param_set: {
    needs: ["document.write"],
    why: "writes the parameter table, which drives every feature that names it",
    writes: true,
  },
  param_remove: {
    needs: ["document.write"],
    why: "takes a row out of the parameter table, which unmakes every feature that named it",
    writes: true,
  },
  feature_add: {
    needs: ["document.write"],
    why: "puts a new feature in the timeline, which is the ordinary way to change a part",
    writes: true,
  },
  feature_update: {
    needs: ["document.write"],
    why: "rewrites a feature already in the timeline, and everything downstream rebuilds from it",
    writes: true,
  },
  feature_remove: {
    needs: ["document.write"],
    why: "takes a feature out of the timeline, which can strand every reference to it",
    writes: true,
  },
  feature_move: {
    needs: ["document.write"],
    why: "reorders the timeline, and order is what decides which features a feature may name",
    writes: true,
  },

  build: {
    needs: ["document.read", "geometry.build"],
    why: "runs the kernel over the open document, and the sizes it reports are the document read back out",
    writes: false,
  },
  inspect: {
    needs: ["document.read", "geometry.build"],
    why: "measures the built bodies, which is the document at its most legible",
    writes: false,
  },
  view: {
    needs: ["document.read", "geometry.build"],
    why: "renders the built document to a picture, and a picture of a part is the part",
    writes: false,
  },
  export: {
    needs: ["document.read", "geometry.build", "files.write"],
    why: "builds the open document and writes the result to a path",
    writes: false,
  },

  // The four that reach past the window. Served in Rust, checked here.
  file_pick: {
    needs: ["files.read"],
    why: "opens a picker and, if the person chooses something, hands back a handle for that one file",
    writes: false,
  },
  file_read: {
    needs: ["files.read"],
    why: "reads a file the person already picked; it takes a handle and never a path, so it can reach nothing else",
    writes: false,
  },
  file_write: {
    needs: ["files.write"],
    why: "opens a save dialog and writes what the plugin gave it where the person said",
    writes: false,
  },
  app_info: {
    needs: [],
    why: "the version, the platform and the architecture. A plugin that cannot tell what it is running on has to assume or break, and none of the three says anything about the person",
    writes: false,
  },
};

const OP_SET: ReadonlySet<string> = new Set<string>(OPS);

/** Whether a name off the wire is an op at all. Everything arriving from a
 *  plugin comes through here first. */
export function isOp(v: unknown): v is Op {
  return typeof v === "string" && OP_SET.has(v);
}

/** What an op requires. Undefined for anything that is not an op, which the
 *  caller must treat as a refusal and not as "requires nothing". */
export function requiredGrants(op: Op): readonly Grant[] {
  return OP_TABLE[op].needs;
}

/** The grants that would let a plugin call every op. Not a recommendation: it
 *  is what the Preferences screen would have to show for a plugin that asked
 *  for the lot, and it is useful in a test that wants an unrestricted door. */
export function allOpGrants(): Grant[] {
  const out = new Set<Grant>();
  for (const op of OPS) for (const g of OP_TABLE[op].needs) out.add(g);
  return [...out].sort();
}
