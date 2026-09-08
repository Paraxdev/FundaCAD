// The pipeline log's whole value is what survives until somebody files a report.
//
// A rebuild writes a handful of these lines and dragging a slider writes dozens
// a second, so anything in the rolling ring is gone within seconds. The fault
// itself has to outlive that by minutes or hours, because the gap between a
// body drawing wrong and a person deciding to report it is however long they
// spend trying to work around it first.
import { beforeEach, describe, expect, it } from "vitest";
import {
  hasFaults, pipe, pipeFault, pipelineLog, resetPipelineLog,
} from "../../src/diagnostics/pipelineLog";

beforeEach(() => resetPipelineLog());

describe("pipelineLog", () => {
  it("says so plainly when nothing has gone wrong", () => {
    pipe("commit bodies=3 built=1 reused=2");
    const out = pipelineLog();
    expect(hasFaults()).toBe(false);
    expect(out[0]).toBe("[pipeline] no faults detected this session");
    expect(out.join("\n")).toContain("commit bodies=3");
  });

  it("keeps a fault after the ordinary events around it have rolled away", () => {
    pipeFault("commit: scene MISMATCH, 1 EXTRA [body b7 etag=etag-STALE]");
    for (let i = 0; i < 500; i++) pipe(`commit ${i}`);

    const out = pipelineLog().join("\n");
    expect(hasFaults()).toBe(true);
    expect(out).toContain("body b7 etag=etag-STALE");
    // ...and the rolling half really did roll, which is what makes the sentence
    // above a claim rather than a coincidence.
    expect(out).not.toContain("commit 0\n");
    expect(out).toContain("commit 499");
  });

  it("says how long ago the fault was, because the trail can no longer tell", () => {
    pipeFault("scene MISMATCH");
    for (let i = 0; i < 300; i++) pipe(`commit ${i}`);
    expect(pipelineLog()[0]).toBe("[pipeline] 1 FAULT(S) this session, 300 events since the last");
  });

  it("bounds the rolling ring", () => {
    for (let i = 0; i < 5000; i++) pipe(`commit ${i}`);
    // header + the ring's own cap, nowhere near 5000
    expect(pipelineLog().length).toBeLessThan(140);
  });

  it("bounds the faults too, and says it stopped rather than going quiet", () => {
    // A leak that fires every commit would otherwise grow without limit for as
    // long as the session runs. Truncating silently would be worse than the
    // cap: the report would read as though the fault had stopped.
    for (let i = 0; i < 100; i++) pipeFault(`fault ${i}`);
    const out = pipelineLog();
    expect(out.length).toBeLessThan(200);
    expect(out.join("\n")).toContain("further faults not recorded");
    expect(out.join("\n")).toContain("fault 0"); // the FIRST one is the one kept
  });

  it("timestamps to the millisecond, since order within a second is the question", () => {
    pipe("stream begin epoch=4");
    expect(pipelineLog().at(-1)).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d stream begin epoch=4$/);
  });
});
