// The printer connection's protocol and slicer lookup, now that they are the
// plugin's TypeScript rather than the app shell's Rust. These are the same
// facts the Rust unit tests pinned, moved with the code.

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  argbToHex,
  baseUrl,
  interpretStartReply,
  mapTableString,
  parseRegistry,
  printerFilaments,
  printerUploadAndPrint,
  printersList,
  remoteFileName,
  validHost,
  webcamBaseUrl,
  SEED,
  type PrinterConfig,
} from "../../plugins/FundaCAD.Printing/printerClient";
import { orcaDatadir, slicerCandidates } from "../../plugins/FundaCAD.Printing/slicer";
import { stagingName } from "../../plugins/FundaCAD.Printing/printFlow";
import type { SystemDirs } from "../../plugins/FundaCAD.Printing/native";

afterEach(() => invoke.mockReset());

describe("the Moonraker wire format", () => {
  it("serializes the filament remap as a nested JSON string", () => {
    expect(mapTableString([[0, 2], [1, 0], [2, 1], [3, 3]])).toBe("[[0,2],[1,0],[2,1],[3,3]]");
    expect(mapTableString([])).toBe("[]");
  });

  it("takes RGB out of RRGGBBAA", () => {
    expect(argbToHex("6C5BB1FF")).toBe("#6C5BB1");
    expect(argbToHex("#39ff14ff")).toBe("#39FF14");
    expect(argbToHex("bad")).toBe("#808080");
  });

  it("refuses a host that is a URL", () => {
    expect(validHost("192.168.0.46")).toBe(true);
    expect(validHost("printer.local")).toBe(true);
    expect(validHost("http://192.168.0.46")).toBe(false);
    expect(validHost("192.168.0.46/x")).toBe(false);
    expect(validHost("a@b")).toBe(false);
    expect(validHost("")).toBe(false);
  });

  it("gives the webcam its own port", () => {
    const cfg: PrinterConfig = { id: "t", name: "t", host: "192.168.0.46", port: 7125, kind: "MoonrakerU1", webcam_port: 8080 };
    expect(webcamBaseUrl(cfg)).toBe("http://192.168.0.46:8080");
    expect(baseUrl(cfg)).toBe("http://192.168.0.46:7125");
  });

  it("reads a registry written before webcam_port existed", () => {
    const [cfg] = parseRegistry('[{"id":"u1","name":"U1","host":"192.168.0.46","port":7125,"kind":"MoonrakerU1"}]');
    expect(cfg!.webcam_port).toBe(80);
  });

  it("tells busy from a nozzle mismatch", () => {
    expect(interpretStartReply({ state: "success" })).toBeNull();
    expect(interpretStartReply({ state: "busy" })?.code).toBe("Busy");
    expect(interpretStartReply({ state: "error", message: "Printer is printing" })?.code).toBe("Busy");
    expect(interpretStartReply({ state: "error", message: "Nozzle diameter differs" })?.code).toBe("NozzleMismatch");
    expect(interpretStartReply({ state: "error", message: "" })?.code).toBe("Rejected");
  });

  it("keeps remote names bare", () => {
    expect(remoteFileName("my part (2).gcode")).toBe("my_part__2_.gcode");
    expect(remoteFileName("../x")).toBe(".._x.gcode");
  });
});

describe("through the app's generic commands", () => {
  const u1 = JSON.stringify([SEED[0]]);

  function route(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
    invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      const h = handlers[cmd];
      if (!h) return Promise.reject(new Error(`unexpected ${cmd}`));
      return Promise.resolve(h(args));
    });
  }

  it("moves the shell's old files into the plugin once, then seeds when there is nothing", async () => {
    const adopted: unknown[] = [];
    const written: Record<string, string> = {};
    route({
      plugin_data_adopt: (a) => (adopted.push([a.legacy, a.name]), false),
      plugin_data_read: () => null,
      plugin_data_write: (a) => void (written[a.name as string] = a.text as string),
    });
    const list = await printersList();
    expect(adopted).toEqual([["printers.json", "printers.json"], ["settings.json", "slicer.json"]]);
    expect(list.map((p) => p.id)).toEqual(["u1", "qidi-xplus4"]);
    expect(JSON.parse(written["printers.json"]!)).toHaveLength(2);
  });

  it("reads filament slots out of print_task_config over a local request", async () => {
    const requests: Record<string, unknown>[] = [];
    route({
      plugin_data_adopt: () => false,
      plugin_data_read: () => u1,
      plugin_local_request: (a) => {
        requests.push(a.request as Record<string, unknown>);
        return {
          status: 200,
          contentType: "application/json",
          base64: null,
          text: JSON.stringify({
            result: {
              status: {
                print_task_config: {
                  filament_vendor: ["Polymaker", ""],
                  filament_type: ["PLA", "PETG"],
                  filament_sub_type: ["", ""],
                  filament_color_rgba: ["D23B30FF", "zz"],
                  filament_exist: [true, false],
                },
              },
            },
          }),
        };
      },
    });
    const slots = await printerFilaments("u1");
    expect(requests[0]!.url).toBe("http://192.168.0.46:7125/printer/objects/query?print_task_config");
    expect(slots).toEqual([
      { index: 0, vendor: "Polymaker", material: "PLA", sub_type: "", color: "#D23B30", present: true },
      { index: 1, vendor: "", material: "PETG", sub_type: "", color: "#808080", present: false },
    ]);
  });

  it("uploads the picked file by handle, then starts it with the remap", async () => {
    const requests: Record<string, unknown>[] = [];
    route({
      plugin_data_adopt: () => false,
      plugin_data_read: () => u1,
      plugin_local_request: (a) => {
        requests.push(a.request as Record<string, unknown>);
        return { status: 200, contentType: null, base64: null, text: '{"state":"success"}' };
      },
    });
    await printerUploadAndPrint("u1", "h123", "job.gcode", [[0, 2]], { bedLevel: true, flowCalibrate: false, timeLapseCamera: false });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "http://192.168.0.46:7125/server/files/upload",
      body: { kind: "form", parts: [{ name: "print", text: "false" }, { name: "file", file: "h123", filename: "job.gcode" }] },
    });
    expect(requests[1]).toMatchObject({
      url: "http://192.168.0.46:7125/server/files/start_local_print",
      body: { kind: "json", value: { path: "job.gcode", options: { map_table: "[[0,2]]", bed_level: 1, flow_calibrate: 0 } } },
    });
  });
});

describe("where the slicer is", () => {
  const dirs = (os: string): SystemDirs => ({
    os,
    home: os === "windows" ? "C:\\Users\\tester" : "/home/tester",
    config: os === "windows" ? "C:\\Users\\tester\\AppData\\Roaming" : os === "macos" ? "/Users/tester/Library/Application Support" : "/home/tester/.config",
    localData: os === "windows" ? "C:\\Users\\tester\\AppData\\Local" : null,
    programs: os === "windows" ? ["C:\\Program Files", "C:\\Program Files (x86)"] : [],
  });

  it("looks where each platform installs it", () => {
    // Reported from a Windows build: "open in orca links to appimage in windows".
    const win = slicerCandidates(dirs("windows"));
    expect(win.length).toBeGreaterThan(0);
    expect(win.every((n) => n.endsWith(".exe"))).toBe(true);
    expect(win.some((n) => n.includes("AppImage"))).toBe(false);
    expect(win[0]).toBe("C:\\Program Files\\OrcaSlicer\\orca-slicer.exe");

    const mac = slicerCandidates(dirs("macos"));
    expect(mac.every((n) => n.includes(".app/"))).toBe(true);

    const lin = slicerCandidates(dirs("linux"));
    expect(lin.some((n) => n.includes("AppImage"))).toBe(true);
    expect(lin.some((n) => n.endsWith(".exe"))).toBe(false);
  });

  it("finds the presets in the per-user settings directory", () => {
    expect(orcaDatadir(dirs("windows"))).toBe("C:\\Users\\tester\\AppData\\Roaming\\OrcaSlicer");
    expect(orcaDatadir(dirs("macos"))).toBe("/Users/tester/Library/Application Support/OrcaSlicer");
    expect(orcaDatadir(dirs("linux"))).toBe("/home/tester/.config/OrcaSlicer");
  });

  it("stages under a name that cannot leave its directory", () => {
    expect(stagingName("my part")).toBe("my_part.3mf");
    expect(stagingName("")).toBe("part.3mf");
    expect(stagingName("../../x")).toBe("______x.3mf");
  });
});
