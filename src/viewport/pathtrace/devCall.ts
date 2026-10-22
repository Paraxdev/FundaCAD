// For ?tracer=native-dev outside the app, over tracer_serve's socket (src-tauri/tracer/examples/tracer_serve.rs).
// A Uint8Array argument goes as one binary message: [u32 LE id][u16 LE command length][command][body].

import type { Call } from "./nativeScene";

export type DevCall = Call & { close(): void };

interface Reply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

const encoder = new TextEncoder();

function binary(id: number, cmd: string, body: Uint8Array): Uint8Array {
  const name = encoder.encode(cmd);
  const out = new Uint8Array(6 + name.length + body.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, id, true);
  v.setUint16(4, name.length, true);
  out.set(name, 6);
  out.set(body, 6 + name.length);
  return out;
}

/** Opens the socket on the first call and again after it closed; calls made before it opens wait.
 *  Errors reject with the plain message, as Tauri's invoke does. */
export function wsCall(url: string): DevCall {
  let ws: WebSocket | null = null;
  let id = 0;
  let queued: (string | Uint8Array)[] = [];
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (why: string) => void }>();

  const failAll = (why: string) => {
    queued = [];
    for (const p of pending.values()) p.fail(why);
    pending.clear();
  };

  const socket = (): WebSocket => {
    if (ws && ws.readyState <= WebSocket.OPEN) return ws;
    const s = new WebSocket(url);
    s.binaryType = "arraybuffer";
    s.onopen = () => {
      for (const m of queued.splice(0)) s.send(m);
    };
    s.onerror = () => failAll("the tracer server refused the page");
    s.onclose = () => {
      if (ws === s) ws = null;
      failAll("the tracer server's socket closed");
    };
    s.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      const r = JSON.parse(e.data) as Reply;
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.ok(r.value);
      else p.fail(r.error ?? "the tracer server failed");
    };
    ws = s;
    return s;
  };

  const call = ((cmd: string, args?: unknown) =>
    new Promise<unknown>((ok, fail) => {
      const n = ++id;
      const s = socket();
      const m = args instanceof Uint8Array ? binary(n, cmd, args) : JSON.stringify({ id: n, cmd, args: args ?? {} });
      pending.set(n, { ok, fail });
      if (s.readyState === WebSocket.OPEN) s.send(m);
      else queued.push(m);
    })) as DevCall;
  call.close = () => {
    ws?.close();
    ws = null;
  };
  return call;
}
