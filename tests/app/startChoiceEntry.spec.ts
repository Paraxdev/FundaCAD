// The page entry: main.ts, whose imports read the settings as they load, loads only after a Reset settings start
// has cleared them and the language is ready, and the notice comes once the app is up.
import { describe, expect, it, vi } from "vitest";
import indexHtml from "../../index.html?raw";

const order: string[] = [];
let finish: (v: unknown) => void = () => {};

vi.mock("../../src/app/startChoice", () => ({
  runStartChoice: () =>
    new Promise((r) => {
      order.push("reset started");
      finish = r;
    }),
  startChoiceNotice: () => ({ text: "Settings were reset.", kind: "info" }),
}));
vi.mock("../../src/i18n", () => ({
  initLanguage: () =>
    new Promise<void>((r) =>
      setTimeout(() => {
        order.push("language ready");
        r();
      }, 5),
    ),
}));
vi.mock("../../src/main", () => {
  order.push("main loaded");
  return {};
});
const toast = vi.fn((text: string) => order.push(`toast ${text}`));
vi.mock("../../src/ui/toast", () => ({ toast }));

describe("the page entry", () => {
  it("is what index.html loads after boot.ts, in place of main.ts", () => {
    const scripts = [...indexHtml.matchAll(/<script type="module" src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(["/src/boot.ts", "/src/entry.ts"]);
  });

  it("loads main.ts once the start choice is carried out and the language is ready, then shows its notice", async () => {
    await import("../../src/entry");
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["reset started"]);
    finish({ kind: "reset", backup: "C:/b.json", plugins: "kept" });
    await vi.waitFor(() => expect(order).toHaveLength(4));
    expect(order).toEqual(["reset started", "language ready", "main loaded", "toast Settings were reset."]);
    expect(toast).toHaveBeenCalledWith("Settings were reset.", { kind: "info" });
  });
});
