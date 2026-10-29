// SCAN-13: the value box unit chip was a 17px tall target. A bounding box scan (axe target-size) reads the element,
// not a ::before hit area, so the chip itself is drawn 24 by 24 and its wash stays chip sized inside it.

import { describe, expect, it } from "vitest";

const styles = import.meta.glob("../../src/styles/_utilities.scss", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const utilities = Object.values(styles)[0]!;

function declarations(selector: string): Record<string, string> {
  const at = utilities.indexOf(`\n${selector} {`);
  if (at < 0) return {};
  const body = utilities.slice(utilities.indexOf("{", at) + 1, utilities.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const line of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const [k, ...v] = line.split(":");
    if (k?.trim() && v.length) out[k.trim()] = v.join(":").trim();
  }
  return out;
}

describe("value box unit chip target", () => {
  it("is drawn 24 by 24 itself, with no pseudo element standing in for the hit area", () => {
    expect({
      chip: declarations(".dim-field .dim-unit"),
      before: declarations(".dim-field .dim-unit::before"),
      choiceBefore: declarations(".dim-field .dim-choice::before"),
    }).toEqual({
      chip: {
        "min-width": "24px",
        "min-height": "24px",
        "justify-content": "center",
        padding: "3px 2px",
        "background-clip": "content-box",
        "border-radius": "8px",
      },
      before: {},
      choiceBefore: {},
    });
  });
});
