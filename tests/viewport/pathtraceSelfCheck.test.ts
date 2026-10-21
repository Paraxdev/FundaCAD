import { beforeEach, describe, expect, it } from "vitest";
import { breadcrumbs } from "../../src/diagnostics/breadcrumbs";
import { NativeTracer } from "../../src/viewport/pathtrace/nativeTracer";
import { chooseTracer } from "../../src/viewport/pathtrace/choose";
import { failedSelfCheck, refusedBySelfCheck, resetSelfCheckForTest } from "../../src/viewport/pathtrace/selfCheck";
import { PATH_TRACING_SELF_CHECK, pathTracedBlock } from "../../src/ui/viewMode";

const passing = { diff: 0.29, threshold: 2.98, noise: 0.25, ms: 428, path: "software", passed: true };
const failing = { diff: 9.5, threshold: 3.4, noise: 0.35, ms: 410, path: "software", passed: false };

function tracer(answer: unknown, calls: string[]) {
  const canvas = { style: {} as Record<string, string>, remove() {} } as unknown as HTMLCanvasElement;
  const link = { kind: "fake", close() {}, next: async () => null, release() {} };
  return new NativeTracer({
    canvas,
    blit: () => ({ maxTextureSize: 4096, upload: () => {}, dispose: () => {} }),
    connect: async () => {
      calls.push("connect");
      return { link: link as never, generation: 1, source: "test" };
    },
    call: async (cmd) => {
      calls.push(cmd);
      if (cmd === "pt_selfcheck") {
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return cmd === "pt_status" ? { samples: 1, fault: null } : undefined;
    },
  });
}

describe("the tracer self check", () => {
  beforeEach(resetSelfCheckForTest);

  it("logs a failing answer and refuses to start, so no wrong picture is shown", async () => {
    const calls: string[] = [];
    const t = tracer(failing, calls);
    await expect(t.init()).rejects.toThrow("the native tracer drew its test scene wrong on software (diff 9.50 over 3.40 of 255)");
    expect(failedSelfCheck()).toEqual(failing);
    expect(breadcrumbs().some((b) => /tracer self check FAILED on software: diff 9\.50, threshold 3\.40 of 255, 410 ms/.test(b))).toBe(true);
  });

  it("starts on a passing answer", async () => {
    await tracer(passing, []).init();
    expect(failedSelfCheck()).toBeNull();
  });

  it("greys Path traced with the reason when no WebGPU can stand in, and leaves WebGPU where it can", async () => {
    const probe = { available: true, path: "software" as const, adapter: "Apple Paravirtual device (Metal, integrated GPU)" };
    const refused = refusedBySelfCheck(probe, failing);
    expect(pathTracedBlock({ lowPower: false, auto: false, webgpu: false, native: refused })).toEqual({ reason: "nogpu", tooltip: PATH_TRACING_SELF_CHECK });
    expect(pathTracedBlock({ lowPower: false, auto: false, webgpu: false, native: probe })).toBeNull();
    expect(chooseTracer("auto", { webgpu: true, native: refused })).toBe("webgpu");
    expect(chooseTracer("native", { webgpu: false, native: refused })).toBeNull();
  });

  it("asks after the native tracer is open, which frames_open does", async () => {
    const calls: string[] = [];
    await tracer(failing, calls).init().catch(() => {});
    expect(calls.indexOf("pt_selfcheck")).toBeGreaterThan(calls.indexOf("connect"));
    expect(calls.indexOf("connect")).toBeGreaterThanOrEqual(0);
  });

  it("logs an error the same way, without a fault", async () => {
    const calls: string[] = [];
    const faults: string[] = [];
    const t = tracer(new Error("no adapter"), calls);
    t.onFault((why) => faults.push(why));
    await t.init();
    expect(faults).toEqual([]);
    expect(breadcrumbs().some((b) => b.includes("tracer self check did not run: no adapter"))).toBe(true);
  });

  it("asks once per session once it has answered, and again after an error", async () => {
    const calls: string[] = [];
    await tracer(new Error("not open"), calls).init();
    await tracer(failing, calls).init().catch(() => {});
    await expect(tracer(failing, calls).init()).rejects.toThrow(/test scene wrong/);
    expect(calls.filter((c) => c === "pt_selfcheck")).toHaveLength(2);
  });
});
