import { afterEach, describe, expect, it } from "vitest";
import { activeLanguage, setLanguage } from "../../src/i18n";
import { ago } from "../../src/ui/timeAgo";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;

afterEach(() => setLanguage("system"));

describe("ago", () => {
  it("reads a recent time in minutes and hours", () => {
    expect(ago(NOW - 10_000, NOW)).toBe("just now");
    expect(ago(NOW - 5 * MIN, NOW)).toBe("5 min ago");
    expect(ago(NOW - 3 * 60 * MIN, NOW)).toBe("3 h ago");
  });

  it("counts days for the last week", () => {
    expect(ago(NOW - 26 * 60 * MIN, NOW)).toBe("1 day ago");
    expect(ago(NOW - 3 * 24 * 60 * MIN, NOW)).toBe("3 days ago");
  });

  it("gives the date for anything older", () => {
    const t = NOW - 30 * 24 * 60 * MIN;
    expect(ago(t, NOW)).toBe(
      new Date(t).toLocaleDateString(activeLanguage().bcp47, { day: "numeric", month: "short", year: "numeric" }),
    );
    expect(ago(t, NOW)).not.toMatch(/^\d+\/\d+\/\d+$/);
  });

  it("treats a time in the future as now", () => {
    expect(ago(NOW + 5 * MIN, NOW)).toBe("just now");
  });

  it("reads in the chosen language, the date included", async () => {
    await setLanguage("de");
    expect(ago(NOW - 10_000, NOW)).toBe("gerade eben");
    expect(ago(NOW - 5 * MIN, NOW)).toBe("vor 5 Min.");
    expect(ago(NOW - 3 * 24 * 60 * MIN, NOW)).toBe("vor 3 Tagen");
    expect(ago(NOW - 30 * 24 * 60 * MIN, NOW)).toBe("20. Sept. 2026");
  });
});
