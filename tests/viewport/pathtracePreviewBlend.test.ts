import { describe, expect, it } from "vitest";
import { PreviewBlend } from "../../src/viewport/pathtrace/previewBlend";

function blend() {
  const calls: string[] = [];
  const b = new PreviewBlend("last", {
    draw: (from, to, mix) => calls.push(`draw ${from} ${to} ${mix}`),
    keep: (p) => calls.push(`keep ${p}`),
  });
  return { b, calls };
}

describe("preview blend", () => {
  it("leaves the first preview as the tracer drew it, and keeps it", () => {
    const { b, calls } = blend();
    b.drew("a", 0);
    expect(calls).toEqual(["keep a"]);
  });

  it("mixes the next preview evenly with the last, before it replaces the last", () => {
    const { b, calls } = blend();
    b.drew("a", 0);
    calls.length = 0;
    b.drew("b", 16);
    expect(calls).toEqual(["draw last b 0.5", "keep b"]);
  });

  it("does not mix over a long gap, the last preview shows another moment", () => {
    const { b, calls } = blend();
    b.drew("a", 0);
    calls.length = 0;
    b.drew("b", 500);
    expect(calls).toEqual(["keep b"]);
    calls.length = 0;
    b.drew("c", 516);
    expect(calls).toEqual(["draw last c 0.5", "keep c"]);
  });
});
