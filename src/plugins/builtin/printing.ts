// The printer capability: the wiring that connects a machine on the network,
// and a slicer on this one, to the rest of the app.
//
// The work itself is in print/ and in src-tauri/src/{printer,slicer}.rs. What
// lives here is the part the core would otherwise have to know: that a print
// exists, that there is a pill for it, and that clicking the pill opens a
// camera. plugins/activate.ts loads this file only when the capability is on,
// so a machine with no printer never parses the printer client, the slicer
// bridge, or the status pill's polling.

import type { Engine } from "../../app/engine";

/** Start the capability. Returns the teardown that stops it. */
export async function activate(e: Engine): Promise<() => void> {
  const [{ setPrinterPillClick }, { activePrinterId }] = await Promise.all([
    import("../../print/printStatusLine"),
    import("../../print/printerClient"),
  ]);

  // Clicking the live print-progress pill opens the camera on the active
  // printer. The pill itself is mounted by App.vue behind the same capability
  // check, so with this off there is nothing to click.
  setPrinterPillClick(() => void e.ui.panels.showCameraPanel(activePrinterId()));

  return () => {
    // Back to doing nothing, rather than to a stale closure over an engine and
    // a panel that a turned-off capability has no business opening.
    setPrinterPillClick(null);
  };
}
