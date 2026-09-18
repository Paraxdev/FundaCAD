import { afterEach, describe, expect, it, vi } from "vitest";

// The Rust engine's transport, against a fake Tauri host: frames come back on
// one channel with a kind byte, the engine's up/down state drives open/closed.

const host = vi.hoisted(() => ({
  channel: null as null | { onmessage: (b: ArrayBuffer) => void },
  state: null as null | ((e: { payload: boolean }) => void),
  sent: [] as Uint8Array[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (b: ArrayBuffer) => void = () => {};
    constructor() {
      host.channel = this;
    }
  },
  invoke: async (cmd: string, arg: unknown) => {
    if (cmd === "engine_attach") return true;
    if (cmd === "engine_send") host.sent.push(arg as Uint8Array);
    return undefined;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_: string, fn: (e: { payload: boolean }) => void) => {
    host.state = fn;
    return () => {};
  },
}));

import { EngineTransport, IpcTransport, type TransportSink } from "../../src/geometry/transport";

function sink() {
  const log: (string | ArrayBuffer | "open" | "closed")[] = [];
  const s: TransportSink = {
    opened: () => log.push("open"),
    message: (d) => log.push(d),
    closed: () => log.push("closed"),
  };
  return { s, log };
}

function withKind(kind: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(payload.length + 1);
  out[0] = kind;
  out.set(payload, 1);
  return out.buffer;
}

afterEach(() => {
  host.channel = null;
  host.state = null;
  host.sent = [];
  delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("IpcTransport", () => {
  it("opens when the engine is up and hands text and binary frames over without the kind byte", async () => {
    const t = new IpcTransport();
    const { s, log } = sink();
    await t.start(s);
    expect(t.open).toBe(true);
    host.channel!.onmessage(withKind(1, new TextEncoder().encode('{"id":"a"}')));
    host.channel!.onmessage(withKind(2, new Uint8Array([4, 0, 0, 0, 9])));
    expect(log[0]).toBe("open");
    expect(log[1]).toBe('{"id":"a"}');
    expect(Array.from(new Uint8Array(log[2] as ArrayBuffer))).toEqual([4, 0, 0, 0, 9]);
  });

  it("closes when the engine goes down and reopens when it is back", async () => {
    const t = new IpcTransport();
    const { s, log } = sink();
    await t.start(s);
    host.state!({ payload: false });
    expect(t.open).toBe(false);
    host.state!({ payload: false });
    host.state!({ payload: true });
    expect(log).toEqual(["open", "closed", "open"]);
  });

  it("sends a request as UTF-8 bytes", async () => {
    const t = new IpcTransport();
    await t.start(sink().s);
    t.send('{"op":"ping","id":"é"}');
    await Promise.resolve();
    expect(new TextDecoder().decode(host.sent[0])).toBe('{"op":"ping","id":"é"}');
  });
});

describe("EngineTransport", () => {
  it("uses IPC inside the app", async () => {
    (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const t = new EngineTransport();
    await t.start(sink().s);
    expect(host.channel).not.toBeNull();
    expect(t.open).toBe(true);
  });

  it("dials the loopback WebSocket in a plain browser, with the token from the URL", async () => {
    vi.stubGlobal("location", { search: "?token=t" });
    const opened: string[] = [];
    const fake = vi.fn(function (this: { readyState: number }, url: string) {
      opened.push(url);
      this.readyState = 0;
    });
    vi.stubGlobal("WebSocket", Object.assign(fake, { OPEN: 1 }));
    const t = new EngineTransport();
    await t.start(sink().s);
    expect(host.channel).toBeNull();
    expect(opened).toEqual(["ws://127.0.0.1:8765/?token=t"]);
    vi.unstubAllGlobals();
  });
});
