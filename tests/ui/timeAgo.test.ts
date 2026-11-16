import { afterEach, describe, expect, it } from "vitest";
import { activeLanguage, setLanguage, t } from "../../src/i18n";
import { ago, agoKind } from "../../src/ui/timeAgo";

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

describe("agoKind", () => {
  it("names the shape ago gives, at its edges too", () => {
    expect(agoKind(NOW - 59_000, NOW)).toBe("now");
    expect(agoKind(NOW + 5 * MIN, NOW)).toBe("now");
    expect(agoKind(NOW - 60_000, NOW)).toBe("ago");
    expect(agoKind(NOW - (7 * 24 * 60 - 31) * MIN, NOW)).toBe("ago");
    expect(agoKind(NOW - (7 * 24 * 60 - 30) * MIN, NOW)).toBe("date");
  });

  it("lets a card line word a date and just now in each language", async () => {
    const line = (key: "home.card.edited" | "home.card.opened", time: number) =>
      t(key, { when: ago(time, NOW), kind: agoKind(time, NOW) });
    const old = NOW - 30 * 24 * 60 * MIN;
    const recent = NOW - 10_000;
    expect(line("home.card.edited", old)).toMatch(/^Edited on /);
    expect(line("home.card.edited", NOW - 5 * MIN)).toBe("Edited 5 min ago");
    await setLanguage("de");
    expect(line("home.card.edited", old)).toBe("Bearbeitet am 20. Sept. 2026");
    expect(line("home.card.opened", recent)).toBe("Geöffnet gerade eben");
    await setLanguage("fr");
    expect(line("home.card.edited", old)).toMatch(/^Modifié le 20 /);
    await setLanguage("es");
    expect(line("home.card.opened", old)).toMatch(/^Abierto el 20 /);
    await setLanguage("ja");
    expect(line("home.card.edited", recent)).toBe("たった今編集");
    expect(line("home.card.edited", NOW - 5 * MIN)).toBe("5 分前に編集");
    await setLanguage("zh-CN");
    expect(line("home.card.opened", recent)).toBe("刚刚打开");
    expect(line("home.card.edited", NOW - 5 * MIN)).toBe("5 分钟前编辑");
    expect(line("home.card.edited", old)).toMatch(/^编辑于2026/);
  });
});
