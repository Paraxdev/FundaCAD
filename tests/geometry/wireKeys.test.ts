// The window and the geometry engine agree on what a body's fields are CALLED.
//
// WHY THIS FILE EXISTS. Nothing here is clever; it is a grep in both directions
// across a process boundary, and it is here because the boundary had gone quiet
// on us. The sidecar sends one body as a flat JSON object, the window describes
// that object as `WireBodyFull`, and the only thing tying a field in one to a
// field in the other is that somebody spelled it the same way twice. TypeScript
// cannot check that: an optional field nobody sends is not a type error, it is
// `undefined`, which reads exactly like "this body has none of those".
//
// AND THAT IS WHAT HAPPENED. The per-face palette slots were `textureColorSlots`
// on both sides. When the surface texture became a plugin the sidecar's half was
// renamed `faceColorSlots`, because the slots stopped being a texture's and
// became any mesh pass's. The window's half was not renamed. So the reader went
// on asking for a key nothing had sent since, found `undefined`, and took the
// documented early exit for "this body has no inlays": every two-tone inlay in
// every document silently stopped being painted, with no error anywhere and a
// green suite, because the unit test for the painter built its input by hand and
// spelled the key the way the painter expected.
//
// A test that mocks the wire cannot fail this way. This one reads both real
// files.
import { describe, expect, it } from "vitest";

// Read as raw text through the bundler rather than off the filesystem, the same
// way tests/plugins/coreIndependence.test.ts reads the tree it polices: it needs
// no node typings in the test tsconfig, and it resolves relative to this file
// rather than to whatever the runner's working directory happens to be.
const raw = (pattern: Record<string, string>, endsWith: string): string => {
  const hit = Object.entries(pattern).find(([p]) => p.endsWith(endsWith));
  return hit ? hit[1] : "";
};

const server = raw(
  import.meta.glob("../../sidecar/*.py", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  "/sidecar/server.py",
);
const assembly = raw(
  import.meta.glob("../../src/geometry/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  "/geometry/assembly.ts",
);

/** The field names declared in one TS interface, ignoring comments.
 *
 *  Deliberately a regex over the interface body rather than a parse: the shape
 *  here is one plain `name?: type;` per line, and a parser would be a second
 *  thing that can be wrong about a file whose whole job is to be read literally. */
function declaredFields(src: string, iface: string): string[] {
  const start = src.indexOf(`export interface ${iface} {`);
  if (start < 0) return [];
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  const out: string[] = [];
  for (const raw of body.split("\n").slice(1)) {
    const line = raw.replace(/\/\/.*$/, "");
    if (/^\s*[*/]/.test(raw)) continue; // a comment line, including jsdoc
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
    if (m) out.push(m[1]!);
  }
  return out;
}

describe("the body on the wire is spelled the same on both sides", () => {
  const fields = declaredFields(assembly, "WireBodyFull");

  it("found the interface at all", () => {
    // The control for the rule below. An interface name that had been changed,
    // or a regex that matched nothing, would leave an empty list, and a rule
    // over an empty list passes while checking not one field.
    expect(fields.length).toBeGreaterThan(10);
    expect(fields).toContain("positions");
    expect(fields).toContain("faceColorSlots");
  });

  it("reads the two real files, not a copy of them", () => {
    // The second control. readFileSync on a path that has moved would throw, but
    // an empty or truncated read would not, and both rules would then be about
    // nothing.
    expect(server.length).toBeGreaterThan(10000);
    expect(assembly.length).toBeGreaterThan(5000);
  });

  it("has nothing the window reads that the engine never sends", () => {
    // THE RULE THAT WOULD HAVE FAILED, for the whole of the sitting it was
    // written for. Every field the window declares has to be written by name
    // somewhere in the engine that produces the object, because a wire key is a
    // string literal in both files and there is nowhere else for it to come
    // from. A field nothing sends is a reader that is always looking at
    // `undefined`, which is this bug.
    const orphans = fields.filter((f) => !server.includes(`"${f}"`));
    expect(orphans).toEqual([]);
  });

  it("would notice a field the engine stopped sending (control)", () => {
    // The rule above passes on an empty list, and an empty list is also what a
    // broken `includes` would produce. So the same machinery is run against a
    // name that is deliberately not on the wire: it has to be reported.
    const pretend = [...fields, "slotsTheEngineNeverSends"];
    const orphans = pretend.filter((f) => !server.includes(`"${f}"`));
    expect(orphans).toEqual(["slotsTheEngineNeverSends"]);
  });

  it("names the palette slots the way the engine writes them", () => {
    // The specific regression, pinned by name rather than left to the general
    // rule above, so that a failure says what broke instead of listing a field.
    expect(server).toContain('payload["faceColorSlots"]');
    expect(fields).toContain("faceColorSlots");
    // and the name it used to have is gone from the CODE on both sides, so a
    // half-finished revert cannot pass by leaving the old spelling in the
    // reader. Comments may still say it: a note recording where a key came from
    // is how the history stays legible, and both files carry one.
    const serverCode = server.replace(/#.*/g, "");
    expect(serverCode).not.toContain("textureColorSlots");
    expect(assembly).not.toMatch(/^\s*textureColorSlots\??\s*:/m);
  });
});
