// Frames rendered on the native side (src-tauri/frames), drawn into a canvas
// under the viewport's overlays. Windows reads WebView2 shared buffers the app
// posts, pulled with one tiny invoke per frame; elsewhere frames stream over a
// loopback WebSocket. Pixels never cross Tauri IPC.
//
// Until the native tracer lands the frames are a moving test pattern, so the
// tracing calls only restart the sample count.

import { invoke } from "@tauri-apps/api/core";
import type * as THREE from "three";
import type { Denoise } from "../../ui/renderPrefs";
import type { PictureOptions, TraceLook, TraceScene, TracerBackend } from "./backend";
import type { TraceLens } from "./camera";
import { NativeScene, type Call } from "./nativeScene";
import { runSelfCheck } from "./selfCheck";
import { bloomKey, bloomSide, type TraceBloomSettings } from "./tracePost";

export interface NativeFrame {
  seq: number;
  generation: number;
  width: number;
  height: number;
  /** Rows top first, RGBA8, no padding. Valid until `release`. */
  pixels: Uint8Array;
  /** The page is done with the frame's buffer. */
  release(): void;
}

export interface FrameLink {
  readonly kind: string;
  next(): Promise<NativeFrame>;
  /** Resolves with the generation frames of the new size carry. */
  resize(width: number, height: number): Promise<number>;
  close(): void;
}

export interface Connected {
  link: FrameLink;
  generation: number;
  source: string;
}

export interface Blit {
  upload(frame: NativeFrame): void;
  readonly maxTextureSize: number;
  dispose(): void;
}

export interface NativeTracerOptions {
  /** "websocket" skips the shared buffers. */
  prefer?: string | undefined;
  connect?: (width: number, height: number, prefer?: string) => Promise<Connected>;
  blit?: (canvas: HTMLCanvasElement) => Blit;
  canvas?: HTMLCanvasElement;
  /** The pt_* commands; Tauri's invoke unless a test stands in. */
  call?: Call;
}

const HEADER_BYTES = 16;
const BUFFER_WAIT_MS = 2000;
/** One resize per settled drag, each one reallocates the native buffers. */
const RESIZE_SETTLE_MS = 150;
const LOG_EVERY = 240;
/** The app refuses larger frames (MAX_SIDE in src-tauri/frames), the canvas scales up. */
const MAX_SIDE = 8192;

interface Opened {
  id: number;
  kind: "sharedbuffer" | "websocket";
  generation: number;
  port: number | null;
  token: string | null;
  source: string;
}

interface Next {
  index: number;
  generation: number;
  seq: number;
  width: number;
  height: number;
}

interface SharedBufferEvent extends Event {
  additionalData: { frames?: number; i: number; g: number } | null;
  getBuffer(): ArrayBuffer;
}

interface WebView2 {
  addEventListener(type: "sharedbufferreceived", cb: (e: SharedBufferEvent) => void): void;
  removeEventListener(type: "sharedbufferreceived", cb: (e: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}

function webview2(): WebView2 | null {
  const w = (globalThis as { chrome?: { webview?: WebView2 } }).chrome?.webview;
  return w && typeof w.releaseBuffer === "function" ? w : null;
}

/** The app's shared buffers: held per generation and index, the old ones
 *  released once a newer generation arrives. */
export class SharedBufferLink implements FrameLink {
  readonly kind = "sharedbuffer";
  private buffers = new Map<string, { g: number; buf: ArrayBuffer }>();
  private newest = 0;
  private waiters = new Set<() => void>();
  private done: [number, number][] = [];
  /** The app's name for the transport, set once frames_open answers. */
  id = 0;

  constructor(private wv: WebView2) {
    wv.addEventListener("sharedbufferreceived", this.onBuffer);
  }

  private onBuffer = (e: SharedBufferEvent) => {
    const d = e.additionalData;
    if (!d || d.frames !== 1) return;
    const buf = e.getBuffer();
    if (d.g < this.newest) {
      this.wv.releaseBuffer(buf);
      return;
    }
    this.newest = d.g;
    for (const [k, v] of this.buffers) {
      if (v.g < d.g) {
        this.wv.releaseBuffer(v.buf);
        this.buffers.delete(k);
      }
    }
    this.buffers.set(`${d.g}:${d.i}`, { g: d.g, buf });
    for (const w of this.waiters) w();
  };

  private buffer(g: number, i: number): Promise<ArrayBuffer | null> {
    const look = () => (g < this.newest ? null : this.buffers.get(`${g}:${i}`)?.buf);
    const now = look();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        fail(new Error("the app never posted the frame buffer"));
      }, BUFFER_WAIT_MS);
      const check = () => {
        const b = look();
        if (b === undefined) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        ok(b);
      };
      this.waiters.add(check);
    });
  }

  async next(): Promise<NativeFrame> {
    const r = await invoke<Next>("frames_next", { release: this.done.splice(0) });
    const buf = await this.buffer(r.generation, r.index);
    const bytes = r.width * r.height * 4;
    const pixels = buf && buf.byteLength >= bytes ? new Uint8Array(buf, 0, bytes) : new Uint8Array(0);
    let released = false;
    return {
      ...r,
      pixels,
      release: () => {
        if (released) return;
        released = true;
        this.done.push([r.index, r.generation]);
      },
    };
  }

  resize(width: number, height: number): Promise<number> {
    return invoke<number>("frames_resize", { width, height });
  }

  /** Stops listening and lets go of the buffers, the app side stays open. */
  detach() {
    this.wv.removeEventListener("sharedbufferreceived", this.onBuffer);
    for (const v of this.buffers.values()) this.wv.releaseBuffer(v.buf);
    this.buffers.clear();
  }

  close() {
    this.detach();
    void invoke("frames_close", { id: this.id }).catch(() => {});
  }
}

/** The page pulls: each "next" is answered by one binary message, a 16 byte
 *  header (seq, generation, width, height) then the pixels. */
export class WebSocketLink implements FrameLink {
  readonly kind = "websocket";
  private waiting: { ok: (f: NativeFrame) => void; fail: (e: Error) => void }[] = [];

  private constructor(
    private ws: WebSocket,
    private id: number,
  ) {
    ws.onmessage = (e) => {
      const w = this.waiting.shift();
      if (!w || !(e.data instanceof ArrayBuffer)) return;
      const v = new DataView(e.data);
      w.ok({
        seq: v.getUint32(0, true),
        generation: v.getUint32(4, true),
        width: v.getUint32(8, true),
        height: v.getUint32(12, true),
        pixels: new Uint8Array(e.data, HEADER_BYTES),
        release: () => {},
      });
    };
    ws.onclose = () => {
      for (const w of this.waiting.splice(0)) w.fail(new Error("the frame socket closed"));
    };
  }

  static open(port: number, token: string, id: number): Promise<WebSocketLink> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ok(new WebSocketLink(ws, id));
      ws.onerror = () => fail(new Error("the frame socket refused the page"));
    });
  }

  next(): Promise<NativeFrame> {
    return new Promise((ok, fail) => {
      if (this.ws.readyState !== WebSocket.OPEN) return fail(new Error("the frame socket closed"));
      this.waiting.push({ ok, fail });
      this.ws.send("next");
    });
  }

  /** Timings for the app's log. */
  note(text: string) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(`note ${text}`);
  }

  resize(width: number, height: number): Promise<number> {
    return invoke<number>("frames_resize", { width, height });
  }

  close() {
    this.ws.close();
    void invoke("frames_close", { id: this.id }).catch(() => {});
  }
}

/** Shared buffers listen before frames_open, which posts the first three. */
export async function connectNative(width: number, height: number, prefer?: string): Promise<Connected> {
  const wv = prefer === "websocket" ? null : webview2();
  const shared = wv ? new SharedBufferLink(wv) : null;
  let o: Opened;
  try {
    o = await invoke<Opened>("frames_open", { width, height, prefer: prefer ?? null });
  } catch (e) {
    shared?.detach();
    throw e;
  }
  if (o.kind === "sharedbuffer" && shared) {
    shared.id = o.id;
    return { link: shared, generation: o.generation, source: o.source };
  }
  shared?.detach();
  if (o.port == null || o.token == null) throw new Error("the app opened no frame transport");
  try {
    return { link: await WebSocketLink.open(o.port, o.token, o.id), generation: o.generation, source: o.source };
  } catch (e) {
    void invoke("frames_close", { id: o.id }).catch(() => {});
    throw e;
  }
}

const VERT = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D img;
in vec2 uv;
out vec4 color;
void main() { color = texture(img, uv); }`;

export function glBlit(canvas: HTMLCanvasElement): Blit {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, premultipliedAlpha: false });
  if (!gl) throw new Error("no WebGL2 for the native frames");
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let w = 0;
  let h = 0;
  return {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    upload(f) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (f.width !== w || f.height !== h) {
        w = canvas.width = f.width;
        h = canvas.height = f.height;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.pixels);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, f.pixels);
      }
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteProgram(prog);
    },
  };
}

interface Status {
  samples: number;
  fault: string | null;
  denoised: boolean;
  denoising: boolean;
  denoiseError: string | null;
  picture?: { samples: number; total: number; denoising: boolean } | null;
}

const PICTURE_POLL_MS = 250;

/** What a raw ipc::Response arrives as. */
function base64(bytes: unknown): string {
  const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as number[]);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export class NativeTracer implements TracerBackend {
  readonly canvas: HTMLCanvasElement;
  readonly maxStorageBytes = Infinity;
  private shownDenoised = false;
  /** The cap's denoise is still to come, or done (nothing more to draw). */
  private settle: "wait" | "done" = "wait";
  private polling: Promise<void> | null = null;
  private epoch = 0;
  private kicked = false;
  private link: FrameLink | null = null;
  private blit: Blit | null = null;
  private generation = 0;
  private pending: Promise<NativeFrame> | null = null;
  private count = 0;
  private faultCb: ((why: string) => void) | null = null;
  private width = 1;
  private height = 1;
  private scale = 1;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private times: number[] = [];
  private source = "";
  private disposed = false;
  private bloom: TraceBloomSettings | null = null;
  /** The bloom the native side holds, null until this page told it. */
  private bloomShared: string | null = null;
  private bloomSent: Promise<unknown> = Promise.resolve();
  readonly scene: NativeScene;

  constructor(private o: NativeTracerOptions = {}) {
    this.canvas = o.canvas ?? document.createElement("canvas");
    this.scene = new NativeScene(o.call ?? ((cmd, args) => invoke(cmd, args as never)), (e) =>
      this.fault(`The native tracer refused the scene: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  get name(): string {
    return `native ${this.link?.kind ?? ""}${this.source ? ` (${this.source})` : ""}`.trim();
  }

  get maxTextureSize(): number {
    return this.blit?.maxTextureSize ?? 8192;
  }

  async init() {
    this.blit = (this.o.blit ?? glBlit)(this.canvas);
    const c = await (this.o.connect ?? connectNative)(this.width, this.height, this.o.prefer);
    if (this.disposed) {
      c.link.close();
      return;
    }
    this.link = c.link;
    this.generation = c.generation;
    this.source = c.source;
    // The native tracer outlives a page, so a bloom of the last one is cleared.
    this.syncBloom();
    // After the connect, which is what opens the native tracer the check borrows its path from.
    await runSelfCheck((cmd, args) => this.call(cmd, args as Record<string, unknown>));
  }

  setSize(cssWidth: number, cssHeight: number, pixelRatio: number) {
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.width = Math.min(MAX_SIDE, Math.max(1, Math.floor(cssWidth * pixelRatio)));
    this.height = Math.min(MAX_SIDE, Math.max(1, Math.floor(cssHeight * pixelRatio)));
    this.queueResize();
  }

  setRenderScale(scale: number) {
    this.scale = scale > 0 ? scale : 1;
    this.queueResize();
  }

  private queueResize() {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.syncBloom();
      const w = Math.max(1, Math.floor(this.width * this.scale));
      const h = Math.max(1, Math.floor(this.height * this.scale));
      this.link?.resize(w, h).then(
        (g) => {
          this.generation = Math.max(this.generation, g);
          this.reset();
        },
        (e) => this.fault(`The native frames could not resize: ${String(e)}`),
      );
    }, RESIZE_SETTLE_MS);
  }

  setScene(scene: TraceScene, camera: THREE.Camera) {
    void this.scene.look(scene);
    void this.scene.camera(camera, scene.lens);
    void this.scene.setMeshes(scene.meshes);
    this.reset();
  }
  updateGeometry(meshes: THREE.Mesh[]) {
    void this.scene.setMeshes(meshes);
    this.reset();
  }
  updateTransforms() {
    void this.scene.refresh();
    this.reset();
  }
  updateMaterials() {
    void this.scene.refresh();
    this.reset();
  }
  updateLook(look: TraceLook) {
    void this.scene.look(look);
    this.reset();
  }
  updateCamera(camera: THREE.Camera, lens: TraceLens | null) {
    void this.scene.camera(camera, lens);
    this.reset();
  }
  reset() {
    this.count = 0;
    this.shownDenoised = false;
    this.settle = "wait";
    this.kicked = false;
    this.epoch++;
  }
  setFrameBudget(slots: number) {
    void this.scene.budget(slots);
  }
  setCap(samples: number) {
    void this.scene.cap(samples);
  }
  setDenoise(level: Denoise) {
    void this.scene.denoise(level);
    this.reset();
  }

  /** The native side blooms before its tone mapping, the page's frames are
   *  already tone mapped. At the cap the held frame is pulled again. */
  setBloom(bloom: TraceBloomSettings | null) {
    this.bloom = bloom;
    if (this.syncBloom() && this.settle === "done") this.redraw();
  }

  private syncBloom(): boolean {
    if (!this.link || this.disposed) return false;
    const side = bloomSide(this.width, this.height);
    const key = this.bloom ? `${bloomKey(this.bloom)}:${side}` : "";
    if (key === this.bloomShared) return false;
    this.bloomShared = key;
    this.bloomSent = this.scene.bloom(this.bloom && { ...this.bloom, side });
    this.kicked = false;
    return true;
  }

  /** The first frame pulled can be the prefetch from before the change. */
  private redraw() {
    const g = this.epoch;
    const live = () => this.epoch === g && !this.disposed && !!this.link;
    const p: Promise<void> = (this.polling ?? Promise.resolve())
      .then(async () => {
        await this.bloomSent;
        if (live()) await this.renderSample(0);
        if (live()) await this.renderSample(0);
      })
      .catch(() => {})
      .finally(() => {
        if (this.polling === p) this.polling = null;
      });
    this.polling = p;
  }

  private request(): Promise<NativeFrame> {
    const p = this.link!.next();
    // A prefetch nobody awaits yet must not count as unhandled.
    p.catch(() => {});
    return p;
  }

  /** Keeps a second frame in flight, so the app renders the next one while
   *  this one uploads. */
  async renderSample(_samples: number): Promise<number> {
    if (!this.link || !this.blit) throw new Error("the native tracer is not open");
    const t0 = performance.now();
    let frame: NativeFrame;
    try {
      frame = await (this.pending ?? this.request());
      this.pending = this.disposed ? null : this.request();
    } catch (e) {
      this.pending = null;
      this.fault(`The native frames stopped: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    try {
      const whole = frame.pixels.byteLength >= frame.width * frame.height * 4 && frame.width > 0;
      if (frame.generation >= this.generation && whole && !this.disposed) {
        this.blit.upload(frame);
        this.count++;
      }
    } finally {
      frame.release();
    }
    const ms = performance.now() - t0;
    this.log(ms);
    return ms;
  }

  private log(ms: number) {
    this.times.push(ms);
    if (this.times.length < LOG_EVERY) return;
    const sorted = this.times.sort((a, b) => a - b);
    const p50 = (sorted[sorted.length >> 1] ?? 0).toFixed(1);
    this.times = [];
    const line = `${this.link?.kind} p50 ${p50} ms per frame`;
    console.info(`[native tracer] ${line}`);
    if (this.link instanceof WebSocketLink) this.link.note(line);
  }

  /** Traced on the native side into an accumulation of its own, so the
   *  viewport's samples stay; the PNG comes back as bytes. */
  async picture(o: PictureOptions): Promise<string> {
    const cancelled = () => new DOMException("The picture was cancelled", "AbortError");
    if (o.signal?.aborted) throw cancelled();
    await this.scene.idle();
    await this.bloomSent;
    const abort = () => void this.call("pt_picture_cancel").catch(() => {});
    o.signal?.addEventListener("abort", abort, { once: true });
    let running = true;
    void (async () => {
      while (running) {
        await new Promise((r) => setTimeout(r, PICTURE_POLL_MS));
        if (!running) return;
        const s = (await this.call("pt_status").catch(() => null)) as Status | null;
        if (running && s?.picture) o.onProgress?.(Math.min(s.picture.samples, o.samples));
      }
    })();
    try {
      if (o.signal?.aborted) throw cancelled();
      const png = await this.call("pt_picture", { width: o.width, height: o.height, samples: o.samples });
      if (o.signal?.aborted) throw cancelled();
      o.onProgress?.(o.samples);
      return `data:image/png;base64,${base64(png)}`;
    } catch (e) {
      if (o.signal?.aborted) throw cancelled();
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      running = false;
      o.signal?.removeEventListener("abort", abort);
    }
  }

  get denoised(): boolean {
    return this.shownDenoised;
  }

  /** At the cap the native side denoises on its own thread; this asks after
   *  it and pulls the denoised frame once it is held. The frame prefetched
   *  before it landed is still the raw one, so two are pulled. A new denoise
   *  level at the cap starts no denoise until a frame is asked for. */
  present(): boolean {
    if (this.settle === "done" || this.disposed) return false;
    this.polling ??= this.pollDenoise().finally(() => (this.polling = null));
    return true;
  }

  private async pollDenoise() {
    const g = this.epoch;
    await this.bloomSent;
    let s: Status;
    try {
      s = (await this.call("pt_status")) as Status;
    } catch {
      this.settle = "done";
      return;
    }
    if (this.epoch !== g || this.disposed) return;
    if (s.denoised) {
      await this.renderSample(0);
      await this.renderSample(0);
      if (this.epoch !== g || this.disposed) return;
      this.shownDenoised = true;
      this.settle = "done";
    } else if (!s.denoising && !this.kicked) {
      this.kicked = true;
      await this.renderSample(0);
      await this.renderSample(0);
    } else if (!s.denoising) {
      if (s.denoiseError) console.warn(`[native tracer] denoise: ${s.denoiseError}`);
      this.settle = "done";
    }
  }

  async samples(): Promise<number> {
    let s: Status;
    try {
      s = (await this.call("pt_status")) as typeof s;
    } catch (e) {
      this.fault(`The native tracer stopped: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    if (s.fault) this.fault(`The native tracer stopped: ${s.fault}`);
    return s.samples;
  }

  private call(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.o.call ? this.o.call(cmd, args) : invoke(cmd, args as never);
  }

  onFault(cb: (why: string) => void) {
    this.faultCb = cb;
  }

  private fault(why: string) {
    if (!this.disposed) this.faultCb?.(why);
  }

  dispose() {
    this.disposed = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.pending = null;
    this.link?.close();
    this.link = null;
    this.blit?.dispose();
    this.blit = null;
    this.canvas.remove?.();
  }
}

export function createNativeTracer(o: NativeTracerOptions = {}): Promise<TracerBackend> {
  const t = new NativeTracer(o);
  return t.init().then(() => t);
}
