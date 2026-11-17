// The accessibility tree walks are not a gate yet: their first runs on a real bus and a real WebView2 are the spike,
// so each stays continue-on-error until it has run green. Their checkers' own tests against fake trees have, and the
// browser smoke has, so a failure in those must turn its job red.

import { describe, expect, it } from "vitest";

import workflow from "../../.github/workflows/build.yml?raw";

const steps = workflow
  .split(/^ {6}- /m)
  .slice(1)
  .map((text) => ({ name: /name: (.*)/.exec(text)?.[1]?.trim() ?? "", text }));
const runOf = (text: string) => /^ {8}run: ?([\s\S]*)$/m.exec(text)?.[1] ?? "";

describe("the accessibility steps", () => {
  it("only the browser smoke and the walks' own tests can fail the job", () => {
    const a11y = steps.filter((s) => /-m a11y|atspi|uia_walk/.test(runOf(s.text)));
    expect(a11y.map((s) => [s.name, /^ {8}continue-on-error: true$/m.test(s.text)])).toEqual([
      ["AT-SPI dump tests", false],
      ["UI Automation walk tests", false],
      ["Dump the AppImage accessibility tree over AT-SPI", true],
      ["Walk the exe window over UI Automation", true],
      ["Accessibility smoke (axe and aria snapshots)", false],
    ]);
  });
});
