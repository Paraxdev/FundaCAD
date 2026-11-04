// A global failure that reads as internal text says what went wrong in plain words, the raw report stays in the console.
import { afterEach, describe, expect, it, vi } from "vitest";

const toasts: { message: string; detail: unknown }[] = [];
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, o: { detail: unknown }) => toasts.push({ message, detail: o.detail }),
}));

class RejectionEvent extends Event {
  constructor(readonly reason: unknown) {
    super("unhandledrejection");
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  toasts.length = 0;
});

async function reject(reason: unknown) {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { userAgent: "test" });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const { installGlobalErrorHandlers } = await import("../../src/app/errors");
  installGlobalErrorHandlers();
  window.dispatchEvent(new RejectionEvent(reason));
  err.mockRestore();
  return [...toasts];
}

describe("global error headline", () => {
  it("keeps a plain sentence and drops the Error prefix", async () => {
    const [t] = await reject(new Error("Error: Sketch 4 lost its plane"));
    expect(t?.message).toBe("Unexpected error: Sketch 4 lost its plane");
  });

  it.each([
    ["a TypeError", new TypeError("Cannot read properties of undefined (reading 'faces')"), "reading 'faces'"],
    ["an OCCT name", new Error("Standard_NullObject: BRepFilletAPI_MakeFillet failed"), "BRepFilletAPI_MakeFillet"],
    ["a Rust panic", "thread 'engine' panicked at crates/kernel/src/sew.rs:88:5", "sew.rs:88:5"],
    ["an object with no message", { code: 9 }, '"code": 9'],
  ])("%s says what failed and keeps the raw report in the detail", async (_name, reason, rawPart) => {
    const out = await reject(reason);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatch(/^Something went wrong\./);
    expect(out[0]?.message).not.toMatch(/Error|panicked|BRep|undefined|\{/);
    expect(String(out[0]?.detail)).toContain("Unhandled promise rejection");
    expect(String(out[0]?.detail)).toContain(rawPart);
  });
});
