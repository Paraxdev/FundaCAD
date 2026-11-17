import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h } from "vue";
import FileRow from "../../../src/components/shell/FileRow.vue";

const openDialog = vi.hoisted(() => vi.fn());
vi.mock("../../../src/plugins/host", () => ({ openDialog }));

enableAutoUnmount(afterEach);

beforeEach(() => {
  openDialog.mockReset();
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

/** What a screen reader says for an element named by idrefs, own aria-label standing in for itself. */
function spoken(el: Element): string {
  const refs = (el.getAttribute("aria-labelledby") ?? "").split(" ").filter(Boolean);
  return refs
    .map((id) => {
      const target = document.getElementById(id)!;
      if (target === el) return el.getAttribute("aria-label") ?? el.textContent;
      return target.textContent;
    })
    .join(" ")
    .trim();
}

function mountRow(label: string, value: string, commit: (v: string) => void = () => {}) {
  return mount(FileRow, { props: { label, value, commit }, attachTo: document.body });
}

describe("FileRow", () => {
  it("names the pick button by the row label then its own text when nothing is chosen", () => {
    const w = mountRow("Heightmap", "");
    expect(spoken(w.get("button.file-pick").element)).toBe("Heightmap Choose\u2026");
    expect(w.find("button.file-clear").exists()).toBe(false);
  });

  it("names the pick button by the label and the file name, from a path with either slant last", () => {
    const back = String.raw`D:/maps\v2\relief.png`;
    const w = mountRow("Heightmap", back);
    expect([spoken(w.get("button.file-pick").element), w.get(".param-row").attributes("title")]).toEqual([
      "Heightmap relief.png",
      back,
    ]);
    w.unmount();
    const forward = String.raw`D:\maps\v2/bump map.png`;
    const v = mountRow("Heightmap", forward);
    expect([spoken(v.get("button.file-pick").element), v.get(".param-row").attributes("title")]).toEqual([
      "Heightmap bump map.png",
      forward,
    ]);
  });

  it("names the clear button by the label then its own action", async () => {
    const commits: string[] = [];
    const w = mountRow("Heightmap", "/a/b/relief.png", (v) => commits.push(v));
    const clear = w.get("button.file-clear");
    expect(spoken(clear.element)).toBe("Heightmap Clear the file");
    await clear.trigger("click");
    expect(commits).toEqual([""]);
  });

  it("gives two rows different ids, each button pointing at its own label", () => {
    const w = mount(
      {
        render: () =>
          h("div", [
            h(FileRow, { label: "Heightmap", value: "", commit: () => {} }),
            h(FileRow, { label: "Mask", value: "d/mask.png", commit: () => {} }),
          ]),
      },
      { attachTo: document.body },
    );
    const labels = w.findAll("label");
    const picks = w.findAll("button.file-pick");
    expect(labels.map((l) => l.attributes("for"))).toEqual([undefined, undefined]);
    expect(labels[0]!.attributes("id")).not.toBe(labels[1]!.attributes("id"));
    expect(picks.map((p) => spoken(p.element))).toEqual(["Heightmap Choose\u2026", "Mask mask.png"]);
    expect(picks[0]!.attributes("id")).not.toBe(picks[1]!.attributes("id"));
  });

  it("does not browse when the label is clicked, only when the button is", async () => {
    openDialog.mockResolvedValue("C:/x/new.png");
    const commits: string[] = [];
    const w = mountRow("Heightmap", "", (v) => commits.push(v));
    await w.get("label").trigger("click");
    expect(openDialog).not.toHaveBeenCalled();
    await w.get("button.file-pick").trigger("click");
    await Promise.resolve();
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(commits).toEqual(["C:/x/new.png"]);
  });

  it("renders its field as data-field on the row, and none without one", () => {
    const withField = mount(FileRow, {
      props: { label: "Heightmap", field: "heightmapPath", value: "", commit: () => {} },
    });
    expect(withField.get(".param-row").attributes("data-field")).toBe("heightmapPath");
    const without = mount(FileRow, { props: { label: "Heightmap", value: "", commit: () => {} } });
    expect(without.get(".param-row").attributes("data-field")).toBeUndefined();
  });
});
