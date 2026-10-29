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

const dependabot = Object.values(
  import.meta.glob("../../.github/dependabot.yml", { query: "?raw", import: "default", eager: true }),
)[0] as string | undefined;

describe("pinned actions stay current", () => {
  it("has Dependabot bump only the workflow actions, weekly, on dev", () => {
    expect(dependabot).toBeDefined();
    const text = dependabot ?? "";
    expect(text).toMatch(/^version:\s*2\s*$/m);
    expect([...text.matchAll(/package-ecosystem:\s*"?([\w-]+)"?/g)].map((m) => m[1])).toEqual(["github-actions"]);
    expect(text).toMatch(/^\s+directory:\s*"\/"\s*$/m);
    expect(text).toMatch(/^\s+interval:\s*"?weekly"?\s*$/m);
    expect(text).toMatch(/^\s+target-branch:\s*"?dev"?\s*$/m);
  });
});

/** Every permission a workflow grants, as `file job key: level`, with `top` for the workflow wide block. */
function grants(): string[] {
  return Object.entries(files)
    .filter(([path]) => path.includes("/workflows/"))
    .flatMap(([path, text]) => {
      const file = path.split("/").pop();
      const lines = text.split(/\r?\n/);
      let job = "top";
      let inJobs = false;
      const out: string[] = [];
      lines.forEach((line, i) => {
        if (/^jobs:\s*$/.test(line)) inJobs = true;
        const name = /^ {2}([\w-]+):\s*$/.exec(line);
        if (inJobs && name) job = name[1];
        const block = /^(\s*)permissions:\s*(\S*)/.exec(line);
        if (!block) return;
        if (block[2] && !block[2].startsWith("#")) out.push(`${file} ${job} ${block[2]}`);
        for (let j = i + 1; j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > block[1].length); j++) {
          const grant = lines[j].replace(/#.*/, "").trim();
          if (grant) out.push(`${file} ${job} ${grant.replace(/:\s*/, ": ")}`);
        }
      });
      return out;
    });
}

describe("job permissions", () => {
  it("lets the bundle job read the repository and nothing more", () => {
    expect(grants().filter((g) => g.startsWith("build.yml bundle "))).toEqual(["build.yml bundle contents: read"]);
  });

  it("grants write access only to the release job and the Pages deploy", () => {
    expect(grants().filter((g) => !g.endsWith(": read"))).toEqual([
      "build.yml release contents: write",
      "manual.yml top pages: write",
      "manual.yml top id-token: write",
    ]);
  });
});

describe("checkout credentials", () => {
  it("leaves no repository token in the git config of any checkout", () => {
    const steps = usesLines().filter((u) => u.ref.startsWith("actions/checkout@"));
    expect(steps.length).toBeGreaterThan(0);
    const kept = steps.filter((u) => !u.step.some((l) => /^\s+persist-credentials:\s*false\s*$/.test(l))).map((u) => u.where);
    expect(kept).toEqual([]);
  });
});
