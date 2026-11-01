import { describe, expect, it } from "vitest";

// @ts-expect-error a test helper in plain CommonJS, with no types.
import flashRun from "./fixtures/flashRun.cjs";

const { realPlaywrightOpensLog, runFlash } = flashRun;

describe("the flash script's env", () => {
  it("has Playwright load with its browser channel going to the log in a WebGPU run, keeping a DEBUG already set", () => {
    const { lines, chromeLog } = runFlash({ FLASH_TRACER: "webgpu", DEBUG: "other" }, { gotoThrowsAfterMs: 0 });
    expect(lines[0]).toBe(`fake load ${JSON.stringify({ DEBUG: "other,pw:browser", DEBUG_FILE: chromeLog })}`);
  });

  it("leaves both alone in a native run", () => {
    const { lines } = runFlash({ DEBUG: "other" }, { gotoThrowsAfterMs: 0 });
    expect(lines[0]).toBe(`fake load ${JSON.stringify({ DEBUG: "other" })}`);
  });

  it("is what the real playwright-core opens its log from as it loads", () => {
    expect(realPlaywrightOpensLog()).toEqual({ status: 0, opened: true });
  });
});

describe("a native flash run", () => {
  it("logs as it did: the old filter and width, its own args, no Chrome log and no deadline", () => {
    const long = `tracer ${"x".repeat(400)}`;
    const run = runFlash(
      { FLASH_DEADLINE_S: "0.05" },
      { consoleLines: ["boring", "tracer ready", long], chromeLines: ["never"], gotoThrowsAfterMs: 300 },
    );
    expect({ status: run.status, lines: run.lines, files: run.files }).toEqual({
      status: 1,
      lines: [
        `fake load ${JSON.stringify({})}`,
        `fake launch ${JSON.stringify(["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=swiftshader"])}`,
        "[page] tracer ready",
        `[page] ${long.slice(0, 300)}`,
      ],
      files: ["report.json"],
    });
    expect(run.stderr).toContain("fake stop");
    expect(run.stderr).not.toContain("still running");
  });
});

describe("a WebGPU flash run", () => {
  const webgpu = { FLASH_TRACER: "webgpu" };

  it("that hangs stops itself at FLASH_DEADLINE_S and prints the tail it held and the end of Chrome's log", () => {
    const consoleLines = Array.from({ length: 1400 }, (_, i) => `m${i}`);
    const run = runFlash({ ...webgpu, FLASH_DEADLINE_S: "0.5" }, { consoleLines, chromeLines: ["c1", "c2"] });
    const printedTail = Array.from({ length: 300 }, (_, i) => `[page log] m${1100 + i}`);
    expect({
      status: run.status,
      afterHead: run.lines.slice(run.lines.indexOf("[page log] m999") + 1),
      files: run.files,
    }).toEqual({
      status: 1,
      afterHead: ["... lines cut: 100", ...printedTail, `--- end of ${run.chromeLog}`, "c1", "c2"],
      files: ["chrome_stderr.log", "report.json"],
    });
    expect(run.stderr).toContain("still running after 0.5 s");
    expect(run.stderr).not.toContain("fake browser closed");
  });

  it("whose browser never launches still stops at FLASH_DEADLINE_S and prints Chrome's log", () => {
    const run = runFlash({ ...webgpu, FLASH_DEADLINE_S: "0.5" }, { launchHangs: true, chromeLines: ["c1"] });
    expect({ status: run.status, afterLoad: run.lines.slice(1), files: run.files }).toEqual({
      status: 1,
      afterLoad: [run.lines[1], `--- end of ${run.chromeLog}`, "c1"],
      files: ["chrome_stderr.log", "report.json"],
    });
    expect(run.lines[1]).toMatch(/^fake launch /);
    expect(run.stderr).toContain("still running after 0.5 s");
  });

  it("whose launch fails before the deadline reports that and the deadline stays quiet while it finishes", () => {
    const run = runFlash({ ...webgpu, FLASH_DEADLINE_S: "0.2" }, { launchThrows: true, chromeLines: ["c1"] });
    expect({ status: run.status, afterLaunch: run.lines.slice(2) }).toEqual({
      status: 1,
      afterLaunch: [`--- end of ${run.chromeLog}`, "c1"],
    });
    expect(run.stderr).toContain("fake launch failed");
    expect(run.stderr).not.toContain("still running");
  });

  it("that fails before its deadline prints the held tail once and the deadline stays quiet", () => {
    const run = runFlash(
      { ...webgpu, FLASH_DEADLINE_S: "5" },
      { consoleLines: ["m0"], chromeLines: ["c1"], gotoThrowsAfterMs: 0 },
    );
    expect(run.lines.slice(2)).toEqual(["[page log] m0", `--- end of ${run.chromeLog}`, "c1"]);
    expect(run.stderr).toContain("fake stop");
    expect(run.stderr).not.toContain("still running");
  });

  it("never shows the engine token, in stdout or in the log it leaves", () => {
    const run = runFlash(webgpu, {
      consoleLines: ["WebSocket ws://x/?token=s3cret failed"],
      chromeLines: ["ERROR ws://x/?token=s3cret"],
      gotoThrowsAfterMs: 0,
    });
    expect(run.lines.slice(2)).toEqual([
      "[page log] WebSocket ws://x/?token=<token> failed",
      `--- end of ${run.chromeLog}`,
      "ERROR ws://x/?token=<token>",
    ]);
    expect(run.chromeLogText).toBe("ERROR ws://x/?token=<token>\n");
  });
});
