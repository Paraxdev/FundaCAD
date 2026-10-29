// A17 (KB-18, SCAN-13, VIS-13): every control has a hit area of at least --hit-min, 24 px, and 32 px with
// Larger click targets on. The area is a pseudo element of the host, so the look and the layout stay put.

import * as sass from "sass";
import { describe, expect, it } from "vitest";
import hitScss from "../../src/styles/_hit.scss?raw";
import { compileMainScss } from "./compileStyles";
import { missingHitAreas, valueOf } from "./hitGuard";

const css = compileMainScss();

const withMixin = (scss: string) => sass.compileString(`${hitScss}\n${scss}`).css;

describe("hit area token", () => {
  it("is 24px by default and 32px with Larger click targets", () => {
    expect(valueOf(css, ":root", "--hit-min")).toBe("24px");
    expect(valueOf(css, ':root[data-targets="large"]', "--hit-min")).toBe("32px");
  });
});

describe("hit area mixin", () => {
  const out = withMixin(".x { @include area; }\n.y { position: absolute; @include area(after, null); }");

  it("positions the host and centres a pseudo of at least --hit-min on it", () => {
    expect(valueOf(out, ".x", "position")).toBe("relative");
    expect(valueOf(out, ".x::before", "content")).toBe('""');
    expect(valueOf(out, ".x::before", "position")).toBe("absolute");
    expect(valueOf(out, ".x::before", "inset")).toBe("min(0px, (100% - var(--hit-min)) / 2)");
  });

  it("leaves an already positioned host alone and can grow ::after instead", () => {
    expect(valueOf(out, ".y", "position")).toBe("absolute");
    expect(valueOf(out, ".y::after", "inset")).toBe("min(0px, (100% - var(--hit-min)) / 2)");
    expect(missingHitAreas(out, [".x", ".y"])).toEqual([]);
  });
});

describe("hit area guard", () => {
  it("names each host whose pseudo is missing or not inset by --hit-min", () => {
    const sample = withMixin(
      '.a, .d > .e { @include area; }\n.b::before { content: ""; position: absolute; inset: -4px; }',
    );
    expect(missingHitAreas(sample, [".a", ".b", ".c", ".d > .e"])).toEqual([".b", ".c"]);
  });
});
