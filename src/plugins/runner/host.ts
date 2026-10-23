// The app's end of a sandbox. It owns the broker, so its grant check is the only one. It survives plugin bugs: bad
// messages are dropped, and a deadline plus caps on calls and log lines stop a runaway loop.

import { createBroker, type BrokerHost } from "../broker/broker";
import type { Grant } from "../manifest";
import { parseFromGuest, type Port, type ToGuest } from "./protocol";

export interface RunLimits {
  deadlineMs: number;
  /** Concurrency, not rate: a quick op never accumulates, since its reply drains before the next message arrives. This
   *  bounds slow ops held open at once; `totalCalls` is the rate cap. */
  inFlight: number;
  totalCalls: number;
  logLines: number;
}

/** Generous for anything sensible, firmly finite otherwise. A plugin needing more than half a minute should say so. */
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
  source: string;
  port: Port;
  limits?: Partial<RunLimits>;
  /** Called once the run is over, whatever the outcome, so the caller can end the Worker. */
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
    // Declared first: a synchronous test timer would otherwise reach `clearTimer(deadline)` in the temporal dead zone.
    let deadline: unknown;

    const send = (m: ToGuest) => {
      // A port that throws on send is a sandbox that has gone: finish rather than throw into whoever awaits a reply.
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

    const overLimit = (why: string) => finish({ ok: false, why, reason: "over-limit", calls, log });

    const onMessage = (ev: { data: unknown }) => {
      if (settled) return;
      const msg = parseFromGuest(ev.data);
      // Dropped silently: a plugin poking at the port gets no diagnostic telling it what shape to try next.
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
            // Checked again after the await: the deadline may have passed and the Worker been terminated.
            if (settled) return;
            send(
              r.ok
                ? { t: "reply", id: msg.id, ok: true, value: r.value }
                : {
                    t: "reply",
                    id: msg.id,
                    ok: false,
                    code: r.code,
                    why: r.why,
                    ...(r.missing ? { missing: r.missing } : {}),
                  },
            );
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
