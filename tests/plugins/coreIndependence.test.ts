// The core does not know these three capabilities exist.
//
// That sentence is the whole of what "not part of the core" means here, and it
// is exactly the kind of claim that decays: one convenient `import` restores
// the coupling, nothing breaks, no test fails, and six months later the printer
// client is back in the bundle every machine parses at startup while the
// Preferences switch that says it is off goes on saying it.
//
// So the rule is checked rather than remembered. Each capability owns a set of
// files. A file outside that set may not STATICALLY import a file inside it.
// Dynamic `import()` is fine and is the point: that is how a capability is
// loaded when it is turned on and left on disk when it is not.
//
// Two things this deliberately does not do. It does not check the other
// direction: a capability may import as much of the core as it likes, which is
// what makes it a plugin rather than a fork. And it does not police
// `import type`, which is erased before the bundler ever sees it and costs
// nothing at runtime.

import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The files that ARE the capability. A capability is allowed to import its own
 *  parts however it likes. */
const CAPABILITIES: Record<string, (path: string) => boolean> = {
  "the printer connection": (p) =>
    p.includes("/src/print/") ||
    p.endsWith("/plugins/builtin/printing.ts") ||
    p.endsWith("/overlays/CameraPanel.vue") ||
    p.endsWith("/overlays/PrintStatusPill.vue") ||
    p.endsWith("/overlays/FilamentMappingDialog.vue"),
  "the 3D mouse": (p) =>
    p.endsWith("/input/spacemouse.ts") ||
    p.endsWith("/plugins/builtin/spacemouse.ts") ||
    p.endsWith("/overlays/SpaceMouseModal.vue"),
};

/** Static import specifiers in a file, skipping `import type` (erased) and
 *  `import(...)` (the mechanism this whole design runs on).
 *
 *  A regex rather than a parser: the shapes in this repository are a plain
 *  `import ... from "..."` at the top of a module, and a parser here would be a
 *  second thing to be wrong. What it must never do is match a dynamic import,
 *  hence the `from` in the pattern. */
function staticImports(src: string): string[] {
  const out: string[] = [];
  const re = /(^|\n)\s*import\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    const clause = m[2] ?? "";
    const spec = m[3] ?? "";
    // `import { type A, type B } from` is also erased, but only when every
    // named binding is a type. Anything else counts.
    const named = clause.match(/\{([^}]*)\}/);
    if (named && !clause.trim().startsWith("{")) {
      // a default plus a brace list: the default is a value
    } else if (named) {
      const parts = named[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0 && parts.every((s) => s.startsWith("type "))) continue;
    }
    out.push(spec);
  }
  return out;
}

/** Resolve a relative specifier against the importing file, as a repo path. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = from.slice(0, from.lastIndexOf("/"));
  const parts = (dir + "/" + spec).split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return "/" + stack.join("/");
}

/** Endings that make a resolved path match a capability file. The specifier
 *  usually omits `.ts`, so both spellings are tried. */
const candidates = (path: string) => [path, `${path}.ts`, `${path}/index.ts`];

describe("the core does not depend on the capabilities it can turn off", () => {
  it("has files to check at all", () => {
    // The control for every case below. import.meta.glob resolving to nothing
    // would make all of them pass while checking not one file.
    expect(Object.keys(sources).length).toBeGreaterThan(200);
  });

  for (const [name, owns] of Object.entries(CAPABILITIES)) {
    it(`is not statically imported outside ${name}`, () => {
      const offenders: string[] = [];
      for (const [file, src] of Object.entries(sources)) {
        if (owns(file)) continue;
        for (const spec of staticImports(src)) {
          const target = resolve(file, spec);
          if (!target) continue;
          if (candidates(target).some(owns)) {
            offenders.push(`${file} imports ${spec}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("would notice if the core imported one again", () => {
    // The control. The rule above passes on an empty list, and an empty list is
    // also what a broken matcher produces, so one known-bad case is checked
    // against the same machinery: the capability's own entry module imports the
    // capability, and would be reported if it were not excused for owning it.
    const entry = Object.keys(sources).find((p) => p.endsWith("/plugins/builtin/spacemouse.ts"))!;
    const target = resolve(entry, "../../input/spacemouse");
    expect(target).not.toBeNull();
    expect(candidates(target!).some(CAPABILITIES["the 3D mouse"]!)).toBe(true);
    expect(staticImports(sources[entry]!)).toContain("../../input/spacemouse");
  });
});
