// Self-hosted fonts, Latin subset and only the weights the chrome uses, so the app works offline.
// Imported before the stylesheet so @font-face is registered before the first text paints.
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles/main.scss";
import { initTheme } from "./ui/theme";
import { installGlassBlurSwitch } from "./ui/glassBlur";

// Applies a stored non-default theme before anything renders, so the app never paints one palette then swaps.
initTheme();
installGlassBlurSwitch();
import "./diagnostics/breadcrumbs"; // installs window error listeners (bug-report trail)
import { createApp, markRaw } from "vue";
import { createPinia, setActivePinia } from "pinia";
import App from "./App.vue";
import { installGlobalErrorHandlers } from "./app/errors";
import { createEngine, mountUi } from "./app/engine";
import { ENGINE } from "./app/engineKey";
import { installDevGlobals } from "./app/devGlobals";
import { invoke } from "@tauri-apps/api/core";
import { harnessWanted } from "./harness/wanted";
import { installGuidePressGuard } from "./ui/guide/pressGuard";
import { watchFirstFrame } from "./app/firstFrame";

// Before anything is constructed, so a failure inside createEngine still reaches the user.
installGlobalErrorHandlers();

// Active before createEngine, which writes chrome state into Pinia stores from outside any component.
const pinia = createPinia();
setActivePinia(pinia);

// The engine is built on a detached canvas before Vue runs, because component setup() reads it synchronously.
// components/shell/ViewportPane.vue adopts the canvas in onMounted.
const canvas = document.createElement("canvas");
canvas.id = "canvas"; // keeps the #canvas rule in styles/_layout.scss
const engine = createEngine(canvas);

installGuidePressGuard();
const app = createApp(App);
// A reactive proxy would break structuredClone in the undo snapshot and the identity checks of the delta protocol.
app.provide(ENGINE, markRaw(engine));
app.use(pinia);
app.mount("#app");

mountUi(engine);

// safe_mode.rs counts the start as finished after the first painted frame, since the WebKit crashes of issue #6 came then.
watchFirstFrame(
  () => void invoke("frontend_ready", { stage: "mounted" }).catch(() => {}),
  () => void invoke("frontend_stalled").catch(() => {}),
);

installDevGlobals(engine);
// import.meta.env.DEV first, so a production build drops the driver chunk.
if (import.meta.env.DEV && harnessWanted(location.search, true)) {
  void import("./harness/driver").then((m) => m.installHarness(engine));
}
