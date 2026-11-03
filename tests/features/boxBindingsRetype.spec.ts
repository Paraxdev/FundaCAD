// A number retyped over a parameter's value replaces the binding, even when it is the number the box already shows.
import { afterEach, describe, expect, it } from "vitest";
import { boxBindings } from "../../src/features/boxBindings";
import { DimInput } from "../../src/sketch/dimInput";

function retype(input: HTMLInputElement, text: string, inputType: string) {
  input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType }));
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
}

describe("boxBindings on a field bound to an expression", () => {
  afterEach(() => {
    for (const el of document.querySelectorAll(".dim-input")) el.remove();
  });

  function open() {
    const dim = new DimInput();
    dim.show(
      [{ name: "radius", label: "Radius", kind: "length" as const }],
      () => {},
      () => dim.hide(),
    );
    dim.updateFromCursor({ radius: 2.5 });
    const input = document.querySelector<HTMLInputElement>(".dim-input input")!;
    const store = { boundExpr: () => ({ expr: "t * 2" }) };
    const bindings = () => boxBindings(dim, store, "f6", [{ box: "radius", field: "radius", value: 2.5 }]);
    return { input, bindings };
  }
  const NUMBER = [{ target: { kind: "feature", feature: "f6", field: "radius" }, kind: "length", expr: "2.5" }];

  it("keeps the binding while the field was not typed in", () => {
    expect(open().bindings()).toEqual([]);
  });

  it("replaces it with the number when the shown text is typed over", () => {
    const { input, bindings } = open();
    retype(input, "2.5", "insertText");
    expect(bindings()).toEqual(NUMBER);
  });

  it("keeps it again after that typing is undone", () => {
    const { input, bindings } = open();
    retype(input, "2.5", "insertText");
    retype(input, "2.5", "historyUndo");
    expect(bindings()).toEqual([]);
  });
});
