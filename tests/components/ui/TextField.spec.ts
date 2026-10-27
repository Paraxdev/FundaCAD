import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import TextField from "../../../src/components/ui/TextField.vue";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
afterEach(() => setMacForTest(null));

type Props = InstanceType<typeof TextField>["$props"];

async function render(props: Partial<Props> = {}, slots: Record<string, string> = {}) {
  const w = mount(TextField, {
    props: { modelValue: "one", ...props } as Props,
    slots,
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, input: w.get("input") };
}

const emitted = (w: Awaited<ReturnType<typeof render>>["w"]) => w.emitted<[string]>("update:modelValue") ?? [];

describe("TextField", () => {
  it("in change mode emits nothing while typing, then the text on Enter and on blur", async () => {
    const { w, input } = await render({ commit: "change" });
    await input.setValue("two");
    expect(emitted(w)).toEqual([]);
    await input.trigger("keydown", { key: "Enter" });
    expect(emitted(w)).toEqual([["two"]]);
    await w.setProps({ modelValue: "two" });
    await input.setValue("three");
    await input.trigger("blur");
    expect(emitted(w)).toEqual([["two"], ["three"]]);
  });

  it("does not commit an untouched field on blur or Enter", async () => {
    const { w, input } = await render({ commit: "change" });
    (input.element as HTMLInputElement).focus();
    await input.trigger("keydown", { key: "Enter" });
    await input.trigger("blur");
    expect(emitted(w)).toEqual([]);
  });

  it("restores the committed text on Escape and emits nothing after it", async () => {
    const { w, input } = await render({ commit: "change" });
    await input.setValue("draft");
    await input.trigger("keydown", { key: "Escape" });
    expect((input.element as HTMLInputElement).value).toBe("one");
    await input.trigger("blur");
    expect(emitted(w)).toEqual([]);
  });

  it("keeps rejected text with aria-invalid and the reason as its title, and the next keystroke clears it", async () => {
    const { w, input } = await render({
      commit: "change",
      tip: "Name",
      validate: (s: string) => (s.includes("/") ? "No slashes in a name" : null),
    });
    await input.setValue("a/b");
    await input.trigger("keydown", { key: "Enter" });
    expect(emitted(w)).toEqual([]);
    expect([
      (input.element as HTMLInputElement).value,
      input.attributes("aria-invalid"),
      input.attributes("title"),
      w.classes("is-error"),
    ]).toEqual(["a/b", "true", "No slashes in a name", true]);
    await input.setValue("ab");
    expect([input.attributes("aria-invalid"), input.attributes("title"), w.classes("is-error")]).toEqual([
      undefined,
      "Name",
      false,
    ]);
  });

  it("shows an outside error the same way", async () => {
    const { w, input } = await render({ error: "Taken" });
    expect([input.attributes("aria-invalid"), input.attributes("title"), w.classes("is-error")]).toEqual([
      "true",
      "Taken",
      true,
    ]);
  });

  it("in live mode, the default, emits on every input", async () => {
    const { w, input } = await render();
    await input.setValue("o");
    await input.setValue("on");
    expect(emitted(w)).toEqual([["o"], ["on"]]);
  });

  it("keeps a focused draft when the value changes outside, and follows it once blurred", async () => {
    const { w, input } = await render({ commit: "change" });
    (input.element as HTMLInputElement).focus();
    await input.setValue("mine");
    await w.setProps({ modelValue: "theirs" });
    expect((input.element as HTMLInputElement).value).toBe("mine");
    await input.trigger("keydown", { key: "Escape" });
    expect((input.element as HTMLInputElement).value).toBe("theirs");
    (input.element as HTMLInputElement).blur();
    await w.setProps({ modelValue: "later" });
    expect((input.element as HTMLInputElement).value).toBe("later");
  });

  it("writes tip and keys into title and aria-label through fmtKeys", async () => {
    setMacForTest(true);
    const { input } = await render({ tip: "Rename", keys: "Ctrl+R" });
    expect([input.attributes("title"), input.attributes("aria-label")]).toEqual(["Rename (⌘+R)", "Rename (⌘+R)"]);
  });

  it("renders the type, placeholder, size and slots", async () => {
    const { w, input } = await render(
      { type: "search", placeholder: "Find", size: "sm" },
      { leading: "<i class='lead' />", trailing: "<i class='trail' />" },
    );
    expect([input.attributes("type"), input.attributes("placeholder"), w.classes("ui-field-sm")]).toEqual([
      "search",
      "Find",
      true,
    ]);
    expect([w.find(".lead").exists(), w.find(".trail").exists()]).toEqual([true, true]);
  });

  it("puts id and test attributes on the input and class on the well", async () => {
    const w = mount(TextField, {
      props: { modelValue: "" },
      attrs: { id: "rename", "data-testid": "rn", class: "grow" },
    });
    const input = w.get("input");
    expect([input.attributes("id"), input.attributes("data-testid"), w.classes("grow"), w.attributes("id")]).toEqual([
      "rename",
      "rn",
      true,
      undefined,
    ]);
  });

  it("selects its text on focus when asked", async () => {
    const { input } = await render({ modelValue: "select me", selectOnFocus: true });
    const el = input.element as HTMLInputElement;
    el.focus();
    await input.trigger("focus");
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 9]);
  });

  it("disabled: aria-disabled, read only, the reason as title, and it never emits", async () => {
    const { w, input } = await render({ disabled: true, disabledReason: "Locked by the sketch", tip: "Name" });
    expect([
      input.attributes("aria-disabled"),
      w.classes("is-disabled"),
      input.attributes("readonly"),
      input.attributes("title"),
    ]).toEqual(["true", true, "", "Locked by the sketch"]);
    await input.setValue("x");
    await input.trigger("keydown", { key: "Enter" });
    expect(emitted(w)).toEqual([]);
  });
});
