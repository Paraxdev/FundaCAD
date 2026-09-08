// Every artifact upload has to say how long to keep it.
//
// This is here rather than in a CI script because the answer needs no build and
// no network: the workflow files are text, and a test runs them on every push
// and on every machine. What it defends is a failure that names something else
// entirely — 55 GB of ninety-day artifacts from an intra-run handoff, and a
// FinalizeArtifact 403 on one leg of the matrix that read as a Linux problem
// and stopped a release from publishing.
//
// scripts/artifactRetention.mjs has the scan; this has the fixtures that must
// be reported, because a scanner that quietly stopped finding anything would
// otherwise pass forever.

import { describe, expect, it } from "vitest";

import { retentionFindings, uploadSteps } from "../../scripts/artifactRetention.mjs";

/** Every workflow, by glob, so a NEW one is checked by existing rather than by
 *  somebody remembering to add it here. */
const workflows = import.meta.glob("../../.github/workflows/*.yml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const MAX_DAYS = 7;

describe("the workflows as they are", () => {
  it("keeps no artifact longer than a week", () => {
    for (const [path, text] of Object.entries(workflows)) {
      const findings = retentionFindings(uploadSteps(text), MAX_DAYS);
      expect(findings, `${path}\n  ${findings.join("\n  ")}`).toEqual([]);
    }
  });

  // The control on the reading itself. Without this, a glob that matched
  // nothing, or a scan that stopped recognising the step, passes the test above
  // by having nothing to report.
  it("and there is an upload in there to have checked", () => {
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
    const total = Object.values(workflows).flatMap((t) => uploadSteps(t)).length;
    expect(total).toBeGreaterThan(0);
  });
});

describe("uploadSteps", () => {
  const step = (body: string) => `jobs:\n  build:\n    steps:\n${body}`;

  it("reads the retention a step declares", () => {
    const found = uploadSteps(
      step(
        [
          "      - name: Upload artifacts",
          "        uses: actions/upload-artifact@v4",
          "        with:",
          "          name: fundacad-linux",
          "          retention-days: 1",
        ].join("\n"),
      ),
    );
    expect(found).toEqual([{ line: 5, name: "Upload artifacts", retention: 1 }]);
  });

  it("says so when a step declares none", () => {
    const found = uploadSteps(
      step(["      - uses: actions/upload-artifact@v4", "        with:", "          name: x"].join("\n")),
    );
    expect(found).toEqual([{ line: 4, name: "", retention: null }]);
  });

  // The one that matters most, and the one a sloppier scan gets wrong: a step
  // must not be able to borrow the NEXT step's retention-days by running past
  // its own end. That would be a false pass, which is worse than a miss.
  it("does not let one step answer for another", () => {
    const found = uploadSteps(
      step(
        [
          "      - name: First",
          "        uses: actions/upload-artifact@v4",
          "        with:",
          "          name: a",
          "      - name: Second",
          "        uses: actions/upload-artifact@v4",
          "        with:",
          "          name: b",
          "          retention-days: 1",
        ].join("\n"),
      ),
    );
    expect(found).toEqual([
      { line: 5, name: "First", retention: null },
      { line: 9, name: "Second", retention: 1 },
    ]);
  });

  it("and does not reach into the next job either", () => {
    const found = uploadSteps(
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - name: Upload artifacts",
        "        uses: actions/upload-artifact@v4",
        "  other:",
        "    steps:",
        "      - name: Something else",
        "        retention-days: 1",
      ].join("\n"),
    );
    expect(found).toEqual([{ line: 5, name: "Upload artifacts", retention: null }]);
  });

  it("ignores the download, which keeps nothing", () => {
    expect(uploadSteps(step("      - uses: actions/download-artifact@v4"))).toEqual([]);
  });
});

describe("retentionFindings", () => {
  it("passes a short retention", () => {
    expect(retentionFindings([{ line: 1, name: "Upload", retention: 1 }], MAX_DAYS)).toEqual([]);
  });

  // The two controls: both of the ways this went wrong have to be reported, or
  // the test above is green because nothing can ever be red.
  it("reports a step that says nothing, naming the default it would get", () => {
    const said = retentionFindings([{ line: 12, name: "Upload artifacts", retention: null }], MAX_DAYS);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("line 12");
    expect(said[0]).toContain("Upload artifacts");
    expect(said[0]).toContain("90");
  });

  it("reports a retention that is merely long", () => {
    const said = retentionFindings([{ line: 3, name: "", retention: 90 }], MAX_DAYS);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("90");
    expect(said[0]).toContain("7");
  });

  it("takes the cap as an argument rather than assuming one", () => {
    const steps = [{ line: 1, name: "", retention: 30 }];
    expect(retentionFindings(steps, 7)).toHaveLength(1);
    expect(retentionFindings(steps, 30)).toEqual([]);
  });
});
