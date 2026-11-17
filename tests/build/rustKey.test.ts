// A push whose Rust inputs match a green rust-geom run reuses that run's engine instead of waiting
// hours for the self hosted runner. The skip is only safe while the key covers every file the Rust
// jobs read, and while a skipped job still hands the e2e jobs an engine.

import { describe, expect, it } from "vitest";

import buildWorkflow from "../../.github/workflows/build.yml?raw";

const rustSources = import.meta.glob(["../../crates/**/*.rs", "../../src-tauri/**/*.rs", "!**/target/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function job(name: string): string {
  const lines = buildWorkflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${name}:`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function steps(text: string): string[] {
  return text.split(/\n(?= {6}- )/).slice(1);
}

const keyJob = job("rust-key");
const geom = job("rust-geom");

// The grep pattern in bash's $'...' quoting, turned back into what grep sees.
function frontendPattern(): RegExp {
  const quoted = /grep -v -E \$'((?:[^'\\]|\\.)*)'/.exec(keyJob)?.[1] ?? "";
  return new RegExp(quoted.replace(/\\t/g, "\t").replace(/\\\\/g, "\\"));
}

describe("skipping rust-geom when no Rust input changed", () => {
  it("leaves out frontend files and keeps Rust ones", () => {
    const frontend = frontendPattern();
    const out = (path: string) => frontend.test(`100644 blob 0\t${path}`);
    for (const path of [
      "src/ui/App.vue",
      "src/i18n/de.json",
      "docs/ENGINE.md",
      "e2e/x.spec.ts",
      "scripts/ui-strings-allow.json",
    ]) {
      expect(out(path), path).toBe(true);
    }
    for (const path of [
      "crates/fundacad-geom/src/lib.rs",
      "Cargo.lock",
      "tests/golden/a.golden.json",
      "plugins/FundaCAD.Gamepad/manifest.json",
      "src-tauri/tauri.conf.json",
    ]) {
      expect(out(path), path).toBe(false);
    }
  });

  it("keys every frontend file a Rust source names", () => {
    const frontend = frontendPattern();
    const read = (/read='([^']*)'/.exec(keyJob)?.[1] ?? "").split(" ").filter(Boolean);
    expect(read.length).toBeGreaterThan(0);
    expect(Object.keys(rustSources).length).toBeGreaterThan(100);
    const missing = Object.entries(rustSources).flatMap(([file, text]) =>
      [...text.matchAll(/"((?:\.\.\/)*)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)"/g)]
        .map((m) => m[2] ?? "")
        .filter((path) => frontend.test(`\t${path}`))
        .filter((path) => !read.some((r) => path === r || path.startsWith(`${r}/`)))
        .map((path) => `${file}: ${path}`),
    );
    expect(missing).toEqual([]);
  });

  it("keys the Rust jobs' own text, the toolchain week, and builds everything on a manual run", () => {
    expect(keyJob).toContain(
      "awk '/^  [a-z][a-z0-9-]*:\\r?$/ { on = $1 ~ /^rust-(key|geom):/ } on' .github/workflows/build.yml",
    );
    expect(keyJob).toContain("$(date -u +%G-W%V)");
    expect(keyJob).toMatch(/lookup-only: true/);
    expect(keyJob).toContain("if: github.event_name != 'workflow_dispatch'");
  });

  it("runs a skipped rust-geom on GitHub's runner and still hands e2e an engine", () => {
    expect(geom).toMatch(/needs: rust-key\r?$/m);
    expect(geom).toContain("runs-on: ${{ needs.rust-key.outputs.hit == 'true' && 'ubuntu-22.04' ||");
    expect(geom).toContain("SELF_HOSTED: ${{ needs.rust-key.outputs.hit != 'true' &&");
    expect(geom).toContain(
      "path: ${{ env.GREEN == 'true' && 'rust-geom-green/fundacad-engine' || 'target/debug/fundacad-engine' }}",
    );
    for (const name of ["e2e", "e2e-heavy", "e2e-a11y"]) expect(job(name)).toMatch(/needs: rust-geom\r?$/m);
  });

  it("skips every build and test step on a hit, and saves a green run only after the last check", () => {
    const all = steps(geom);
    const guarded = all.filter((s) => s.includes("env.GREEN != 'true'")).length;
    const free = all.filter((s) => !s.includes("env.GREEN != 'true'")).map((s) => s.split("\n")[0]);
    expect(free).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("Fetch the engine of the green run"),
      expect.stringContaining("Upload the engine for the e2e job"),
      expect.stringContaining("Prune the warm target dir"),
    ]);
    expect(guarded).toBeGreaterThan(10);
    const names = all.map((s) => s.split("\n")[0] ?? "");
    const save = names.findIndex((n) => n.includes("Save the green run for the same inputs"));
    const checks = names.flatMap((n, i) => (/Golden parity checks|tests/.test(n) ? [i] : []));
    const lastCheck = Math.max(...checks);
    expect(checks.length).toBeGreaterThan(3);
    expect(save).toBeGreaterThan(lastCheck);
    expect(all[save]).toContain("key: ${{ needs.rust-key.outputs.key }}");
  });
});
