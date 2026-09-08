// The app-side half of the MCP plugin.
//
// The plugin itself is a PROCESS: server.py and the modules beside it, launched
// by an assistant, talking to the app over the sidecar link. None of that runs
// in the window. But a process plugin can still have a face in the app — a
// setting that governs it, a badge that says who is connected — and that face
// has to appear and disappear with the plugin rather than being written into
// the app on every machine whether or not anybody has installed it.
//
// So a plugin directory may carry a main.ts whatever its kind. For a builtin it
// IS the capability; for a bundle like this one it is the companion, loaded when
// the bundle is installed and torn down when it is removed. It contributes
// through the same table everything else does and gets no more reach for being
// shipped here.

import SettingsSection from "./SettingsSection.vue";
import { contribute } from "fundacad";

const ID = "FundaCAD.MCP";

/** Start the companion. Returns the teardown.
 *
 *  No Engine is used. This one contributes a settings block and nothing that
 *  touches the document — the document work is what the PROCESS does, through
 *  the broker, against the grants recorded at install. */
export async function activate(): Promise<() => void> {
  return contribute(ID, {
    settings: [{ key: "assistants", title: "Assistants", component: SettingsSection }],
  });
}
