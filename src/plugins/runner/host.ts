// The app's end of a sandbox.
//
// It owns the broker and therefore owns every decision. The guest sends a name
// and some arguments; this looks the name up, checks the grants, performs it,
// and sends back an answer. A guest that asks for something it did not ask for
// at install gets a refusal, and the refusal is the same value a plugin calling
// the broker directly would get, because it IS the broker: there is one grant
// check in this system and this is not a second one.
//
// WHAT THE HOST DEFENDS AGAINST, since the thing on the other end is code
// nobody here wrote:
//
//   * a message that is not one            dropped, not partially acted on
//   * a plugin that never finishes         a deadline, after which it is stopped
//   * a plugin holding slow work open     a cap on calls in flight
//   * a plugin that calls without pause    a cap on calls in total
//   * a plugin that logs a river           lines truncated, and a cap on how many
//   * a plugin that replies after `done`   ignored; the run is over once it is
//
// None of those is exotic. Each is what a plugin does the first time its author
// writes a loop wrong, which is why the host has to survive them rather than
// treat them as attacks to report.
//
// The port is injected. A Worker satisfies it in the app; a MessageChannel
// satisfies it in a test, with the guest running in the same process, which is
// how everything below is exercised without a browser.

import { createBroker, type BrokerHost } from "../broker/broker";
import type { Grant } from "../manifest";
import { parseFromGuest, type Port, type ToGuest } from "./protocol";

export interface RunLimits {
  /** How long the whole run may take, in milliseconds. */
  deadlineMs: number;
  /** How many ops may be outstanding at once.
   *
   *  CONCURRENCY, NOT RATE, and the difference is easy to get wrong. An op that
   *  answers immediately never accumulates: its reply's microtask drains before
   *  the next message from the sandbox is even delivered, so a plugin can make
   *  a thousand quick calls in a row with one outstanding the whole time. What
   *  this bounds is a plugin holding many SLOW ops open at once, which is the
   *  shape that costs the app something. `totalCalls` is the rate one. */
  inFlight: number;
  /** How many ops the run may make in total. */
  totalCalls: number;
  /** How many lines of output are kept. */
  logLines: number;
}

/** Chosen to be generous for anything sensible and firmly finite for anything
 *  else. A plugin that wants longer than half a minute is doing something this
 *  design has not thought about yet, and should say so rather than discover it
 *  in the field. */
export const DEFAULT_LIMITS: RunLimits = {
  deadlineMs: 30_000,
  inFlight: 8,
  totalCalls: 2000,
  logLines: 500,
};

export type RunOutcome =
  | { ok: true; value: unknown; calls: number; log: string[] }
  | { ok: false; why: string; reason: RunFailure; calls: number; log: string[] };

export type RunFailure =
  /** the plugin itself threw, or the sandbox could not run it */
  | "plugin-failed"
  /** it ran past its deadline */
  | "timed-out"
  /** it broke one of the limits above */
  | "over-limit"
  /** the sandbox went away without answering */
  | "sandbox-lost";

export interface RunOptions {
  plugin: string;
  grants: readonly Grant[];
  host: BrokerHost;
  /** The plugin's code, handed to the sandbox to run. */
  source: string;
  port: Port;
  limits?: Partial<RunLimits>;
  /** Called when the run is over, whatever the outcome, so the caller can end
   *  the Worker. Separate from the port, which knows nothing about lifecycles. */
  dispose?: () => void;
  /** Injected so a test can drive the deadline without waiting for one. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function runInSandbox(opts: RunOptions): Promise<RunOutcome> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const broker = createBroker({
    plugin: opts.plugin,
    grants: opts.grants,
    host: opts.host,
  });

  const log: string[] = [];
  let calls = 0;
  let outstanding = 0;
  let settled = false;

  return new Promise<RunOutcome>((resolve) => {
    // Declared before anything can call `finish`. A timer that fires
    // synchronously — which a test can arrange and a stubbed clock does — would
    // otherwise reach `clearTimer(deadline)` before the `const` below had been
    // initialised, and die in the temporal dead zone rather than time out.
    let deadline: unknown;

    const send = (m: ToGuest) => {
      // A port that throws on send is a sandbox that has gone, which is a state
      // to finish in rather than an exception to propagate into whatever
      // happened to be awaiting a reply.
      try {
        opts.port.postMessage(m);
      } catch {
        finish({ ok: false, why: "the sandbox closed", reason: "sandbox-lost", calls, log });
      }
    };

    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimer(deadline);
      opts.port.removeEventListener("message", onMessage);
      opts.dispose?.();
      resolve(outcome);
    };

    const overLimit = (why: string) =>
      finish({ ok: false, why, reason: "over-limit", calls, log });

    const onMessage = (ev: { data: unknown }) => {
      if (settled) return;
      const msg = parseFromGuest(ev.data);
      // Dropped in silence. A malformed message is either a bug in the sandbox
      // bootstrap, which is our own file and would be caught by its tests, or a
      // plugin poking at the port directly, which is not something to reward
      // with a diagnostic that tells it what shape to try next.
      if (!msg) return;

      switch (msg.t) {
        case "ready":
          send({ t: "start", source: opts.source, grants: broker.grants });
          return;

        case "log":
          if (log.length < limits.logLines) log.push(msg.text);
          return;

        case "done":
          finish({ ok: true, value: msg.value, calls, log });
          return;

        case "failed":
          finish({ ok: false, why: msg.why, reason: "plugin-failed", calls, log });
          return;

        case "call": {
          if (calls >= limits.totalCalls) {
            overLimit(`the plugin made more than ${limits.totalCalls} requests`);
            return;
          }
          if (outstanding >= limits.inFlight) {
            overLimit(`the plugin had more than ${limits.inFlight} requests in flight`);
            return;
          }
          calls += 1;
          outstanding += 1;
          void broker.call(msg.op, msg.params).then((r) => {
            outstanding -= 1;
            // Checked after the await as well as before: the deadline can pass
            // while an op is running, and answering a run that is over would
            // post to a port whose Worker has already been terminated.
            if (settled) return;
            send(r.ok ? { t: "reply", id: msg.id, ok: true, value: r.value } : {
              t: "reply",
              id: msg.id,
              ok: false,
              code: r.code,
              why: r.why,
              ...(r.missing ? { missing: r.missing } : {}),
            });
          });
          return;
        }
      }
    };

    deadline = setTimer(() => {
      finish({
        ok: false,
        why: `the plugin did not finish within ${limits.deadlineMs}ms`,
        reason: "timed-out",
        calls,
        log,
      });
    }, limits.deadlineMs);

    opts.port.addEventListener("message", onMessage);
  });
}
