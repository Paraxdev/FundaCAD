// 'auto' projection stays in perspective while the eye is inside the content box, in the Classic camera.

import { describe, vi } from "vitest";
import { createLegacyRig } from "../../src/viewport/legacyRig";
import { autoProjectionCases } from "./autoProjectionCases";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));

describe("auto projection, Classic camera", () => {
  autoProjectionCases(() => {
    const dom = document.createElement("canvas");
    dom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
    document.body.append(dom);
    const rig = createLegacyRig(dom, 800 / 600);
    rig.resize(800, 600);
    return rig;
  });
});
