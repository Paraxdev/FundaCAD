import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));

import TextField from "../../../src/components/ui/TextField.vue";
import { announce } from "../../../src/ui/announce";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
afterEach(() => {
  setMacForTest(null);
  vi.useRealTimers();
});
beforeEach(() => vi.mocked(announce).mockClear());

async function render(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  const w = mount(TextField, {
    props: { modelValue: "one", label: "Name", ...props } as never,
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

  it("in live mode, shows a value its owner sets while focused, a cleared search for one", async () => {
    const { w, input } = await render();
    (input.element as HTMLInputElement).focus();
    await input.setValue("gea");
    await w.setProps({ modelValue: "gea" });
    expect((input.element as HTMLInputElement).value).toBe("gea");
    await w.setProps({ modelValue: "" });
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(input.element);
  });

  it("in live mode, keeps refused text when the value changes outside", async () => {
    const { w, input } = await render({ validate: (t: string) => (t.includes("!") ? "No bangs" : null) });
    (input.element as HTMLInputElement).focus();
    await input.setValue("hi!");
    await w.setProps({ modelValue: "other" });
    expect((input.element as HTMLInputElement).value).toBe("hi!");
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

  it("writes tip and keys into the title through fmtKeys, and names the field by its label alone", async () => {
    setMacForTest(true);
    const { input } = await render({ label: "Rename", tip: "Rename", keys: "Ctrl+R" });
    expect([input.attributes("title"), input.attributes("aria-label")]).toEqual(["Rename (⌘+R)", "Rename"]);
  });

  it("names the field by labelledby alone when given one", async () => {
    const { input } = await render({ label: undefined, labelledby: "name-label" });
    expect([input.attributes("aria-label"), input.attributes("aria-labelledby")]).toEqual([undefined, "name-label"]);
  });

  it("warns in a dev build when it has no name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount(TextField, { props: { modelValue: "" } as never });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("TextField has no name"))).toBe(true);
    warn.mockRestore();
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
      props: { modelValue: "", label: "Rename" },
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

  it("multiline is a textarea that takes rows, types a new line on Enter and commits on blur", async () => {
    const w = mount(TextField, {
      props: { modelValue: "one", label: "Notes", commit: "change", multiline: true },
      attrs: { rows: "4" },
      attachTo: document.body,
    });
    await new Promise((r) => setTimeout(r, 2));
    const area = w.get("textarea");
    expect([
      w.find("input").exists(),
      area.attributes("rows"),
      area.attributes("type"),
      w.classes("is-multiline"),
    ]).toEqual([false, "4", undefined, true]);
    await area.setValue("one\ntwo");
    await area.trigger("keydown", { key: "Enter" });
    expect(w.emitted("update:modelValue")).toBeUndefined();
    await area.trigger("blur");
    expect(w.emitted("update:modelValue")).toEqual([["one\ntwo"]]);
  });

  it("focus() puts the caret in the field", async () => {
    const { w, input } = await render();
    (w.vm as unknown as { focus: () => void }).focus();
    expect(document.activeElement).toBe(input.element);
  });
});

describe("TextField refusal", () => {
  const noSlash = (s: string) => (s.includes("/") ? "No slashes in a name" : null);
  const described = (el: Element) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "?");
  const spoken = () => vi.mocked(announce).mock.calls;

  it("describes a refused text on the field and drops the description once it is fixed", async () => {
    const { input } = await render({ commit: "change", validate: noSlash });
    expect(input.attributes("aria-describedby")).toBeUndefined();
    await input.setValue("a/b/c");
    await input.trigger("keydown", { key: "Enter" });
    expect(described(input.element)).toEqual(["No slashes in a name"]);
    await input.setValue("abc");
    expect(input.attributes("aria-describedby")).toBeUndefined();
    expect(input.element.parentElement?.querySelector(".sr-only")).toBeNull();
  });

  it("describes a reason from outside, with the caller's ids after it", async () => {
    const { w, input } = await render({ "aria-describedby": "note-a note-b" });
    expect(input.attributes("aria-describedby")).toBe("note-a note-b");
    await w.setProps({ error: "Already taken" });
    const ids = (input.attributes("aria-describedby") ?? "").split(" ");
    expect(ids.slice(1)).toEqual(["note-a", "note-b"]);
    expect(described(input.element)[0]).toBe("Already taken");
    await w.setProps({ error: null });
    expect(input.attributes("aria-describedby")).toBe("note-a note-b");
  });

  it("describes a multiline field the same way", async () => {
    const w = mount(TextField, {
      props: { modelValue: "one", label: "Notes", multiline: true, commit: "change", validate: noSlash },
      attachTo: document.body,
    });
    await new Promise((r) => setTimeout(r, 2));
    const area = w.get("textarea");
    await area.setValue("a/b");
    await area.trigger("blur");
    expect(described(area.element)).toEqual(["No slashes in a name"]);
  });

  it("gives each field in one app its own error id", async () => {
    const Two = defineComponent({
      render: () => [
        h(TextField, { modelValue: "x", label: "A", error: "Bad A" }),
        h(TextField, { modelValue: "y", label: "B", error: "Bad B" }),
      ],
    });
    const w = mount(Two, { attachTo: document.body });
    const [a, b] = w.findAll("input").map((i) => i.element);
    expect(a!.getAttribute("aria-describedby")).not.toBe(b!.getAttribute("aria-describedby"));
    expect([a, b].map((e) => described(e!))).toEqual([["Bad A"], ["Bad B"]]);
  });

  it("speaks a refusal once on Enter without the name while focused, and not again for the same text", async () => {
    const { input } = await render({ commit: "change", validate: noSlash });
    (input.element as HTMLInputElement).focus();
    await input.setValue("a/b");
    await input.trigger("keydown", { key: "Enter" });
    expect(spoken()).toEqual([["No slashes in a name", "assertive"]]);
    await input.trigger("keydown", { key: "Enter" });
    expect(spoken()).toHaveLength(1);
    await input.setValue("a/b/c");
    await input.trigger("keydown", { key: "Enter" });
    expect(spoken()).toHaveLength(2);
  });

  it("names the field when a blur commits the refusal with focus elsewhere", async () => {
    const { input } = await render({ commit: "change", validate: noSlash, label: "Part name" });
    await input.setValue("a/b");
    await input.trigger("blur");
    expect(spoken()).toEqual([["Part name, No slashes in a name", "assertive"]]);
  });

  it("speaks a reason from outside once", async () => {
    const { w } = await render({ commit: "change" });
    await w.setProps({ error: "Already taken" });
    await w.setProps({ error: "Taken twice" });
    expect(spoken()).toEqual([["Name, Already taken", "assertive"]]);
  });

  describe("in live mode", () => {
    async function live() {
      const r = await render({ commit: "live", validate: noSlash });
      (r.input.element as HTMLInputElement).focus();
      vi.useFakeTimers();
      return r;
    }

    it("speaks nothing for text fixed inside the pause", async () => {
      const { input } = await live();
      await input.setValue("a/");
      vi.advanceTimersByTime(699);
      await input.setValue("a");
      vi.advanceTimersByTime(5000);
      expect(spoken()).toEqual([]);
    });

    it("speaks the reason at 700 ms, once, with the reason current then", async () => {
      const { input } = await live();
      await input.setValue("a/");
      vi.advanceTimersByTime(699);
      expect(spoken()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(spoken()).toEqual([["No slashes in a name", "assertive"]]);
      await input.setValue("a//");
      vi.advanceTimersByTime(5000);
      expect(spoken()).toHaveLength(1);
    });

    it("speaks nothing when the field goes away inside the pause", async () => {
      const { w, input } = await live();
      await input.setValue("a/");
      vi.advanceTimersByTime(300);
      w.unmount();
      vi.advanceTimersByTime(5000);
      expect(spoken()).toEqual([]);
    });
  });
});
