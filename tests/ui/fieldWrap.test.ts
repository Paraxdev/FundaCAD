// The wrap rule of FieldRow: the rows that put a label beside a control wrap, and no row label is cut. jsdom has no
// layout, so this reads the stylesheets; tools/harness/tests/browser/test_field_wrap.py measures the real thing.

import { describe, expect, it } from "vitest";
import browserScss from "../../src/styles/_browser.scss?raw";
import comfortableScss from "../../src/styles/_comfortable.scss?raw";
import modalsScss from "../../src/styles/_modals.scss?raw";
import paletteScss from "../../src/styles/_palette.scss?raw";
import inspectorScss from "../../src/styles/_inspector.scss?raw";
import stressScss from "../../src/styles/_stress.scss?raw";
import fieldRowScss from "../../src/styles/ui/_field-row.scss?raw";

const ROWS = [".ui-field-row-inline", ".param-row", ".stress-field"];
const LABEL = /\.ui-field-label|\.param-row[^,{]*label|\.stress-field[^,{]*\.measure-k/;

type Rule = { selector: string; body: string };

function rules(css: string): Rule[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").split(";").pop()!.trim().replace(/\s+/g, " "),
    body: m[2] ?? "",
  }));
}

function wraps(body: string): boolean {
  return /flex-wrap:\s*wrap\b/.test(body) || /@include\s+(\w+\.)?wrap-row\b/.test(body);
}

// What breaks the rule: a row with no wrap, a mixin that does not wrap, a row label that clips or cannot break.
function wrapProblems(...sheets: string[]): string[] {
  const all = sheets.flatMap(rules);
  const found: string[] = [];
  for (const row of ROWS) {
    if (!all.some((r) => r.selector === row && wraps(r.body))) found.push(`${row} does not wrap`);
  }
  const mixin = all.find((r) => r.selector.startsWith("@mixin wrap-row"));
  if (!mixin || !/flex-wrap:\s*wrap\b/.test(mixin.body)) found.push("wrap-row does not set flex-wrap: wrap");
  for (const r of all) {
    if (!LABEL.test(r.selector)) continue;
    if (/text-overflow:\s*ellipsis/.test(r.body)) found.push(`${r.selector} clips with an ellipsis`);
    if (/white-space:\s*nowrap/.test(r.body)) found.push(`${r.selector} cannot break`);
  }
  return found;
}

const REAL = [fieldRowScss, inspectorScss, stressScss, browserScss, modalsScss, paletteScss, comfortableScss];

const GOOD = `
  @mixin wrap-row($gap: 1px) { display: flex; flex-wrap: wrap; }
  .ui-field-row-inline { @include wrap-row; }
  .param-row { @include row.wrap-row; }
  .stress-field { display: flex; flex-wrap: wrap; }
`;

describe("the wrap rule of the field rows", () => {
  it("holds in the real stylesheets", () => {
    expect(wrapProblems(...REAL)).toEqual([]);
  });

  it("is written as a mixin that every row uses", () => {
    expect(fieldRowScss).toMatch(/@mixin wrap-row/);
    expect(fieldRowScss).toMatch(/@mixin wrap-label/);
    expect(inspectorScss).toMatch(/@include row\.wrap-row/);
    expect(stressScss).toMatch(/@include row\.wrap-row/);
  });

  it("finds a row label that clips with an ellipsis", () => {
    const bait = `${GOOD} .param-row label { text-overflow: ellipsis; overflow: hidden; }`;
    expect(wrapProblems(bait)).toEqual([".param-row label clips with an ellipsis"]);
  });

  it("finds a row label that cannot break, in each of the three rows", () => {
    const bait = `${GOOD}
      .ui-field-label { white-space: nowrap; }
      .param-row > label { white-space: nowrap; }
      .stress-field > .measure-k:first-child { white-space: nowrap; }`;
    expect(wrapProblems(bait)).toEqual([
      ".ui-field-label cannot break",
      ".param-row > label cannot break",
      ".stress-field > .measure-k:first-child cannot break",
    ]);
  });

  it("finds a row that does not wrap, and a mixin that does not", () => {
    const bait = `
      @mixin wrap-row($gap: 1px) { display: flex; }
      .ui-field-row-inline { @include wrap-row; }
      .param-row { display: grid; }
      .stress-field { display: flex; flex-wrap: wrap; }`;
    expect(wrapProblems(bait)).toEqual([".param-row does not wrap", "wrap-row does not set flex-wrap: wrap"]);
  });

  it("leaves nowrap alone off a row label and lets a label wrap", () => {
    const quiet = `${GOOD} .btn { white-space: nowrap; } .stress-detail-row .measure-k { white-space: nowrap; }
      .ui-field-label { white-space: normal; overflow-wrap: anywhere; }`;
    expect(wrapProblems(quiet)).toEqual([]);
  });
});
