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

describe("base components", () => {
  const HOSTS = [
    ".icon-btn.icon-btn-sm",
    ".icon-btn.icon-btn-md",
    ".icon-btn.icon-btn-lg",
    ".btn.btn-sm",
    ".ui-checkbox",
    ".ui-switch",
    ".ui-list-row",
    "button.chip",
    ".chip-body",
    ".ui-segment",
    ".ui-unit-chip.is-picker",
  ];

  it("each grow a hit area of at least --hit-min", () => {
    expect(missingHitAreas(css, HOSTS)).toEqual([]);
  });

  it("are the containing block of their hit area outside touch too", () => {
    expect(valueOf(css, ".icon-btn", "position")).toBe("relative");
    expect(valueOf(css, ".btn.btn-sm", "position")).toBe("relative");
    expect(valueOf(css, ".ui-checkbox", "position")).toBe("relative");
    expect(valueOf(css, ".ui-switch", "position")).toBe("relative");
    for (const host of [".ui-list-row", "button.chip", ".chip-body", ".ui-segment", ".ui-unit-chip.is-picker"]) {
      expect(valueOf(css, host, "position"), host).toBe("relative");
    }
  });

  // A range is hit only on itself and draws no pseudo, so the input grows and its margins hand the growth back.
  it("grow the slider's own range input around a centred track", () => {
    expect(valueOf(css, ".ui-slider-input", "height")).toBe("max(20px, var(--hit-min))");
    expect(valueOf(css, ".ui-slider-input", "margin")).toBe("calc((20px - max(20px, var(--hit-min))) / 2) 0");
  });

  it("grow the shell's own small controls too", () => {
    expect(missingHitAreas(css, [".sketch-glyph", ".rd-mini", ".xp-setup"])).toEqual([]);
    expect(valueOf(css, ".sketch-glyph", "position")).toBe("absolute");
    expect(valueOf(css, ".rd-mini", "position")).toBe("relative");
    expect(valueOf(css, ".xp-setup", "position")).toBe("relative");
  });

  // The legacy box is a span beside its input, so a pseudo on it would not toggle: the hidden input itself grows.
  it("grow the legacy checkbox's own input", () => {
    expect(valueOf(css, ".check input", "top")).toBe("min(0px, (100% - var(--hit-min)) / 2)");
    expect(valueOf(css, ".check input", "left")).toBe("min(0px, (100% - var(--hit-min)) / 2)");
    expect(valueOf(css, ".check input", "width")).toBe("max(100%, var(--hit-min))");
    expect(valueOf(css, ".check input", "height")).toBe("max(100%, var(--hit-min))");
  });
});
