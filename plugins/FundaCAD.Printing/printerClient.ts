// The printer device layer: Moonraker over the local network (Snapmaker U1 now,
// Qidi and other Moonraker machines later).
//
// This used to be Rust in the app shell. The app now offers only a generic
// request to a device on the local network (`plugin_local_request`), and every
// byte of the protocol is here: which endpoints exist, what a job upload looks
// like, how status and filament state are read out of the replies.
//
// Facts pinned to the U1's shipped firmware (fw 1.3.0, verified against
// Snapmaker's open-sourced u1-moonraker/u1-klipper): LAN is fully trusted (no
// API key), filament state lives in the `print_task_config` printer object, and
// a job is sent by POST /server/files/upload then POST
// /server/files/start_local_print with a `map_table` filament remap.

import { readSetting } from "fundacad";
import { dataAdopt, dataRead, dataWrite, localRequest, type LocalRequest, type LocalResponse } from "./native";

export type PrinterKind = "MoonrakerU1" | "Moonraker";

export interface PrinterConfig {
  id: string;
  name: string;
  /** bare host or IP: no scheme, slash, '@', or whitespace. */
  host: string;
  port: number;
  kind: PrinterKind;
  /** port of the printer's webcam HTTP server (the U1 ships it on :80). */
  webcam_port: number;
}

export interface ToolheadFilament {
  index: number;
  vendor: string;
  material: string;
  sub_type: string;
  color: string; // "#RRGGBB"
  present: boolean;
}

export interface PrintStatus {
  state: string; // printing | paused | complete | standby | error | ...
  filename: string;
  progress: number; // 0..1
  print_duration: number;
  total_duration: number;
}

export interface ProbeInfo {
  online: boolean;
  klippy_state: string;
  moonraker_version: string;
}

export interface StartOpts {
  bedLevel: boolean;
  flowCalibrate: boolean;
  timeLapseCamera: boolean;
}

export interface PrinterError {
  code: "Unreachable" | "Busy" | "NozzleMismatch" | "Rejected" | "Protocol" | "Config";
  message: string;
}

const fail = (code: PrinterError["code"], message: string): PrinterError => ({ code, message });

/** true when a rejection is a PrinterError. */
export function asPrinterError(e: unknown): PrinterError | null {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as PrinterError;
  return null;
}

// --- registry -----------------------------------------------------------------

const REGISTRY = "printers.json";

/** The user's two machines, seeded on first run. The Qidi's Moonraker sits on :10088. */
export const SEED: PrinterConfig[] = [
  { id: "u1", name: "Snapmaker U1", host: "192.168.0.46", port: 7125, kind: "MoonrakerU1", webcam_port: 80 },
  { id: "qidi-xplus4", name: "Qidi X-Plus 4", host: "192.168.0.76", port: 10088, kind: "Moonraker", webcam_port: 80 },
];

export function validHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && /^[A-Za-z0-9.-]+$/.test(host);
}

/** A stored list, tolerant of entries written before `webcam_port` existed. */
export function parseRegistry(text: string): PrinterConfig[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw fail("Config", `${REGISTRY}: not a list`);
  return raw.map((p: Partial<PrinterConfig>) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
    host: String(p.host ?? ""),
    port: Number(p.port ?? 0),
    kind: p.kind === "Moonraker" ? "Moonraker" : "MoonrakerU1",
    webcam_port: typeof p.webcam_port === "number" ? p.webcam_port : 80,
  }));
}

let adopted: Promise<void> | null = null;

/** The list the app shell kept in its own data directory, moved here once. */
function adoptLegacy(): Promise<void> {
  adopted ??= Promise.all([dataAdopt(REGISTRY, REGISTRY), dataAdopt("settings.json", "slicer.json")])
    .then(() => {})
    .catch(() => {
      adopted = null;
    });
  return adopted;
}

export async function readPluginFile(name: string): Promise<string | null> {
  await adoptLegacy();
  return await dataRead(name);
}

async function writeRegistry(list: PrinterConfig[]): Promise<void> {
  await dataWrite(REGISTRY, JSON.stringify(list, null, 2));
}

export async function printersList(): Promise<PrinterConfig[]> {
  const text = await readPluginFile(REGISTRY);
  if (text === null) {
    await writeRegistry(SEED);
    return SEED.map((p) => ({ ...p }));
  }
  try {
    return parseRegistry(text);
  } catch (e) {
    throw asPrinterError(e) ?? fail("Config", `${REGISTRY}: ${String(e)}`);
  }
}

export async function printersUpsert(cfg: PrinterConfig): Promise<void> {
  if (!cfg.id.trim()) throw fail("Config", "printer id required");
  if (!validHost(cfg.host)) throw fail("Config", `invalid host ${JSON.stringify(cfg.host)} (bare IP/hostname only)`);
  const list = await printersList();
  const i = list.findIndex((p) => p.id === cfg.id);
  if (i >= 0) list[i] = cfg;
  else list.push(cfg);
  await writeRegistry(list);
}

export async function printersRemove(id: string): Promise<void> {
  await writeRegistry((await printersList()).filter((p) => p.id !== id));
}

async function resolve(id: string): Promise<PrinterConfig> {
  const cfg = (await printersList()).find((p) => p.id === id);
  if (!cfg) throw fail("Config", `no printer with id ${JSON.stringify(id)}`);
  if (!validHost(cfg.host)) throw fail("Config", `invalid host ${JSON.stringify(cfg.host)}`);
  return cfg;
}

export const baseUrl = (cfg: PrinterConfig) => `http://${cfg.host}:${cfg.port}`;
export const webcamBaseUrl = (cfg: PrinterConfig) => `http://${cfg.host}:${cfg.webcam_port}`;

// --- transport ----------------------------------------------------------------

async function send(req: LocalRequest): Promise<LocalResponse> {
  try {
    return await localRequest({ timeoutMs: 10_000, ...req });
  } catch (e) {
    const msg = String(e);
    throw fail(/not on the local network|not an address|not an http/.test(msg) ? "Config" : "Unreachable", msg);
  }
}

const ok = (r: LocalResponse) => r.status >= 200 && r.status < 300;

function json(r: LocalResponse): Record<string, unknown> {
  try {
    const v = JSON.parse(r.text ?? "") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch (e) {
    throw fail("Protocol", String(e));
  }
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown, dflt = "") => (typeof v === "string" ? v : dflt);
const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** GET a printer-objects query and return `result.status`. */
async function queryStatus(base: string, objects: string): Promise<Record<string, unknown>> {
  const r = await send({ url: `${base}/printer/objects/query?${objects}` });
  if (!ok(r)) throw fail("Protocol", `HTTP ${r.status}`);
  return obj(obj(json(r).result).status);
}

/** print_task_config gives "RRGGBBAA"; take RGB. Falls back to a neutral grey. */
export function argbToHex(color: string): string {
  const s = color.replace(/^#+/, "");
  return /^[0-9a-fA-F]{6}/.test(s) ? `#${s.slice(0, 6).toUpperCase()}` : "#808080";
}

// --- commands -----------------------------------------------------------------

export async function printerProbe(id: string): Promise<ProbeInfo> {
  const cfg = await resolve(id);
  const r = await send({ url: `${baseUrl(cfg)}/server/info` });
  if (!ok(r)) throw fail("Protocol", `HTTP ${r.status}`);
  const res = obj(json(r).result);
  return {
    online: res.klippy_connected === true,
    klippy_state: str(res.klippy_state),
    moonraker_version: str(res.moonraker_version),
  };
}

export async function printerFilaments(id: string): Promise<ToolheadFilament[]> {
  const cfg = await resolve(id);
  const ptc = obj((await queryStatus(baseUrl(cfg), "print_task_config")).print_task_config);
  const arr = (k: string): unknown[] => (Array.isArray(ptc[k]) ? (ptc[k] as unknown[]) : []);
  const vendors = arr("filament_vendor");
  const types = arr("filament_type");
  const subs = arr("filament_sub_type");
  const colors = arr("filament_color_rgba");
  const exists = arr("filament_exist");
  const n = Math.max(types.length, colors.length);
  if (n === 0) throw fail("Protocol", "printer returned no filament slots (print_task_config empty)");
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    vendor: str(vendors[i]),
    material: str(types[i]),
    sub_type: str(subs[i]),
    color: argbToHex(str(colors[i])),
    present: exists[i] === true,
  }));
}

async function statusOnce(base: string): Promise<PrintStatus> {
  const status = await queryStatus(base, "print_stats&virtual_sdcard&display_status");
  const ps = obj(status.print_stats);
  const vs = obj(status.virtual_sdcard);
  return {
    state: str(ps.state, "unknown"),
    filename: str(ps.filename),
    progress: num(vs.progress),
    print_duration: num(ps.print_duration),
    total_duration: num(ps.total_duration),
  };
}

export async function printerStatus(id: string): Promise<PrintStatus> {
  return statusOnce(baseUrl(await resolve(id)));
}

/** The filament remap as the string the U1 firmware parses, `[[logical,physical],...]`,
 *  itself nested as a JSON string inside the start_local_print body. */
export function mapTableString(mapTable: [number, number][]): string {
  return JSON.stringify(mapTable.map(([l, p]) => [l, p]));
}

/** A bare filename on the printer's gcodes root. */
export function remoteFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.endsWith(".gcode") ? safe : `${safe}.gcode`;
}

/** start_local_print answers `{state: success|error|busy, message}`. Mapped so the
 *  UI can tell "printer busy" from a nozzle mismatch. */
export function interpretStartReply(v: Record<string, unknown>): PrinterError | null {
  const state = str(v.state);
  const msg = str(v.message);
  if (state === "success") return null;
  if (state === "busy") return fail("Busy", msg || "printer is busy");
  const low = msg.toLowerCase();
  const code = low.includes("busy") || low.includes("printing") || low.includes("not ready")
    ? "Busy"
    : low.includes("nozzle")
      ? "NozzleMismatch"
      : "Rejected";
  return fail(code, msg || "printer rejected the job");
}

/** Upload a sliced job the person picked (by its file handle) and start it.
 *  `mapTable` is [logical extruder (gcode Tn), physical toolhead] pairs. */
export async function printerUploadAndPrint(
  id: string,
  fileHandle: string,
  remoteName: string,
  mapTable: [number, number][],
  opts: StartOpts,
): Promise<void> {
  const cfg = await resolve(id);
  const remote = remoteFileName(remoteName);
  const base = baseUrl(cfg);

  // upload with print=false, then start separately so the map_table can go along.
  const up = await send({
    method: "POST",
    url: `${base}/server/files/upload`,
    timeoutMs: 600_000,
    body: {
      kind: "form",
      parts: [
        { name: "print", text: "false" },
        { name: "file", file: fileHandle, filename: remote, mime: "application/octet-stream" },
      ],
    },
  });
  if (!ok(up)) throw fail("Rejected", `upload failed: ${up.text ?? ""}`);

  if (cfg.kind === "MoonrakerU1") {
    const r = await send({
      method: "POST",
      url: `${base}/server/files/start_local_print`,
      body: {
        kind: "json",
        value: {
          path: remote,
          options: {
            map_table: mapTableString(mapTable),
            bed_level: opts.bedLevel ? 1 : 0,
            flow_calibrate: opts.flowCalibrate ? 1 : 0,
            time_lapse_camera: opts.timeLapseCamera ? 1 : 0,
          },
        },
      },
    });
    const err = interpretStartReply(json(r));
    if (err) throw err;
    return;
  }
  // A plain Moonraker machine only knows printer/print/start.
  const r = await send({
    method: "POST",
    url: `${base}/printer/print/start?filename=${encodeURIComponent(remote)}`,
  });
  if (!ok(r)) throw fail("Rejected", r.text ?? "");
}

/** Write filament config back to a U1 toolhead (SET_PRINT_FILAMENT_CONFIG). Not
 *  wired to UI; kept for a future push-sync. */
export async function printerSetFilament(
  id: string,
  extruder: number,
  f: { vendor: string; material: string; sub_type: string; color: string },
  force: boolean,
): Promise<void> {
  const cfg = await resolve(id);
  // the fields are interpolated into a gcode command
  const clean = (s: string) => s.replace(/[^A-Za-z0-9 _+-]/g, "").slice(0, 48);
  let script =
    `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=${Math.trunc(extruder)} VENDOR="${clean(f.vendor)}" ` +
    `FILAMENT_TYPE="${clean(f.material)}" FILAMENT_SUBTYPE="${clean(f.sub_type)}" ` +
    `FILAMENT_COLOR_RGBA=${clean(f.color.replace(/^#/, "").toUpperCase())}`;
  if (force) script += " FORCE=1";
  const r = await send({
    method: "POST",
    url: `${baseUrl(cfg)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
  });
  if (!ok(r)) throw fail("Rejected", r.text ?? "");
}

// --- status monitor (poll every 2 s while printing) ---------------------------

type StatusFn = (e: PrintStatus & { id: string }) => void;
type IdFn = (id: string) => void;

const statusFns = new Set<StatusFn>();
const offlineFns = new Set<IdFn>();
const monitors = new Map<string, { stop: boolean }>();

export function onPrinterStatus(fn: StatusFn): () => void {
  statusFns.add(fn);
  return () => void statusFns.delete(fn);
}

export function onPrinterOffline(fn: IdFn): () => void {
  offlineFns.add(fn);
  return () => void offlineFns.delete(fn);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function printerMonitorStart(id: string): Promise<void> {
  const base = baseUrl(await resolve(id));
  printerMonitorStop(id);
  const run = { stop: false };
  monitors.set(id, run);
  void (async () => {
    let fails = 0;
    while (!run.stop) {
      await sleep(2000);
      if (run.stop) break;
      try {
        const st = await statusOnce(base);
        fails = 0;
        for (const fn of statusFns) fn({ id, ...st });
        if (st.state !== "printing" && st.state !== "paused") break;
      } catch {
        if (++fails >= 3) {
          for (const fn of offlineFns) fn(id);
          break;
        }
      }
    }
    if (monitors.get(id) === run) monitors.delete(id);
  })();
}

export function printerMonitorStop(id: string): void {
  const run = monitors.get(id);
  if (run) run.stop = true;
  monitors.delete(id);
}

// --- camera (snapshot polling at ~1 fps while a panel is open) ----------------
//
// The U1's webcam server (fw 1.3.0) serves /webcam/snapshot.jpg. Frames reach
// the panel as data: URLs, which the window's CSP already allows in img-src.

type FrameFn = (e: { id: string; data_url: string }) => void;

const frameFns = new Set<FrameFn>();
const cameraOfflineFns = new Set<IdFn>();
const cameras = new Map<string, { stop: boolean }>();

export function onPrinterCameraFrame(fn: FrameFn): () => void {
  frameFns.add(fn);
  return () => void frameFns.delete(fn);
}

export function onPrinterCameraOffline(fn: IdFn): () => void {
  cameraOfflineFns.add(fn);
  return () => void cameraOfflineFns.delete(fn);
}

export async function printerCameraStart(id: string): Promise<void> {
  const url = `${webcamBaseUrl(await resolve(id))}/webcam/snapshot.jpg`;
  printerCameraStop(id);
  const run = { stop: false };
  cameras.set(id, run);
  void (async () => {
    let fails = 0;
    while (!run.stop) {
      await sleep(1000);
      if (run.stop) break;
      let frame: string | null = null;
      try {
        const r = await send({ url, binary: true });
        if (ok(r) && r.base64) frame = `data:image/jpeg;base64,${r.base64}`;
      } catch {
        frame = null;
      }
      if (run.stop) break;
      if (frame) {
        fails = 0;
        for (const fn of frameFns) fn({ id, data_url: frame });
      } else if (++fails >= 3) {
        for (const fn of cameraOfflineFns) fn(id);
        break;
      }
    }
    if (cameras.get(id) === run) cameras.delete(id);
  })();
}

export function printerCameraStop(id: string): void {
  const run = cameras.get(id);
  if (run) run.stop = true;
  cameras.delete(id);
}

// --- active-printer selection (display concern, so localStorage) --------------

const ACTIVE_KEY = "fundacad.activePrinter";
const LEGACY_ACTIVE_KEYS = ["neocad.activePrinter", "sindri.activePrinter"];
export function activePrinterId(): string {
  return readSetting(ACTIVE_KEY, ...LEGACY_ACTIVE_KEYS) || "u1";
}
export function setActivePrinterId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}
