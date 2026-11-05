import { describe, expect, it } from "vitest";

import { MAX_LOG, MAX_RESULT, parseFromGuest } from "../../src/plugins/runner/protocol";

describe("what a plugin hands back is size capped", () => {
  it("keeps a failure reason no longer than a log line", () => {
    const msg = parseFromGuest({ t: "failed", why: "x".repeat(MAX_LOG * 50) });
    expect(msg).toMatchObject({ t: "failed" });
    expect(msg?.t === "failed" && msg.why.length).toBe(MAX_LOG);
  });

  it("turns a result over the cap into a failure", () => {
    const msg = parseFromGuest({ t: "done", value: { blob: "y".repeat(MAX_RESULT + 1) } });
    expect(msg).toMatchObject({ t: "failed" });
    expect(msg?.t === "failed" && msg.why).toContain(String(MAX_RESULT));
  });

  it("turns a result that is not JSON into a failure", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(parseFromGuest({ t: "done", value: loop })).toMatchObject({ t: "failed" });
  });

  it("passes an ordinary result through unchanged", () => {
    const value = { faces: [1, 2, 3], name: "ok" };
    expect(parseFromGuest({ t: "done", value })).toEqual({ t: "done", value });
    expect(parseFromGuest({ t: "done" })).toEqual({ t: "done", value: undefined });
  });
});
