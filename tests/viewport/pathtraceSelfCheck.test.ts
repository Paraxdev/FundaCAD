import { beforeEach, describe, expect, it } from "vitest";
import { breadcrumbs } from "../../src/diagnostics/breadcrumbs";
import { NativeTracer } from "../../src/viewport/pathtrace/nativeTracer";
import { resetSelfCheckForTest } from "../../src/viewport/pathtrace/selfCheck";

const failing = { diff: 9.5, threshold: 3.4, noise: 0.35, ms: 410, path: "software", passed: false };

function tracer(answer: unknown, calls: string[]) {
  const canvas = { style: {} as Record<string, string>, remove() {} } as unknown as HTMLCanvasElement;
  const link = { kind: "fake", close() {}, next: async () => null, release() {} };
  return new NativeTracer({
    canvas,
    blit: () => ({ maxTextureSize: 4096, upload: () => {}, dispose: () => {} }),
    connect: async () => ({ link: link as never, generation: 1, source: "test" }),
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

  it("logs a failing answer and never reaches onFault", async () => {
    const calls: string[] = [];
    const t = tracer(failing, calls);
    const faults: string[] = [];
    t.onFault((why) => faults.push(why));
    await t.init();
    expect(faults).toEqual([]);
    expect(breadcrumbs().some((b) => /tracer self check FAILED on software: diff 9\.50, threshold 3\.40 of 255, 410 ms/.test(b))).toBe(true);
  });

  it("logs an error the same way and asks once per session", async () => {
    const calls: string[] = [];
    const faults: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = tracer(new Error("no adapter"), calls);
      t.onFault((why) => faults.push(why));
      await t.init();
    }
    expect(calls.filter((c) => c === "pt_selfcheck")).toHaveLength(1);
    expect(faults).toEqual([]);
    expect(breadcrumbs().some((b) => b.includes("tracer self check did not run: no adapter"))).toBe(true);
  });
});
