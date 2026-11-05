// The time a message stays, per kind, button and Notification time setting.

import { describe, expect, it } from "vitest";
import { noticeHoldMs, type NoticeKind } from "../../src/ui/noticeTime";
import type { NoticeTime } from "../../src/ui/a11yPrefs";

const KINDS: NoticeKind[] = ["info", "warning", "error"];
const TIMES: NoticeTime[] = ["normal", "longer", "until-dismissed"];

describe("noticeHoldMs", () => {
  it("gives the whole table, every kind with and without a button at every time", () => {
    const got = Object.fromEntries(
      TIMES.map((t) => [
        t,
        Object.fromEntries(
          KINDS.map((k) => [k, [noticeHoldMs(k, false, undefined, t), noticeHoldMs(k, true, undefined, t)]]),
        ),
      ]),
    );
    expect(got).toEqual({
      normal: { info: [5000, 15000], warning: [8000, 15000], error: [10000, 15000] },
      longer: { info: [15000, 45000], warning: [24000, 45000], error: [30000, 45000] },
      "until-dismissed": { info: [null, null], warning: [null, null], error: [null, null] },
    });
  });

  it("raises a button's time to 15 s at 14999, keeps 15000 and a longer 15001", () => {
    expect(noticeHoldMs("info", true, 14999, "normal")).toBe(15000);
    expect(noticeHoldMs("info", true, 15000, "normal")).toBe(15000);
    expect(noticeHoldMs("info", true, 15001, "normal")).toBe(15001);
    expect(noticeHoldMs("info", true, 15001, "longer")).toBe(45003);
  });

  it("takes a caller's time when it is longer than the kind's, never when shorter", () => {
    expect(noticeHoldMs("info", false, 8000, "longer")).toBe(24000);
    expect(noticeHoldMs("info", false, 12000, "normal")).toBe(12000);
    expect(noticeHoldMs("info", false, 4999, "normal")).toBe(5000);
    expect(noticeHoldMs("warning", false, 3000, "normal")).toBe(8000);
    expect(noticeHoldMs("error", false, 9000, "normal")).toBe(10000);
  });

  it("stays until dismissed whatever the caller asks", () => {
    expect(noticeHoldMs("warning", true, 60000, "until-dismissed")).toBeNull();
  });

  it("follows the stored setting by default", () => {
    expect(noticeHoldMs("info", false)).toBe(5000);
  });
});
