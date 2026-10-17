import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { connectNative } from "../../src/viewport/pathtrace/nativeTracer";

class FakeSocket {
  static OPEN = 1;
  static refuse = false;
  readyState = 1;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    queueMicrotask(() => (FakeSocket.refuse ? this.onerror?.() : this.onopen?.()));
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

function fakeWebView2() {
  const listeners = new Set<unknown>();
  return {
    listeners,
    addEventListener: (_t: string, cb: unknown) => listeners.add(cb),
    removeEventListener: (_t: string, cb: unknown) => listeners.delete(cb),
    releaseBuffer: vi.fn(),
  };
}

const opened = (kind: string, id: number) => ({
  id,
  kind,
  generation: 1,
  port: kind === "websocket" ? 4321 : null,
  token: kind === "websocket" ? "t" : null,
  source: "test",
});

describe("connecting the native frame transport", () => {
  let wv: ReturnType<typeof fakeWebView2>;

  beforeEach(() => {
    invoke.mockReset();
    wv = fakeWebView2();
    vi.stubGlobal("chrome", { webview: wv });
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  afterEach(() => {
    FakeSocket.refuse = false;
    vi.unstubAllGlobals();
  });

  const calls = () => invoke.mock.calls.map((c) => c[0]);

  it("keeps the socket the app fell back to when shared buffers fail", async () => {
    invoke.mockResolvedValueOnce(opened("websocket", 7));
    const c = await connectNative(64, 32);
    expect(c.link.kind).toBe("websocket");
    expect(calls()).toEqual(["frames_open"]);
    expect(wv.listeners.size).toBe(0);
    invoke.mockResolvedValue(undefined);
    c.link.close();
    expect(invoke).toHaveBeenLastCalledWith("frames_close", { id: 7 });
  });

  it("names the transport it opened when it closes the shared buffers", async () => {
    invoke.mockResolvedValueOnce(opened("sharedbuffer", 3));
    const c = await connectNative(64, 32);
    expect(c.link.kind).toBe("sharedbuffer");
    invoke.mockResolvedValue(undefined);
    c.link.close();
    expect(invoke).toHaveBeenLastCalledWith("frames_close", { id: 3 });
    expect(wv.listeners.size).toBe(0);
  });

  it("closes nothing in the app when frames_open fails", async () => {
    invoke.mockRejectedValueOnce(new Error("no window"));
    await expect(connectNative(64, 32)).rejects.toThrow("no window");
    expect(calls()).toEqual(["frames_open"]);
    expect(wv.listeners.size).toBe(0);
  });

  it("closes the app's socket transport when the page cannot connect to it", async () => {
    FakeSocket.refuse = true;
    invoke.mockResolvedValueOnce(opened("websocket", 9)).mockResolvedValue(undefined);
    await expect(connectNative(64, 32)).rejects.toThrow("refused");
    expect(invoke).toHaveBeenLastCalledWith("frames_close", { id: 9 });
  });
});
