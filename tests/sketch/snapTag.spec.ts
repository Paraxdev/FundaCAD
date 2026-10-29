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
});
