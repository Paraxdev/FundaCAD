// What crosses between the app and a plugin's sandbox. Every guest message is untrusted and is parsed or dropped, never
// partly acted on. The guest names ops; the host checks them against the installed grants before performing them.

import type { Grant } from "../manifest";
import type { RefusalCode } from "../broker/broker";

/** Host to guest. */
export type ToGuest =
  /** Run this. Sent once only. */
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
  /** Something the plugin printed. Untrusted text, so the host decides where it goes and how much of it to keep. */
  | { t: "log"; text: string };

/** Registered by ./sandbox.ts on the Worker's global and written by ./spawn.ts. Here so the main thread need not import
 *  the worker entry, a separate chunk, to read one string. */
export const START = "__fundacadStartPlugin";

/** Longest line of plugin output kept, so a megabyte per line cannot be a cheap denial of service. */
export const MAX_LOG = 2000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Null rather than a throw, so a plugin's malformed message never becomes a crash report about the app. */
export function parseFromGuest(raw: unknown): ToHost | null {
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case "ready":
      return { t: "ready" };
    case "call": {
      // A non-integer id could not be matched in a reply, and a negative or huge one was never issued.
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

/** Symmetric on purpose: the guest cannot trust that this app is on the other end of its port. */
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

/** Just these members, so a Worker, a MessagePort or a test object fits without dragging in a Worker's lifecycle. */
export interface Port {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}
