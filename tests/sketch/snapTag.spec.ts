import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ui/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));

import { SnapTag } from "../../src/sketch/snapTag";
import { announce, cancelAnnouncement } from "../../src/ui/announce";

describe("the snap tag's speech", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.mocked(announce).mockClear();
    vi.mocked(cancelAnnouncement).mockClear();
  });

  it("asks once per new snap, debounced, however often the pointer moves over it", () => {
    const tag = new SnapTag();
    tag.show("Endpoint", { x: 10, y: 10 });
    tag.show("Endpoint", { x: 11, y: 10 });
    tag.show("Midpoint", { x: 40, y: 10 });
    expect(vi.mocked(announce).mock.calls).toEqual([
      ["Endpoint", "polite", { key: "snap", delay: 300 }],
      ["Midpoint", "polite", { key: "snap", delay: 300 }],
    ]);
    expect(document.querySelector('[data-testid="snap-tag"]')?.textContent).toBe("Midpoint");
  });

  it("drops a snap still waiting when the tag hides, and speaks the same snap again after", () => {
    const tag = new SnapTag();
    tag.hide();
    expect(cancelAnnouncement).not.toHaveBeenCalled();
    tag.show("Face Center", { x: 0, y: 0 });
    tag.hide();
    expect(cancelAnnouncement).toHaveBeenCalledWith("snap");
    tag.show("Face Center", { x: 0, y: 0 });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("shows a silent tag without a word, drops the one waiting, and lets a pointer on the same name speak", () => {
    const tag = new SnapTag();
    tag.show("Midpoint", { x: 40, y: 10 });
    vi.mocked(announce).mockClear();
    tag.show("12.5, -7", { x: 41, y: 12 }, { silent: true });
    expect(announce).not.toHaveBeenCalled();
    expect(cancelAnnouncement).toHaveBeenCalledWith("snap");
    expect(document.querySelector('[data-testid="snap-tag"]')?.textContent).toBe("12.5, -7");
    tag.show("12.5, -7", { x: 41, y: 12 });
    expect(vi.mocked(announce).mock.calls).toEqual([["12.5, -7", "polite", { key: "snap", delay: 300 }]]);
  });

  it("keeps a silent tag quiet however often it is shown", () => {
    const tag = new SnapTag();
    for (const x of [3, 4, 5]) tag.show(`${x}, 9`, { x, y: 9 }, { silent: true });
    expect(announce).not.toHaveBeenCalled();
    expect(cancelAnnouncement).not.toHaveBeenCalled();
  });
});
