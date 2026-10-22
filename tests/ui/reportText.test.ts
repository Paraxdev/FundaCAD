import { afterEach, describe, expect, it } from "vitest";

import bugRaw from "../../.github/ISSUE_TEMPLATE/bug.yml?raw";
import redactCases from "../fixtures/redact_cases.json";
import {
  buildReport,
  cutCodePoints,
  ideaUrl,
  issueTitle,
  issueUrl,
  recentErrors,
  redactUserPaths,
  REPORT_CAP,
  URL_CAP,
  type ReportInput,
} from "../../src/ui/reportText";
import { clearLog, log, logEntries, type LogEntry } from "../../src/ui/logStore";
import { featureFailureReport } from "../../src/ui/errorReport";

const AT = Date.UTC(2026, 9, 22, 11, 42, 7);
const ISO = "2026-10-22T11:42:07.000Z";

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    version: "1.0.412",
    channel: "beta",
    system: "linux x86_64 · Ubuntu 24.04.1 LTS · AppImage",
    webview: "WebKitGTK 2.46.3",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    connected: true,
    safeMode: null,
    plugins: [],
    description: "The fillet on the bracket failed\nafter I changed the radius to 7.3",
    events: ["[view] 2 bodies", "11:40:02 [error] Fillet1 failed: radius too large"],
    errors: [],
    pipeline: ["[pipeline] no faults detected this session"],
    log: null,
    document: null,
    ...over,
  };
}

function entry(id: number, level: LogEntry["level"], message: string, detail?: string): LogEntry {
  return { id, level, at: AT + id * 1000, message, source: `f${id}`, ...(detail !== undefined ? { detail } : {}) };
}

describe("the report text", () => {
  it("holds every section in order when all are present", () => {
    const r = buildReport(
      input({
        safeMode: "on, the last 3 starts did not finish",
        plugins: ["printing-toolkit", "screws"],
        errors: [`${ISO} ERROR [f7]: Fillet1 failed: radius too large\nkernel said no`],
        log: "[log] FundaCAD started\n[engine] ready\n\n",
        document: '{"features":[{"id":"f7"}]}',
      }),
    );
    expect(r).toEqual({
      text: [
        "FundaCAD problem report (format 2)",
        "version: 1.0.412 · channel beta",
        "system: linux x86_64 · Ubuntu 24.04.1 LTS · AppImage",
        "webview: WebKitGTK 2.46.3",
        "browser: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        "geometry engine connected: true",
        "safe mode: on, the last 3 starts did not finish",
        "plugins: printing-toolkit, screws",
        "",
        "The fillet on the bracket failed",
        "after I changed the radius to 7.3",
        "",
        "recent events:",
        "  [view] 2 bodies",
        "  11:40:02 [error] Fillet1 failed: radius too large",
        "",
        "recent errors:",
        `${ISO} ERROR [f7]: Fillet1 failed: radius too large`,
        "kernel said no",
        "",
        "render pipeline:",
        "  [pipeline] no faults detected this session",
        "",
        "app log (the end, user names hidden):",
        "[log] FundaCAD started",
        "[engine] ready",
        "",
        "document:",
        '{"features":[{"id":"f7"}]}',
      ].join("\n"),
      logCut: false,
      documentLeftOut: null,
    });
  });

  it("leaves out the sections it has nothing for, and says safe mode is off and no plugin runs", () => {
    const r = buildReport(input({ webview: null, connected: false, log: "  \n" }));
    expect(r.text).toEqual(
      [
        "FundaCAD problem report (format 2)",
        "version: 1.0.412 · channel beta",
        "system: linux x86_64 · Ubuntu 24.04.1 LTS · AppImage",
        `browser: ${input().userAgent}`,
        "geometry engine connected: false",
        "safe mode: off",
        "plugins: none",
        "",
        "The fillet on the bracket failed",
        "after I changed the radius to 7.3",
        "",
        "recent events:",
        "  [view] 2 bodies",
        "  11:40:02 [error] Fillet1 failed: radius too large",
        "",
        "render pipeline:",
        "  [pipeline] no faults detected this session",
      ].join("\n"),
    );
  });

  it("names one plugin alone", () => {
    expect(buildReport(input({ plugins: ["screws"] })).text.split("\n")[7]).toBe("plugins: screws");
  });
});

describe("the report cap", () => {
  const LOG = ["first line of the log", "second line", "third line", "the last line, which must survive"].join("\n");
  const DOC = `{"features":[${'{"id":"f1"},'.repeat(40)}{"id":"f41"}]}`;
  const full = buildReport(input({ log: LOG, document: DOC })).text;

  it("keeps a report of exactly the cap whole, and one over cuts the log from its start", () => {
    expect(buildReport(input({ log: LOG, document: DOC }), full.length)).toEqual({
      text: full,
      logCut: false,
      documentLeftOut: null,
    });
    const over = buildReport(input({ log: LOG, document: DOC }), full.length - 1);
    expect(over).toEqual({
      text: full
        .replace("app log (the end, user names hidden):", "app log (the end, user names hidden, cut to fit):")
        .replace("first line of the log\n", ""),
      logCut: true,
      documentLeftOut: null,
    });
    expect(over.text.length).toBeLessThanOrEqual(full.length - 1);
  });

  it("holds the real cap at exactly 55,000 characters", () => {
    const pad = (n: number) => input({ log: "x".repeat(n) + "\nlast" });
    const base = buildReport(pad(0), Infinity).text.length;
    const exact = buildReport(pad(REPORT_CAP - base));
    expect([exact.text.length, exact.logCut]).toEqual([REPORT_CAP, false]);
    const one = buildReport(pad(REPORT_CAP - base + 1));
    expect([one.logCut, one.text.endsWith("cut to fit):\nlast"), one.documentLeftOut]).toEqual([true, true, null]);
  });

  it("keeps the last line even when only it fits, and leaves the document out when not even that does", () => {
    const lastOnly = buildReport(input({ log: LOG, document: DOC }), full.length - 30);
    expect(lastOnly.text).toContain("cut to fit):\nthe last line, which must survive\n\ndocument:");
    expect(lastOnly.documentLeftOut).toBeNull();

    const withoutDoc = buildReport(input({ log: LOG, document: DOC }), full.length - DOC.length);
    expect(withoutDoc).toEqual({
      text: buildReport(input({ log: LOG })).text,
      logCut: false,
      documentLeftOut: DOC.length,
    });
  });

  it("keeps a document that fits and leaves out one that does not, with no log at all", () => {
    const withDoc = buildReport(input({ document: DOC })).text;
    expect(buildReport(input({ document: DOC }), withDoc.length).documentLeftOut).toBeNull();
    expect(buildReport(input({ document: DOC }), withDoc.length - 1)).toEqual({
      text: buildReport(input()).text,
      logCut: false,
      documentLeftOut: DOC.length,
    });
  });
});

describe("the issue URL", () => {
  const fields = { description: "", version: "1.0.412", system: "windows x86_64" };
  const what = (url: string) => new URL(url).searchParams.get("what");

  it("carries a description that fits whole, line breaks and all", () => {
    const description = "The bracket vanished\n\nafter undo, twice: 50% of the time & always on XZ";
    const url = issueUrl({ ...fields, description });
    const q = new URL(url).searchParams;
    expect([...q.entries()]).toEqual([
      ["template", "bug.yml"],
      ["title", "Problem: The bracket vanished"],
      ["version", "1.0.412"],
      ["os", "windows x86_64"],
      ["what", description],
    ]);
  });

  it("is whole at the cap and cut with the marker one code point over", () => {
    // A fixed first line keeps the title, which is part of the URL, the same length.
    const first = "Lid will not close\n";
    const head = issueUrl({ ...fields, description: first }).length;
    const fits = first + "a".repeat(URL_CAP - head);
    expect(issueUrl({ ...fields, description: fits }).length).toBe(URL_CAP);
    expect(what(issueUrl({ ...fields, description: fits }))).toBe(fits);
    const over = issueUrl({ ...fields, description: fits + "b" });
    expect(over.length).toBeLessThanOrEqual(URL_CAP);
    const marker = " … (cut, the full text is in the pasted report)";
    expect(what(over)).toBe(first + "a".repeat(URL_CAP - head - encodeURIComponent(marker).length) + marker);
  });

  it("never cuts inside an emoji, an astral character or an escape", () => {
    for (const unit of ["😀", "𝔸", "é", "%", " ", "\n", "ß😀"]) {
      for (let pad = 0; pad < 4; pad++) {
        const description = "x".repeat(pad) + unit.repeat(900);
        const url = issueUrl({ ...fields, description });
        expect(url.length).toBeLessThanOrEqual(URL_CAP);
        const got = what(url)!;
        expect(got.endsWith(" … (cut, the full text is in the pasted report)")).toBe(true);
        expect(description.startsWith(got.replace(" … (cut, the full text is in the pasted report)", ""))).toBe(true);
      }
    }
  });

  it("does not throw on a lone surrogate", () => {
    expect(what(issueUrl({ ...fields, description: "half \uD83D of a face" }))).toBe("half \uFFFD of a face");
  });

  it.each([
    ["a low half alone", "lid \uDE00 cracked", "lid \uFFFD cracked"],
    ["a high half at the end", "lid cracked \uD83D", "lid cracked \uFFFD"],
    ["two high halves before a low one", "\uD83D\uD83D\uDE00 lid", "\uFFFD\uD83D\uDE00 lid"],
    ["two whole pairs", "lid \uD83D\uDE00\uD83D\uDD27 ok", "lid \uD83D\uDE00\uD83D\uDD27 ok"],
  ])("replaces only the halves that have no partner: %s", (_case, description, expected) => {
    expect(what(issueUrl({ ...fields, description }))).toBe(expected);
  });

  it("titles the issue with the first line that has text, cut to 70 code points", () => {
    expect(issueTitle("\n  \nFillet fails on the lid\nmore")).toBe("Problem: Fillet fails on the lid");
    expect(issueTitle("😀".repeat(80))).toBe(`Problem: ${"😀".repeat(70)}`);
    expect(issueTitle("y".repeat(70))).toBe(`Problem: ${"y".repeat(70)}`);
    expect(issueTitle("")).toBe("Problem: ");
  });

  it("points the idea form and the problem form inside the opener scope", () => {
    expect(ideaUrl()).toBe("https://github.com/Paraxdev/fundacad/issues/new?template=idea.yml");
    expect(issueUrl({ ...fields, description: "x" }).startsWith("https://github.com/Paraxdev/fundacad/")).toBe(true);
  });

  it("cuts by code points", () => {
    expect([cutCodePoints("a😀b", 2), cutCodePoints("abc", 3), cutCodePoints("abc", 0)]).toEqual(["a😀", "abc", ""]);
  });
});

describe("the whole issue body GitHub receives", () => {
  it("stays under 58,000 characters, leaving 7,500 for the steps", () => {
    const labels = [...bugRaw.matchAll(/^ {6}label: (.+)$/gm)].map((m) => m[1]!.trim());
    const report = buildReport(input({ log: "z".repeat(60_000) + "\nend" })).text;
    expect(report.length).toBeLessThanOrEqual(REPORT_CAP);
    const url = issueUrl({ description: "w".repeat(5_000), version: "1.0.412", system: "windows x86_64" });
    const q = new URL(url).searchParams;
    const values = [q.get("what"), "", q.get("version"), q.get("os"), "```text\n" + report + "\n```"];
    const body = labels.map((l, i) => `### ${l}\n\n${values[i]}`).join("\n\n");
    expect(labels.length).toBe(5);
    expect(body.length).toBeLessThanOrEqual(58_000);
  });
});

describe("the recent errors", () => {
  afterEach(() => clearLog());

  it("carry a failed fillet's feature, kernel message and parameters as the build logs it", () => {
    const detail = featureFailureReport({
      label: "Fillet1",
      message: "radius too large",
      feature: { id: "f7", type: "fillet", radius: 7.3 },
      detail: {
        index: 3,
        type: "fillet",
        ms: 4.5,
        kernel: [{ op: "BRepFilletAPI_MakeFillet", ms: 1, args: "radii=[7.3]", error: "IsDone() is false" }],
        bodies: [],
        bodyCount: 1,
        params: { r: 7.3 },
        occt: "7.9.1",
      } as never,
    });
    log("error", "Fillet1 failed: radius too large", { source: "f7", detail });
    const [one, ...rest] = recentErrors(logEntries());
    expect(rest).toEqual([]);
    expect(one!.split("\n")[0]).toMatch(/ ERROR \[f7\]: Fillet1 failed: radius too large$/);
    for (const fact of ["`f7`", "IsDone() is false", "radii=[7.3]", "r = 7.3"]) expect(one).toContain(fact);
  });

  it("keep the last three errors, newest last, and never warnings or info", () => {
    const entries = [
      entry(1, "error", "one"),
      entry(2, "warning", "a warning"),
      entry(3, "error", "two"),
      entry(4, "error", "three"),
      entry(5, "info", "an info"),
      entry(6, "error", "four"),
      entry(7, "error", "five"),
    ];
    expect(recentErrors(entries).map((e) => e.replace(/^\S+ /, ""))).toEqual([
      "ERROR [f4]: three",
      "ERROR [f6]: four",
      "ERROR [f7]: five",
    ]);
    expect(recentErrors([entry(1, "warning", "w"), entry(2, "info", "i")])).toEqual([]);
    expect(recentErrors([])).toEqual([]);
  });

  it("cut a detail over 4,000 characters with a marker and keep one at 4,000 whole", () => {
    const at = new Date(AT + 9000).toISOString();
    expect(recentErrors([entry(9, "error", "m", "d".repeat(4000))])).toEqual([
      `${at} ERROR [f9]: m\n${"d".repeat(4000)}`,
    ]);
    expect(recentErrors([entry(9, "error", "m", "d".repeat(4001))])).toEqual([
      `${at} ERROR [f9]: m\n${"d".repeat(4000)}\n… (cut at 4,000 characters)`,
    ]);
  });

  it("hide user names in the message and the detail", () => {
    const at = new Date(AT + 2000).toISOString();
    expect(recentErrors([entry(2, "error", "open /home/test/a.step", "at C:\\Users\\Ines Ruiz\\x.funda")])).toEqual([
      `${at} ERROR [f2]: open /home/[REDACTED]/a.step\nat C:\\Users\\[REDACTED]\\x.funda`,
    ]);
  });
});

describe("hiding user names", () => {
  it("matches every shared case the Rust log follows", () => {
    expect(redactCases.length).toBeGreaterThan(10);
    for (const [text, want] of redactCases as [string, string][]) expect(redactUserPaths(text), text).toBe(want);
  });
});
