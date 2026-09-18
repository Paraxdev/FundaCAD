// How requests reach the geometry engine and its frames come back. The Geometry
// client owns the protocol (pending calls, streams, assembly); a transport only
// moves whole messages, text JSON or binary frames, exactly as PROTOCOL.md
// defines them, so both engines and both transports share one client.

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
}

/** The Python sidecar, and `fundacad --engine --ws`, on a loopback socket. */
export class WebSocketTransport implements GeometryTransport {
  private ws: WebSocket | null = null;
  private token = "";
  private sink: TransportSink | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500; // ms; doubles on each failed attempt, capped, reset on open

  constructor(private readonly url = "ws://127.0.0.1:8765") {}

  async start(sink: TransportSink): Promise<void> {
    this.sink = sink;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      this.token = await invoke<string>("sidecar_token");
    } catch {
      // Plain browser, no Tauri. DEV builds accept a token on the URL so the app
      // can be driven against a hand-started engine (demo capture, e2e); a
      // production bundle keeps "" and simply has no engine.
      this.token = import.meta.env.DEV
        ? (new URLSearchParams(location.search).get("token") ?? "")
        : "";
    }
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
    const ws = new WebSocket(`${this.url}/?token=${encodeURIComponent(this.token)}`);
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

/** The Rust engine worker the app supervises (src-tauri/src/engine.rs), through
 *  Tauri IPC. Frames arrive on one channel as raw bytes, a leading kind byte
 *  (1 text, 2 binary) followed by the message, so a mesh never passes through
 *  JSON or base64. */
export class IpcTransport implements GeometryTransport {
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

/** The engine this app was built with: an app built with the Rust engine
 *  answers `engine_kind`, everything else (the Python sidecar, a plain browser)
 *  is "python". */
export async function engineKind(): Promise<"rust" | "python"> {
  if (!("__TAURI_INTERNALS__" in globalThis)) return "python";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string>("engine_kind")) === "rust" ? "rust" : "python";
  } catch {
    // no such command, a Python sidecar build
    return "python";
  }
}

/** IPC to the Rust engine's worker, or the WebSocket every other engine speaks. */
export class EngineTransport implements GeometryTransport {
  private inner: GeometryTransport = new WebSocketTransport();

  async start(sink: TransportSink): Promise<void> {
    if ((await engineKind()) === "rust") this.inner = new IpcTransport();
    await this.inner.start(sink);
  }

  get open(): boolean {
    return this.inner.open;
  }

  send(raw: string): void {
    this.inner.send(raw);
  }
}
