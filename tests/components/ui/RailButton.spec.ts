import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import RailButton from "../../../src/components/ui/RailButton.vue";

type Props = Record<string, unknown>;
const rail = (props: Props, attrs: Props = {}) =>
  mount(RailButton, { props: { icon: "search", label: "Isolate", ...props }, attrs });

describe("rail button state", () => {
  it("says pressed only for a toggle", () => {
    expect(rail({ pressed: true }).attributes("aria-pressed")).toBe("true");
    expect(rail({ pressed: false }).attributes("aria-pressed")).toBe("false");
    expect(rail({ active: true }).attributes("aria-pressed")).toBeUndefined();
  });

  it("keeps the active look apart from the pressed state", () => {
    const w = rail({ active: true, pressed: false });
    expect([w.classes("active"), w.attributes("aria-pressed")]).toEqual([true, "false"]);
  });

  it("leaves a toggle's state word out of its name but keeps it in the tooltip", () => {
    const w = rail({ pressed: true, sub: "On", keys: "I" });
    expect([w.attributes("aria-label"), w.attributes("title")]).toEqual(["Isolate (I)", "Isolate On (I)"]);
    expect(rail({ sub: "Box" }).attributes("aria-label")).toBe("Isolate Box");
  });

  it("says it opens a popup and whether it is open", () => {
    const shut = rail({ popup: "dialog" });
    expect([shut.attributes("aria-haspopup"), shut.attributes("aria-expanded")]).toEqual(["dialog", "false"]);
    expect(rail({ popup: "dialog", expanded: true }).attributes("aria-expanded")).toBe("true");
    expect(rail({ popup: true }).attributes("aria-haspopup")).toBe("true");
  });

  it("never says pressed on a popup opener", () => {
    const w = rail({ popup: "dialog", pressed: true, active: true });
    expect([w.attributes("aria-pressed"), w.classes("active")]).toEqual([undefined, true]);
  });

  it("says nothing about expanding without a popup", () => {
    const w = rail({ expanded: true });
    expect([w.attributes("aria-haspopup"), w.attributes("aria-expanded")]).toEqual([undefined, undefined]);
  });
});

describe("rail button disabled", () => {
  it("stays focusable, keeps its look and says why", () => {
    const w = rail({ disabled: true, disabledReason: "Select a face first" });
    expect(w.attributes("disabled")).toBeUndefined();
    expect(w.attributes("aria-disabled")).toBe("true");
    expect(w.classes()).toEqual(expect.arrayContaining(["disabled", "is-disabled"]));
    expect(w.attributes("title")).toBe("Select a face first");
    const reason = w.find(`#${w.attributes("aria-describedby")}`);
    expect(reason.text()).toBe("Select a face first");
  });

  it("swallows a click and Enter while disabled", async () => {
    const onClick = vi.fn();
    const onKeydown = vi.fn();
    const w = rail({ disabled: true }, { onClick, onKeydown });
    await w.trigger("click");
    await w.trigger("keydown", { key: "Enter" });
    expect([onClick.mock.calls.length, onKeydown.mock.calls.length]).toEqual([0, 0]);
    expect(w.attributes("title")).toBe("Isolate");
    expect(w.attributes("aria-describedby")).toBeUndefined();
  });

  it("answers a click when the block is soft", async () => {
    const onClick = vi.fn();
    await rail({ disabled: true, clickable: true }, { onClick }).trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("answers a click when enabled", async () => {
    const onClick = vi.fn();
    const w = rail({}, { onClick });
    await w.trigger("click");
    expect([onClick.mock.calls.length, w.attributes("aria-disabled")]).toEqual([1, undefined]);
  });
});
