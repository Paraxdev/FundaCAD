// The source check's generator venv installs only hash-pinned packages, so a new release of aiohttp,
// tomlkit or PyYAML cannot change the generated sources of a weekly run with nothing changed here.

import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/flatpak-source.yml?raw";

const requirementFiles = import.meta.glob("../../packaging/flatpak/source-check/generator-requirements.txt", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const requirements = Object.values(requirementFiles)[0] ?? "";

const HASH = /--hash=sha256:[0-9a-f]{64}(?=\s|$)/g;

function parseRequirements(text: string): [string, boolean, number][] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const spec = line.split(/\s+/)[0] ?? "";
      const name = /^[A-Za-z0-9._-]+/.exec(spec)?.[0] ?? spec;
      return [name, /^[A-Za-z0-9._-]+==[0-9][^\s=<>!~*,;]*$/.test(spec), line.match(HASH)?.length ?? 0];
    });
}

const lines = workflow.split(/\r?\n/).map((l) => l.trim());

describe("the generator venv of the source check", () => {
  it("is made with the Python its wheel hashes are for", () => {
    expect(lines.filter((l) => / -m venv /.test(l))).toEqual(['python3.12 -m venv "$RUNNER_TEMP/gen"']);
  });

  it("installs only from the hashed requirements file", () => {
    expect(lines.filter((l) => /\bpip3?"? install\b/.test(l))).toEqual([
      '"$RUNNER_TEMP/gen/bin/pip" install -q --require-hashes -r "$CHECK_DIR/generator-requirements.txt"',
    ]);
  });

  it("pins every package to one version with its hashes", () => {
    expect(parseRequirements(requirements).map(([name, pinned, hashes]) => [name, pinned, hashes > 0])).toEqual(
      [
        "aiohappyeyeballs",
        "aiohttp",
        "aiosignal",
        "attrs",
        "frozenlist",
        "idna",
        "multidict",
        "propcache",
        "pyyaml",
        "tomlkit",
        "typing-extensions",
        "yarl",
      ].map((name) => [name, true, true]),
    );
  });
});

describe("the source check job", () => {
  // The cold build fills about 7 GB and the runner has many times that free, so no step frees disk space first.
  it("runs these steps in order", () => {
    const steps = workflow.split(/\r?\n/).flatMap((l) => /^ {6}- (?:name|uses): (.*?)(?:@\S+.*)?$/.exec(l)?.[1] ?? []);
    expect(steps).toEqual([
      "actions/checkout",
      "Install flatpak-builder",
      "Generate the cargo and npm sources",
      "Restore the downloaded sources",
      "Install the SDK and download every source",
      "Save the downloaded sources",
      "Build from source with no network",
      "Check the libraries come from the runtime",
      "Start the Flatpak and build a box",
      "Upload the flatpak-builder log",
    ]);
  });
});

describe("parseRequirements", () => {
  it("reports a package with no exact version or no hash", () => {
    const hash = `--hash=sha256:${"a".repeat(64)}`;
    expect(
      parseRequirements(
        ["# header", "aiohttp", `PyYAML>=6.0 \\`, `    ${hash}`, `tomlkit==0.13.3 ${hash} ${hash}`, ""].join("\n"),
      ),
    ).toEqual([
      ["aiohttp", false, 0],
      ["PyYAML", false, 1],
      ["tomlkit", true, 2],
    ]);
  });
});
