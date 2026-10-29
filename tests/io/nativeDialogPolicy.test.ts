import { describe, expect, it } from "vitest";

// Read through the bundler like tests/components/vHtmlPolicy.test.ts, so the check needs no node typings.
const sources = import.meta.glob("../../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PLUGIN = /["']@tauri-apps\/plugin-dialog["']/;
const ALLOWED = ["../../src/io/nativeDialog.ts"];

describe("native dialog policy", () => {
  it("finds the sources to check, the wrapper among them", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(PLUGIN.test(sources[ALLOWED[0]!] ?? "")).toBe(true);
  });

  // A direct import skips withFocusReturn, so WebKitGTK and WKWebView leave focus on the body after the dialog.
  it("reaches the dialog plugin only through src/io/nativeDialog.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path, src]) => PLUGIN.test(src) && !ALLOWED.includes(path))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
