// Once per session before the first traced frame. A failed check greys Path traced with the reason instead of
// showing a wrong picture; a check that could not run is only logged.

import { crumb } from "../../diagnostics/breadcrumbs";
import type { NativeProbe } from "./choose";
import type { Call } from "./nativeScene";

export interface SelfCheckAnswer {
  diff: number;
  threshold: number;
  noise: number;
  ms: number;
  path: string;
  passed: boolean;
}

let once: Promise<SelfCheckAnswer | null> | null = null;

function isAnswer(a: unknown): a is SelfCheckAnswer {
  const o = a as Partial<SelfCheckAnswer> | null;
  return (
    !!o &&
    typeof o.diff === "number" &&
    typeof o.threshold === "number" &&
    typeof o.ms === "number" &&
    typeof o.passed === "boolean"
  );
}

let failed: SelfCheckAnswer | null = null;

export function runSelfCheck(call: Call): Promise<SelfCheckAnswer | null> {
  const run = (once ??= (async () => {
    try {
      const a = await call("pt_selfcheck");
      if (!isAnswer(a)) return null;
      const nums = `diff ${a.diff.toFixed(2)}, threshold ${a.threshold.toFixed(2)} of 255, ${Math.round(a.ms)} ms`;
      crumb(`tracer self check ${a.passed ? "passed" : "FAILED"} on ${a.path}: ${nums}`);
      if (!a.passed) failed = a;
      return a;
    } catch (e) {
      once = null;
      crumb(`tracer self check did not run: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  })());
  return run;
}

export function failedSelfCheck(): SelfCheckAnswer | null {
  return failed;
}

export function selfCheckReason(a: SelfCheckAnswer): string {
  return `the native tracer drew its test scene wrong on ${a.path} (diff ${a.diff.toFixed(2)} over ${a.threshold.toFixed(2)} of 255)`;
}

/** The probe as the page holds it once the self check failed: refused with
 *  the selfcheck class, which greys Path traced where WebGPU cannot stand in. */
export function refusedBySelfCheck(p: NativeProbe, a: SelfCheckAnswer): NativeProbe {
  return { ...p, available: false, class: "selfcheck", reason: selfCheckReason(a) };
}

export function resetSelfCheckForTest() {
  once = null;
  failed = null;
}
