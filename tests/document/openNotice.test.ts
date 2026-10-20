// What opening a document says about the features this version leaves out.

import { beforeEach, describe, expect, it } from "vitest";
import { openNotices } from "../../src/document/openNotice";
import { FORMAT_VERSION } from "../../src/document/migrate";
import { resetContributions } from "../../src/plugins/contrib";
import type { Feature } from "../../src/types";

const f = (id: string, type: string) => ({ id, type }) as unknown as Feature;
const box = f("b1", "box");
const NEWER = FORMAT_VERSION + 1;

beforeEach(() => resetContributions());

describe("openNotices", () => {
  it("says nothing about a file this version builds whole", () => {
    expect(openNotices({ features: [box] }, FORMAT_VERSION)).toEqual([]);
  });

  it("names what a newer file holds that this version leaves out", () => {
    const [n, ...rest] = openNotices(
      { features: [box, f("w1", "futureWidget"), f("w2", "futureWidget"), f("x1", "fooBar")] },
      NEWER,
    );
    expect(rest).toEqual([]);
    expect(n).toEqual({
      kind: "warning",
      message:
        "Opened a file from a newer version of FundaCAD. 3 features were not included because this version does not know them: futureWidget, fooBar. They are kept and saved with the file. Bodies after them may differ.",
      detail: "futureWidget (2): w1, w2\nfooBar (1): x1",
    });
  });

  it("says the same without the newer clause when the stamp is not newer", () => {
    const [n] = openNotices({ features: [f("w1", "futureWidget"), f("x1", "fooBar")] }, FORMAT_VERSION);
    expect(n!.message).toBe(
      "2 features were not included because this version of FundaCAD does not know them: fooBar, futureWidget. They are kept and saved with the file. Bodies after them may differ.",
    );
  });

  it("speaks of one feature as one", () => {
    const [n] = openNotices({ features: [f("w1", "futureWidget")] }, FORMAT_VERSION);
    expect(n!.message).toBe(
      "1 feature was not included because this version of FundaCAD does not know it: futureWidget. It is kept and saved with the file. Bodies after it may differ.",
    );
  });

  it("is a short info note for a newer file whose types are all known", () => {
    expect(openNotices({ features: [box] }, NEWER)).toEqual([{
      kind: "info",
      message: "Opened a file from a newer version of FundaCAD. Anything this version does not know is kept and saved with the file.",
    }]);
  });

  it("names three types and counts the rest, with every one in the detail", () => {
    const types = ["aa", "bb", "cc", "dd", "ee"];
    const [n] = openNotices({ features: types.map((t, i) => f(`x${i}`, t)) }, NEWER);
    expect(n!.message).toContain("does not know them: aa, bb, cc and 2 more.");
    expect(n!.detail!.split("\n")).toHaveLength(5);
  });

  it("leaves a shipped plugin's features to that plugin's own message, counted once", () => {
    const notices = openNotices({ features: [f("t1", "texture"), f("w1", "futureWidget")] }, NEWER);
    expect(notices).toHaveLength(2);
    expect(notices[0]!.message).toContain("1 feature was not included");
    expect(notices[0]!.message).not.toContain("texture");
    expect(notices[1]!.message).toContain("Surface Texture");
  });
});
