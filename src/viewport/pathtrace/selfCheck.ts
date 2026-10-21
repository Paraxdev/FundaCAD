// The native tracer holds a small known picture against its reference once per
// session, before the first traced frame. The answer is only logged: tracer
// faults are for a tracer that stopped, and this phase never raises one.

import { crumb } from "../../diagnostics/breadcrumbs";
import type { Call } from "./nativeScene";

export interface SelfCheckAnswer {
  diff: number;
  threshold: number;
  noise: number;
  ms: number;
  path: string;
  passed: boolean;
}

let once: Promise<void> | null = null;

function isAnswer(a: unknown): a is SelfCheckAnswer {
  const o = a as Partial<SelfCheckAnswer> | null;
  return !!o && typeof o.diff === "number" && typeof o.threshold === "number" && typeof o.ms === "number" && typeof o.passed === "boolean";
}

export function runSelfCheck(call: Call): Promise<void> {
  const run = (once ??= (async () => {
    try {
      const a = await call("pt_selfcheck");
      if (!isAnswer(a)) return;
      const nums = `diff ${a.diff.toFixed(2)}, threshold ${a.threshold.toFixed(2)} of 255, ${Math.round(a.ms)} ms`;
      crumb(`tracer self check ${a.passed ? "passed" : "FAILED"} on ${a.path}: ${nums}`);
    } catch (e) {
      once = null;
      crumb(`tracer self check did not run: ${e instanceof Error ? e.message : String(e)}`);
    }
  })());
  return run;
}

export function resetSelfCheckForTest() {
  once = null;
}
