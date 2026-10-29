// The workflows run other people's code with this repository's token and the
// updater signing key in reach, so every action is fetched by commit, never by
// a tag or branch that its owner can move.

import { describe, expect, it } from "vitest";
import { grants, pinFindings, refusedForms, usesSteps, yamlLines } from "../../scripts/actionPins.mjs";

const all = import.meta.glob("../../.github/**/*.{yml,yaml}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const CI_FILE = /\/\.github\/(?:workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/;
const files = Object.fromEntries(Object.entries(all).filter(([path]) => CI_FILE.test(path)));

describe("third party code in CI", () => {
  it("reads every workflow and composite action, and no other YAML under .github can run code", () => {
    const paths = Object.keys(files);
    expect(paths.filter((p) => p.includes("/workflows/")).length).toBeGreaterThan(0);
    expect(paths.filter((p) => p.includes("/actions/")).length).toBeGreaterThan(0);
    expect(usesSteps(files).filter((u) => !u.ref.startsWith("./")).length).toBeGreaterThan(0);
    const rest = Object.keys(all).filter(
      (p) => !CI_FILE.test(p) && !/\/\.github\/(?:dependabot|FUNDING)\.yml$|\/ISSUE_TEMPLATE\//.test(p),
    );
    expect(rest).toEqual([]);
  });

  it("is written only in YAML forms the scan reads", () => {
    expect(Object.entries(files).flatMap(([path, text]) => refusedForms(path, text))).toEqual([]);
  });

  // Whether a commit really is its tag needs the network: node scripts/verify-action-pins.mjs asks GitHub.
  it("runs every action at a pinned commit with its exact tag in a comment, the same everywhere", () => {
    expect(pinFindings(files)).toEqual([]);
  });

  it("names the stable toolchain on every rust-toolchain step", () => {
    const steps = usesSteps(files).filter((u) => u.ref.startsWith("dtolnay/rust-toolchain@"));
    expect(steps.length).toBeGreaterThan(0);
    const unnamed = steps.filter((u) => !u.step.some((l) => /^\s+toolchain:\s*stable\s*$/.test(l))).map((u) => u.where);
    expect(unnamed).toEqual([]);
  });

  // Dependabot's "/" covers .github/workflows only, so an action called from a composite action would never be bumped.
  it("calls outside actions only from workflows", () => {
    const composite = Object.fromEntries(Object.entries(files).filter(([path]) => path.includes("/actions/")));
    expect(
      usesSteps(composite)
        .filter((u) => !u.ref.startsWith("./"))
        .map((u) => u.where),
    ).toEqual([]);
  });
});

describe("the CI scan", () => {
  it("refuses every other spelling of uses and permissions, and anchors, aliases, tags and merge keys", () => {
    const odd = [
      '      - "uses": swatinem/rust-cache@v2',
      "      - {uses: dtolnay/rust-toolchain@stable}",
      "      - uses : tauri-apps/tauri-action@v0",
      "      - uses: 'actions/checkout@v4'",
      "      - uses:",
      "    'permissions':",
      "    permissions: {contents: write}",
      "    permissions: &grant",
      "    permissions: *grant",
      "    <<: *job",
      "    ? permissions",
      "    if: !cancelled()",
    ];
    expect(refusedForms("x.yml", odd.join("\n"))).toEqual(odd.map((l, i) => `x.yml:${i + 1} ${l.trim()}`));
  });

  it("reads the plain forms and skips the text of block scalars", () => {
    const text = [
      "    permissions:",
      "      contents: read",
      "    if: ${{ !cancelled() && github.ref != 'x' }}",
      "    steps:",
      `      - uses: actions/checkout@${"a".repeat(40)} # v4.4.0`,
      "      - run: | # build",
      '          echo "uses: {a} &b *c" # permissions: x',
      "          ls *.zip",
      "        shell: bash",
    ].join("\n");
    expect(refusedForms("x.yml", text)).toEqual([]);
    expect(yamlLines(text).map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 6, 9]);
  });

  it("reports a loose ref, a moving tag and a commit or tag that disagrees with another use", () => {
    const sha = (c: string) => c.repeat(40);
    const uses = [
      `actions/checkout@${sha("a")} # v4.4.0`,
      `actions/checkout@${sha("b")} # v4.4.0`,
      `actions/cache/restore@${sha("c")} # v4.3.0`,
      `actions/cache@${sha("c")} # v4.2.0`,
      `swatinem/rust-cache@${sha("d")} # v2`,
      `dtolnay/rust-toolchain@${sha("e")} # stable`,
      `tauri-apps/tauri-action@${sha("f")} # stable`,
      "tauri-apps/tauri-action@v0",
      `docker://alpine@sha256:${sha("0")}${sha("0").slice(0, 24)}`,
      "./.github/actions/linux-deps",
    ];
    const text = uses.map((u) => `      - uses: ${u}`).join("\n");
    expect(pinFindings({ "x.yml": text })).toEqual([
      "x.yml:8 is not pinned to a commit with its tag in a comment: tauri-apps/tauri-action@v0",
      `x.yml:9 is not pinned to a commit with its tag in a comment: ${uses[8]}`,
      "x.yml:5 names v2, not an exact release tag",
      "x.yml:7 names stable, not an exact release tag",
      `actions/cache@${sha("c")} is commented as v4.3.0 and v4.2.0`,
      `actions/checkout v4.4.0 is pinned to ${sha("a")} and ${sha("b")}`,
    ]);
  });

  it("files each grant under its own job at any indent, and none from a block scalar", () => {
    const text = [
      "on: push",
      "jobs:",
      "    build:",
      "        permissions:",
      "            contents: write # for the release",
      "        steps:",
      "            - run: |",
      "                permissions:",
      "                  contents: write",
      "    'deploy':",
      "        permissions: write-all",
      "permissions:",
      "  contents: read",
    ].join("\n");
    expect(grants({ "w/.github/workflows/x.yml": text })).toEqual([
      "x.yml build contents: write",
      "x.yml deploy write-all",
      "x.yml top contents: read",
    ]);
  });
});

const dependabot = all["../../.github/dependabot.yml"] as string | undefined;

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

describe("job permissions", () => {
  it("lets the bundle job read the repository and nothing more", () => {
    expect(grants(files).filter((g) => g.startsWith("build.yml bundle "))).toEqual(["build.yml bundle contents: read"]);
  });

  it("grants write access only to the release job, the manual hand-over and the Pages deploy", () => {
    expect(grants(files).filter((g) => !g.endsWith(": read"))).toEqual([
      "build.yml release contents: write",
      "manual.yml hand-over actions: write",
      "manual.yml deploy pages: write",
      "manual.yml deploy id-token: write",
    ]);
  });
});

describe("checkout credentials", () => {
  it("leaves no repository token in the git config of any checkout", () => {
    const steps = usesSteps(files).filter((u) => u.ref.startsWith("actions/checkout@"));
    expect(steps.length).toBeGreaterThan(0);
    const kept = steps
      .filter((u) => !u.step.some((l) => /^\s+persist-credentials:\s*false\s*$/.test(l)))
      .map((u) => u.where);
    expect(kept).toEqual([]);
  });
});
