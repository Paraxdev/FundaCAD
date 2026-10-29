// opencascade-sys rebuilds any kernel it cannot prove was built with its cache seeds, and it cannot
// build one at /app/occt, so the Flatpak's own OCCT module has to match the seeds and say so.

import { describe, expect, it } from "vitest";

import buildRs from "../../third_party/opencascade-rs/crates/opencascade-sys/build.rs?raw";
import manifest from "../../packaging/flatpak/source-check/fundacad-source-check.yml?raw";

function moduleBlock(name: string): string[] {
  const lines = manifest.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  - name: ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}- name: /.test(l));
  return lines.slice(start, end === -1 ? undefined : end).map((l) => l.trim());
}

const seeds = [...(/KERNEL_CACHE_SEEDS[^=]*=\s*\[([^\]]*)\]/.exec(buildRs)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
  (m) => m[1] ?? "",
);
const stateDir = /const STATE_DIR: &str = "([^"]+)"/.exec(buildRs)?.[1];
const occt = moduleBlock("occt");

describe("the Flatpak OCCT module", () => {
  it("is configured with every cache seed opencascade-sys checks", () => {
    expect(seeds.length).toBeGreaterThan(0);
    const opts = seeds.map((seed) => `- -D${seed.replace(/:[A-Z]+=/, "=")}`);
    expect(opts.filter((opt) => !occt.includes(opt))).toEqual([]);
  });

  it("leaves the checked reads stamp, so the kernel is used and not rebuilt", () => {
    expect(stateDir).toBe(".fundacad");
    expect(occt).toContain("post-install:");
    expect(occt).toContain(`- install -Dm644 /dev/null /app/occt/${stateDir}/checked-reads`);
  });
});
