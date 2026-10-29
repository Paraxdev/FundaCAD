import { afterEach, describe, expect, it, vi } from "vitest";

import { pickFile } from "../../../src/components/ui/dom";
import { openTextFile } from "../../../src/io/files";

/** Catches the hidden input the picker clicks, as the browser's file dialog would see it. */
function catchPicker(): { input: () => HTMLInputElement } {
  let got: HTMLInputElement | null = null;
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    got = this;
  });
  return {
    input: () => {
      if (!got) throw new Error("no picker was opened");
      return got;
    },
  };
}

function choose(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickFile", () => {
  it("opens a file input for the given types that is never put in the page", async () => {
    const picker = catchPicker();
    const picked = pickFile(".json,application/json");
    const input = picker.input();
    expect([input.type, input.accept, input.isConnected]).toEqual(["file", ".json,application/json", false]);
    const file = new File(["{}"], "a.json", { type: "application/json" });
    choose(input, [file]);
    expect(await picked).toBe(file);
  });

  it("is null when the dialog is dismissed", async () => {
    const picker = catchPicker();
    const picked = pickFile(".hdr");
    picker.input().dispatchEvent(new Event("cancel"));
    expect(await picked).toBeNull();
  });

  it("control: a change with no file is null too", async () => {
    const picker = catchPicker();
    const picked = pickFile(".hdr");
    choose(picker.input(), []);
    expect(await picked).toBeNull();
  });
});

describe("the browser fallback of openTextFile", () => {
  it("reads the picked file's text through pickFile, offering only the filter's types", async () => {
    const picker = catchPicker();
    const text = openTextFile({ name: "Library", extensions: ["json", "mat"] });
    await vi.waitFor(() => picker.input());
    expect(picker.input().accept).toBe(".json,.mat");
    choose(picker.input(), [new File(['{"materials":[]}'], "lib.json")]);
    expect(await text).toBe('{"materials":[]}');
  });

  it("is null when the pick is dismissed", async () => {
    const picker = catchPicker();
    const text = openTextFile({ name: "Library", extensions: ["json"] });
    await vi.waitFor(() => picker.input());
    picker.input().dispatchEvent(new Event("cancel"));
    expect(await text).toBeNull();
  });
});
