// When the hosted runners' Azure Ubuntu mirror stalls, every Linux job used to time out installing
// packages. ci-apt-update.sh moves apt to archive.ubuntu.com, which only helps an install that runs
// after it in the same job.

import { describe, expect, it } from "vitest";

import linuxDeps from "../../.github/actions/linux-deps/action.yml?raw";
import buildWorkflow from "../../.github/workflows/build.yml?raw";
import flatpakSource from "../../.github/workflows/flatpak-source.yml?raw";
import script from "../../scripts/ci-apt-update.sh?raw";

function jobs(workflow: string): Map<string, string> {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf("jobs:");
  const out = new Map<string, string>();
  let name = "";
  for (const line of lines.slice(start + 1)) {
    const head = /^ {2}([a-z][a-z0-9-]*):$/.exec(line);
    if (head) name = head[1] ?? "";
    else if (name) out.set(name, `${out.get(name) ?? ""}${line}\n`);
  }
  return out;
}

describe("apt on the Linux runners", () => {
  it("counts a half failed update as failed and retries a mirror only once", () => {
    expect(script).toContain('APT::Update::Error-Mode "any";');
    expect(script).toContain('Acquire::Retries "1";');
  });

  it("moves off the Azure mirror when it does not answer or an update fails, never on a self hosted runner", () => {
    expect(script).toMatch(/curl [^\n]*--max-time \d+[^\n]*azure\.archive\.ubuntu\.com/);
    expect(script).toMatch(/\|\| leave_azure /);
    const loop = script.slice(script.indexOf("for try in"));
    expect(loop).toMatch(/leave_azure "failed an update"/);
    expect(script).toMatch(/RUNNER_ENVIRONMENT:-\}" != self-hosted/);
    expect(script).toContain("s#http://$azure#http://archive.ubuntu.com#g");
  });

  it("runs before every install in a job on the hosted Linux runners", () => {
    expect(linuxDeps.indexOf("ci-apt-update.sh")).toBeGreaterThan(-1);
    expect(linuxDeps.indexOf("ci-apt-update.sh")).toBeLessThan(linuxDeps.indexOf("apt-get install"));
    const checked: string[] = [];
    for (const [file, workflow] of [
      ["build.yml", buildWorkflow],
      ["flatpak-source.yml", flatpakSource],
    ] as const) {
      for (const [name, text] of jobs(workflow)) {
        const install = text.search(/apt-get install/);
        if (install === -1 || /container:/.test(text)) continue;
        const update = Math.min(
          ...["uses: ./.github/actions/linux-deps", "ci-apt-update.sh"]
            .map((s) => text.indexOf(s))
            .filter((i) => i >= 0),
        );
        expect(update, `${file} ${name}`).toBeLessThan(install);
        checked.push(name);
      }
    }
    expect(checked).toEqual(
      expect.arrayContaining(["bundle", "build-flatpak", "e2e", "e2e-heavy", "e2e-a11y", "rust-geom"]),
    );
  });
});
