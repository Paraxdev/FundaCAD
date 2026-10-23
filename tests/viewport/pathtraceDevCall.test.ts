import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { wsCall } from "../../src/viewport/pathtrace/devCall";
import { connectNative, WebSocketLink } from "../../src/viewport/pathtrace/nativeTracer";
import { probeNative } from "../../src/viewport/pathtrace/probe";

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  static refuse = false;
  readyState = 0;
  binaryType = "";
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  /** Settles the handshake. */
  accept() {
    if (FakeSocket.refuse) {
      this.readyState = 3;
      this.onerror?.();
      this.onclose?.();
      return;
    }
    this.readyState = 1;
    this.onopen?.();
  }
  send(m: string | ArrayBufferView) {
    this.sent.push(typeof m === "string" ? m : new Uint8Array(m.buffer, m.byteOffset, m.byteLength).slice());
  }
  reply(r: unknown) {
    this.onmessage?.({ data: JSON.stringify(r) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** The command socket's requests, decoded. */
function sentRequests(s: FakeSocket) {
  return s.sent.map((m) => {
    if (typeof m === "string") return JSON.parse(m) as { id: number; cmd: string; args?: unknown };
    const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
    const n = v.getUint16(4, true);
    return {
      id: v.getUint32(0, true),
      cmd: new TextDecoder().decode(m.subarray(6, 6 + n)),
      body: [...m.subarray(6 + n)],
    };
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the WebSocket call to the dev tracer server", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    invoke.mockReset();
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  afterEach(() => {
    FakeSocket.refuse = false;
    vi.unstubAllGlobals();
  });

  it("sends JSON args as text and raw bodies as one framed binary message", async () => {
    const call = wsCall("ws://127.0.0.1:9/?token=t");
    const a = call("pt_cap", { cap: 64 });
    const b = call("pt_mesh", new Uint8Array([7, 8, 9]));
    const s = FakeSocket.all[0]!;
    expect(s.url).toBe("ws://127.0.0.1:9/?token=t");
    expect(s.sent).toEqual([]);
    s.accept();
    const [ra, rb] = sentRequests(s);
    expect(ra).toEqual({ id: 1, cmd: "pt_cap", args: { cap: 64 } });
    expect(rb).toEqual({ id: 2, cmd: "pt_mesh", body: [7, 8, 9] });
    s.reply({ id: 2, ok: true, value: null });
    s.reply({ id: 1, ok: true, value: ["k"] });
    await expect(a).resolves.toEqual(["k"]);
    await expect(b).resolves.toBeNull();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("rejects with the server's plain message, as Tauri's invoke does", async () => {
    const call = wsCall("ws://127.0.0.1:9/?token=t");
    const a = call("pt_scene", { bodies: [] });
    FakeSocket.all[0]!.accept();
    FakeSocket.all[0]!.reply({ id: 1, ok: false, error: "the native tracer is not open" });
    await expect(a).rejects.toBe("the native tracer is not open");
  });

  it("fails every pending call when the socket closes, and opens a new one for the next", async () => {
    const call = wsCall("ws://127.0.0.1:9/?token=t");
    const a = call("pt_status");
    const b = call("pt_status");
    FakeSocket.all[0]!.accept();
    FakeSocket.all[0]!.close();
    await expect(a).rejects.toMatch(/closed/);
    await expect(b).rejects.toMatch(/closed/);
    const c = call("pt_status");
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.accept();
    FakeSocket.all[1]!.reply({ id: sentRequests(FakeSocket.all[1]!)[0]!.id, ok: true, value: { samples: 3 } });
    await expect(c).resolves.toEqual({ samples: 3 });
  });

  it("fails the calls queued behind a refused socket", async () => {
    FakeSocket.refuse = true;
    const call = wsCall("ws://127.0.0.1:9/?token=bad");
    const a = call("pt_probe");
    FakeSocket.all[0]!.accept();
    await expect(a).rejects.toMatch(/refused|closed/);
  });

  it("carries frames_open, resize and close of the native frames instead of Tauri", async () => {
    const seen: [string, unknown][] = [];
    const call = async (cmd: string, args?: unknown) => {
      seen.push([cmd, args]);
      if (cmd === "frames_open")
        return { id: 4, kind: "websocket", generation: 1, port: 77, token: "ft", source: "tracer" };
      if (cmd === "frames_resize") return 2;
      return null;
    };
    const opening = connectNative(64, 32, "websocket", call);
    await flush();
    const frames = FakeSocket.all[0]!;
    expect(frames.url).toBe("ws://127.0.0.1:77/?token=ft");
    frames.accept();
    const c = await opening;
    expect(c.link).toBeInstanceOf(WebSocketLink);
    await expect(c.link.resize(20, 10)).resolves.toBe(2);
    c.link.close();
    expect(seen).toEqual([
      ["frames_open", { width: 64, height: 32, prefer: "websocket" }],
      ["frames_resize", { width: 20, height: 10 }],
      ["frames_close", { id: 4 }],
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("probes the dev server outside the app", async () => {
    const call = wsCall("ws://127.0.0.1:9/?token=t");
    const p = probeNative(call);
    FakeSocket.all[0]!.accept();
    FakeSocket.all[0]!.reply({ id: 1, ok: true, value: { available: true, path: "software", adapter: "llvmpipe" } });
    await expect(p).resolves.toEqual({ available: true, path: "software", adapter: "llvmpipe" });
  });
});
