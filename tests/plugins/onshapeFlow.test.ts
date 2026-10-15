import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebRequest, WebResponse } from "../../plugins/FundaCAD.Onshape/client";

const h = vi.hoisted(() => ({
  importPath: vi.fn(async () => undefined),
  reportError: vi.fn(async () => undefined),
  toast: vi.fn(),
  removeDownload: vi.fn(async (_name: string) => undefined),
  route: (_req: WebRequest): WebResponse | Promise<WebResponse> => {
    throw new Error("no route");
  },
  seen: [] as WebRequest[],
}));

vi.mock("fundacad", () => ({ importPath: h.importPath, reportError: h.reportError, toast: h.toast }));
vi.mock("../../plugins/FundaCAD.Onshape/native", () => ({
  loadKeys: async () => ({ access: "a".repeat(24), secret: "s".repeat(48) }),
  saveKeys: async () => undefined,
  removeDownload: h.removeDownload,
  webRequest: async (req: WebRequest) => {
    h.seen.push(req);
    return h.route(req);
  },
}));

const D = "e60c4803eaf2ac8be492c18e";
const W = "d2558da712764516cc9fec62";
const E = "6bed6b43463f6a46a37b4a22";
vi.mock("../../plugins/FundaCAD.Onshape/dialog", () => ({
  askForLink: async () => ({ link: `https://cad.onshape.com/documents/${D}/w/${W}/e/${E}`, remember: false }),
}));

const { importFromOnshape } = await import("../../plugins/FundaCAD.Onshape/flow");

function reply(status: number, body?: unknown, extra: Partial<WebResponse> = {}): WebResponse {
  return {
    status,
    contentType: "application/json",
    location: null,
    retryAfter: null,
    text: body === undefined ? null : JSON.stringify(body),
    path: null,
    len: null,
    ...extra,
  };
}

function fakeStore() {
  const store = {
    runBusy: (_label: string, fn: (onStarted: (id: string) => void) => Promise<unknown>) => {
      return fn(() => {});
    },
  };
  return { store: store as never };
}

function onshape(state: () => string, savedAt: string) {
  h.route = (req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/elements")) return reply(200, [{ id: E, name: "Part Studio 1", elementType: "PARTSTUDIO" }]);
    if (path.endsWith("/translations")) return reply(200, { id: "t1", requestState: state(), resultExternalDataIds: ["x1"] });
    if (path.startsWith("/api/translations/")) return reply(200, { id: "t1", requestState: state(), resultExternalDataIds: ["x1"] });
    if (path.includes("/externaldata/")) return reply(200, undefined, { path: savedAt, len: 10 });
    return reply(404);
  };
}

beforeEach(() => {
  h.seen.length = 0;
  h.importPath.mockClear();
  h.reportError.mockClear();
  h.removeDownload.mockClear();
});

describe("importing from an Onshape link", () => {
  it.each([
    ["Windows", "C:\\Users\\me\\AppData\\Roaming\\fundacad\\plugin-data\\FundaCAD.Onshape\\downloads\\Part_Studio_1.step"],
    ["Linux", "/home/me/.local/share/fundacad/plugin-data/FundaCAD.Onshape/downloads/Part_Studio_1.step"],
  ])("deletes the downloaded STEP by its file name on %s", async (_os, savedAt) => {
    onshape(() => "DONE", savedAt);
    const { store } = fakeStore();
    await importFromOnshape(store, {} as never);
    expect(h.reportError).not.toHaveBeenCalled();
    expect(h.importPath).toHaveBeenCalledWith(store, expect.anything(), savedAt, undefined, expect.anything());
    expect(h.removeDownload).toHaveBeenCalledWith("Part_Studio_1.step");
  });
});
