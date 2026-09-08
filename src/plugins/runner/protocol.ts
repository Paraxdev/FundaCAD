// What crosses the boundary between the app and a plugin's sandbox.
//
// Two rules, and they are the same rule looked at from each side.
//
// EVERY MESSAGE FROM THE GUEST IS UNTRUSTED. It arrives from code the app did
// not write, running in a sandbox whose entire purpose is that it might be
// hostile. So nothing here reads a field without checking it first, and a
// message that does not typecheck is dropped rather than partially acted on.
// The parsers below are the only way a guest message becomes a value the host
// will use.
//
// THE GUEST NAMES OPS, IT DOES NOT PERFORM THEM. A call goes over the wire as a
// name and a bag of arguments; the host looks the name up in the op table,
// checks it against the grants the INSTALL recorded, and only then performs it.
// The guest is told its grants so it can decide what to attempt, but that copy
// is advice. Nothing on the guest's side of this file can widen anything.
//
// Deliberately not JSON-RPC. It would be a familiar envelope around the same
// four messages plus a spec's worth of cases nothing here has ("notification",
// "batch", error codes with meanings we would have to invent mappings for), and
// the parsers would be longer for it.

import type { Grant } from "../manifest";
import type { RefusalCode } from "../broker/broker";

/** Host to guest. */
export type ToGuest =
  /** Run this. Sent once, and the guest that receives a second one is buggy or
   *  hostile; either way the host does not send them. */
  | { t: "start"; source: string; grants: readonly Grant[] }
  /** The answer to one `call`. */
  | { t: "reply"; id: number; ok: true; value: unknown }
  | { t: "reply"; id: number; ok: false; code: RefusalCode; why: string; missing?: Grant[] };

/** Guest to host. */
export type ToHost =
  /** The sandbox is up and has not yet run anything. */
  | { t: "ready" }
  /** Perform an op. `id` is the guest's, and is echoed back. */
  | { t: "call"; id: number; op: string; params: unknown }
  /** The plugin finished. */
  | { t: "done"; value: unknown }
  /** The plugin threw, or the sandbox could not run it. */
  | { t: "failed"; why: string }
  /** Something the plugin printed. Kept as a distinct message rather than
   *  letting a plugin write to the host's console directly: it is untrusted
   *  text and the host decides where it goes and how much of it to keep. */
  | { t: "log"; text: string };

/** The name ./sandbox.ts registers on the Worker's global, and the name
 *  ./spawn.ts writes into the generated script.
 *
 *  Here rather than in either of them because both ends need it and this is the
 *  file they already share. Importing the worker entry from the main thread to
 *  read one string would pull a module that is built as a separate chunk into
 *  the main bundle. */
export const START = "__fundacadStartPlugin";

/** Longest a single line of plugin output is kept. A plugin that logs a
 *  megabyte per line is not debugging, and the host holding those is the
 *  cheapest denial of service in this design. */
export const MAX_LOG = 2000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a message from the guest, or null if it is not one.
 *
 *  Null rather than a throw: this runs on every message from untrusted code,
 *  and an exception here would put a plugin's malformed message into the host's
 *  own error path, where it becomes a crash report about the app. */
export function parseFromGuest(raw: unknown): ToHost | null {
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case "ready":
      return { t: "ready" };
    case "call": {
      // A non-integer id would come back in a reply the guest could not match,
      // and a negative or huge one is not something this side ever issued.
      if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || raw.id < 0) return null;
      if (typeof raw.op !== "string") return null;
      return { t: "call", id: raw.id, op: raw.op, params: raw.params };
    }
    case "done":
      return { t: "done", value: raw.value };
    case "failed":
      return { t: "failed", why: typeof raw.why === "string" ? raw.why : "the plugin failed" };
    case "log":
      return { t: "log", text: String(raw.text ?? "").slice(0, MAX_LOG) };
    default:
      return null;
  }
}

/** Parse a message from the host.
 *
 *  Symmetric with the above, and the symmetry is the point rather than
 *  politeness: the guest has no reason to trust that whatever is on the other
 *  end of its port is this app, and a sandbox that assumes it is well hosted is
 *  one more thing to get right when it is embedded somewhere else. */
export function parseFromHost(raw: unknown): ToGuest | null {
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case "start": {
      if (typeof raw.source !== "string") return null;
      const grants = Array.isArray(raw.grants) ? raw.grants.filter((g) => typeof g === "string") : [];
      return { t: "start", source: raw.source, grants: grants as Grant[] };
    }
    case "reply": {
      if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id)) return null;
      if (raw.ok === true) return { t: "reply", id: raw.id, ok: true, value: raw.value };
      return {
        t: "reply",
        id: raw.id,
        ok: false,
        code: (typeof raw.code === "string" ? raw.code : "failed") as RefusalCode,
        why: typeof raw.why === "string" ? raw.why : "refused",
        ...(Array.isArray(raw.missing) ? { missing: raw.missing as Grant[] } : {}),
      };
    }
    default:
      return null;
  }
}

/** The two ends of a channel, as little of one as this needs.
 *
 *  Narrowed to these two members on purpose. A `Worker` satisfies it, so does a
 *  `MessagePort`, and so does an object a test made up, which is what lets the
 *  whole protocol below be exercised without a browser. Anything wider would
 *  drag `Worker`'s lifecycle into code that has no business ending one. */
export interface Port {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}
