// Every Tauri webview call the app makes needs its permission in the capability file, and a missing one fails only
// in the packaged app: Interface size would then silently stay at 100 percent. Sources come from import.meta.glob.

import { describe, expect, it } from "vitest";

const sources = import.meta.glob(["../../src/**/*.ts", "../../src/**/*.vue"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const capabilityText = Object.values(
  import.meta.glob("../../src-tauri/capabilities/default.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>,
)[0]!;

// The command names do not follow the method names (setZoom is set_webview_zoom), so the table grows by hand.
const PERMISSION: Record<string, string> = { setZoom: "core:webview:allow-set-webview-zoom" };

function webviewCalls(texts: Iterable<string>): Set<string> {
  const calls = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/getCurrentWebview\(\)\.(\w+)\(/g)) calls.add(m[1]!);
  return calls;
}

function missing(calls: Set<string>, granted: Set<string>): string[] {
  return [...calls].map((c) => PERMISSION[c] ?? `unknown webview call ${c}`).filter((p) => !granted.has(p));
}

describe("Tauri webview permissions", () => {
  const calls = webviewCalls(Object.values(sources));
  const capability = JSON.parse(capabilityText) as { permissions: (string | { identifier: string })[] };
  const granted = new Set(capability.permissions.map((p) => (typeof p === "string" ? p : p.identifier)));

  it("finds the setZoom call, so the check is not vacuous", () => {
    expect([...calls]).toContain("setZoom");
  });

  it("grants a permission for every webview call", () => {
    expect(missing(calls, granted)).toEqual([]);
  });

  it("fails a call with no permission and a call it does not know", () => {
    const found = webviewCalls(["getCurrentWebview().setZoom(2)", "getCurrentWebview().reparent(w)"]);
    expect(missing(found, new Set())).toEqual(["core:webview:allow-set-webview-zoom", "unknown webview call reparent"]);
  });
});
