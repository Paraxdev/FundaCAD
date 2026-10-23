// Every op a plugin can ask for and the grants it needs. The names are the MCP tool names on purpose, so there is one
// vocabulary. Unknown ops are refused, `needs` is every grant an op touches, and each row argues for its `why`.

import type { Grant } from "../manifest";

/** A name here missing from OP_TABLE does not compile. tests/plugins/broker.test.ts checks it against the app's op
 *  list. */
export const OPS = [
  "schema",
  "doc_new",
  "doc_open",
  "doc_import",
  "doc_save",
  "doc_get",
  "doc_set",
  "param_set",
  "param_remove",
  "feature_add",
  "feature_update",
  "feature_remove",
  "feature_move",
  "edit",
  "sketch_merge",
  "sketch_tie",
  "build",
  "interference",
  "measure",
  "section",
  "stress",
  "printability",
  "inspect",
  "view",
  "export",

  "file_pick",
  "file_read",
  "file_write",
  "app_info",
  "settings_get",
] as const;

export type Op = (typeof OPS)[number];

export interface OpSpec {
  /** ALL of these are required. Empty is legal and has to be argued for. */
  needs: readonly Grant[];
  /** one line, for a reader deciding whether the row is right */
  why: string;
  /** Not a permission: a guest attached to a running app proposes a write and waits for the app to adopt it,
   *  while a read is answered straight from the session. */
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
  doc_import: {
    needs: ["files.read", "document.write"],
    why: "reads geometry from a path and adds it to the timeline as a body feature",
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

  edit: {
    needs: ["document.write"],
    why: "applies several timeline and parameter edits at once, each one an edit the single ops already need this for",
    writes: true,
  },
  sketch_merge: {
    needs: ["document.write", "geometry.build"],
    why: "has the engine unite overlapping shapes of a sketch and writes the outline back into it",
    writes: true,
  },
  sketch_tie: {
    needs: ["document.write"],
    why: "adds constraints to a sketch and moves its loose ends onto what they touch",
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
  interference: {
    needs: ["document.read", "geometry.build"],
    why: "builds the open document and reports where its bodies overlap and how close they come, which is the document read back out",
    writes: false,
  },
  measure: {
    needs: ["document.read", "geometry.build"],
    why: "builds the open document and reports exact distances, wall thicknesses, radii and angles between its faces, edges and bodies, the document's own shape read out",
    writes: false,
  },
  section: {
    needs: ["document.read", "geometry.build"],
    why: "builds the open document and hands back its outline and section properties at a plane, the document's own shape read out",
    writes: false,
  },
  stress: {
    needs: ["document.read", "geometry.build"],
    why: "builds the open document and reports how one body bends and where it is most stressed under a load, without changing it",
    writes: false,
  },
  printability: {
    needs: ["document.read", "geometry.build"],
    why: "builds the open document and reports what would go wrong printing it, the document's own shape read out",
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
  settings_get: {
    needs: [],
    why: "the plugin's own settings as the person set them under its row in Preferences. The host answers for the calling plugin only and takes no id from the plugin, so it cannot read another's",
    writes: false,
  },
};

const OP_SET: ReadonlySet<string> = new Set<string>(OPS);

export function isOp(v: unknown): v is Op {
  return typeof v === "string" && OP_SET.has(v);
}

/** Undefined for a name that is not an op, which a caller must treat as a refusal, not as "requires nothing". */
export function requiredGrants(op: Op): readonly Grant[] {
  return OP_TABLE[op].needs;
}

/** Not a recommendation: what Preferences would show for a plugin asking for everything, and an open door for tests. */
export function allOpGrants(): Grant[] {
  const out = new Set<Grant>();
  for (const op of OPS) for (const g of OP_TABLE[op].needs) out.add(g);
  return [...out].sort();
}
