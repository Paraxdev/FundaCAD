// How requests reach the engine and frames come back. A transport only moves whole messages as PROTOCOL.md
// defines them; the Geometry client owns the protocol, so both transports share it.

export interface TransportSink {
  opened(): void;
  message(data: string | ArrayBuffer): void;
  /** Every in-flight call is lost. `tooBig` when the engine refused a message
   *  for its size, so the client can say that instead of "connection lost". */
  closed(tooBig: boolean): void;
}

export interface GeometryTransport {
  /** Begins connecting and keeps reconnecting on its own. Called once. */
  start(sink: TransportSink): Promise<void>;
  send(raw: string): void;
  readonly open: boolean;
  /** Whether the engine behind it takes a soft cancel, see GeometryBackend.softCancel. */
  readonly softCancel?: boolean;
}

const DEFAULT_ENGINE_PORT = 8765;

/** The engine socket. DEV builds take `?engine=<port>` so the agent harness can
 *  reach a private engine; only a loopback port is accepted. */
export function engineUrl(search: string, dev: boolean): string {
  let port = DEFAULT_ENGINE_PORT;
  if (dev) {
    const raw = new URLSearchParams(search).get("engine") ?? "";
    const n = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
    if (n >= 1 && n <= 65535) port = n;
  }
  return `ws://127.0.0.1:${port}`;
}

/** `fundacad-engine --ws` (or `fundacad --engine --ws`) on a loopback socket,
 *  for a plain browser in development and the e2e scripts. */
export class WebSocketTransport implements GeometryTransport {
  readonly softCancel = true;
  private ws: WebSocket | null = null;
  private token = "";
  private sink: TransportSink | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500; // ms; doubles on each failed attempt, capped, reset on open

  constructor(private url?: string) {}

  async start(sink: TransportSink): Promise<void> {
    this.sink = sink;
    this.url ??= engineUrl(location.search, import.meta.env.DEV);
    // DEV builds take the token from the URL (`?token=`), so the app can be
    // driven against a hand-started engine; a production bundle keeps "".
    this.token = import.meta.env.DEV ? (new URLSearchParams(location.search).get("token") ?? "") : "";
    this.connect();
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(raw: string): void {
    this.ws!.send(raw);
  }

  private connect() {
    const sink = this.sink!;
    const ws = new WebSocket(`${this.url!}/?token=${encodeURIComponent(this.token)}`);
    ws.binaryType = "arraybuffer"; // binary mesh frames (default "blob" would need async reads)
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 500;
      sink.opened();
    };
    ws.onmessage = (e) => sink.message(e.data as string | ArrayBuffer);
    // 1009 = "message too big": the engine refused a frame past its max_size.
    ws.onclose = (ev) => {
      sink.closed(ev.code === 1009);
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }
}

/** The Rust engine worker (src-tauri/src/engine.rs) over Tauri IPC. Frames arrive as raw bytes with a leading
 *  kind byte (1 text, 2 binary), so a mesh never passes through JSON or base64. */
export class IpcTransport implements GeometryTransport {
  readonly softCancel = true;
  private up = false;
  private sink: TransportSink | null = null;
  private invoke: (typeof import("@tauri-apps/api/core"))["invoke"] | null = null;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  async start(sink: TransportSink): Promise<void> {
    this.sink = sink;
    const core = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    this.invoke = core.invoke;
    const channel = new core.Channel<ArrayBuffer>();
    channel.onmessage = (buf) => this.deliver(buf);
    await listen<boolean>("engine:state", (e) => this.setUp(e.payload === true));
    this.setUp(await core.invoke<boolean>("engine_attach", { channel }));
  }

  get open(): boolean {
    return this.up;
  }

  send(raw: string): void {
    void this.invoke!("engine_send", this.encoder.encode(raw)).catch((err) => {
      console.error("[geometry] engine_send failed:", err);
      let id: unknown;
      try {
        id = (JSON.parse(raw) as { id?: unknown }).id;
      } catch {
        return;
      }
      if (typeof id !== "string") return;
      const message = `the geometry engine did not take the request: ${String(err)}`;
      this.sink?.message(JSON.stringify({ id, ok: false, error: { message } }));
    });
  }

  private setUp(up: boolean) {
    if (up === this.up) return;
    this.up = up;
    if (up) this.sink!.opened();
    else this.sink!.closed(false);
  }

  private deliver(buf: ArrayBuffer) {
    const bytes = new Uint8Array(buf);
    if (bytes.length === 0) return;
    if (bytes[0] === 1) this.sink!.message(this.decoder.decode(bytes.subarray(1)));
    else this.sink!.message(buf.slice(1));
  }
}

/** IPC to the app's engine worker, or the WebSocket in a plain browser. */
export class EngineTransport implements GeometryTransport {
  private inner: GeometryTransport = new WebSocketTransport();

  async start(sink: TransportSink): Promise<void> {
    if ("__TAURI_INTERNALS__" in globalThis) this.inner = new IpcTransport();
    await this.inner.start(sink);
  }

  get open(): boolean {
    return this.inner.open;
  }

  get softCancel(): boolean {
    return this.inner.softCancel === true;
  }

  send(raw: string): void {
    this.inner.send(raw);
  }
}
