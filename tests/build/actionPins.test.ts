// The workflows run other people's code with this repository's token and the
// updater signing key in reach, so every action is fetched by commit, never by
// a tag or branch that its owner can move.

import { describe, expect, it } from "vitest";

const files = {
  ...import.meta.glob("../../.github/workflows/*.yml", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../.github/actions/*/action.yml", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

const USES = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/;
const indentOf = (line: string) => line.length - line.trimStart().length;

/** The lines of the step that holds line i, from its dash to the next line indented no further. */
function stepAt(lines: string[], i: number): string[] {
  let start = i;
  while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;
  const indent = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > indent)) end++;
  return lines.slice(start, end);
}

function usesLines() {
  return Object.entries(files).flatMap(([path, text]) => {
    const lines = text.split(/\r?\n/);
    return lines.flatMap((line, i) => {
      const m = USES.exec(line);
      return m ? [{ where: `${path}:${i + 1}`, ref: m[1], rest: m[2], step: stepAt(lines, i) }] : [];
    });
  });
}

describe("third party code in CI", () => {
  it("reads every workflow and composite action", () => {
    const paths = Object.keys(files);
    expect(paths.filter((p) => p.includes("/workflows/")).length).toBeGreaterThan(0);
    expect(paths.filter((p) => p.endsWith("/action.yml")).length).toBeGreaterThan(0);
    expect(usesLines().filter((u) => !u.ref.startsWith("./")).length).toBeGreaterThan(0);
  });

  it("runs every action at a pinned commit with its tag in a comment", () => {
    const loose = usesLines()
      .filter((u) => !u.ref.startsWith("./"))
      .filter((u) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(u.ref) || !/^\s+#\s+\S+\s*$/.test(u.rest))
      .map((u) => `${u.where} ${u.ref}${u.rest}`);
    expect(loose).toEqual([]);
  });

  it("names the stable toolchain on every rust-toolchain step", () => {
    const steps = usesLines().filter((u) => u.ref.startsWith("dtolnay/rust-toolchain@"));
    expect(steps.length).toBeGreaterThan(0);
    const unnamed = steps.filter((u) => !u.step.some((l) => /^\s+toolchain:\s*stable\s*$/.test(l))).map((u) => u.where);
    expect(unnamed).toEqual([]);
  });
});
