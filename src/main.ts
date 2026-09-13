// The NeoNoir type pair, self-hosted (Fontsource, bundled by Vite), so the look
// does not depend on the OS having these installed and works offline in the
// Tauri shell. Latin subset, and only the weights the chrome actually uses:
// Space Grotesk for UI text and headings, JetBrains Mono for numbers and code.
// Imported before the stylesheet so the @font-face rules are registered by the
// time the first painted text asks for the family.
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles/main.scss";
import { initTheme } from "./ui/theme";

// Before anything renders. The stylesheet already carries the default palette on
// :root, so a cold load is themed with no script at all; this is what puts a
// STORED non-default choice on the document, and doing it here rather than in a
// component keeps the app from painting one palette and then swapping.
initTheme();
import "./diagnostics/breadcrumbs"; // installs window error listeners (bug-report trail)
import { createApp, markRaw } from "vue";
import { createPinia, setActivePinia } from "pinia";
import App from "./App.vue";
import { installGlobalErrorHandlers } from "./app/errors";
import { createEngine, mountUi } from "./app/engine";
import { ENGINE } from "./app/engineKey";
import { installDevGlobals } from "./app/devGlobals";

// Installed before anything is constructed, so a failure inside createEngine
// still reaches the user rather than leaving a blank viewport.
installGlobalErrorHandlers();

// Active BEFORE createEngine, because the engine writes chrome state (status
// line, doc name, projection label) into Pinia stores from outside any
// component. app.use(pinia) below still registers it with the app for the
// components' own useXStore() calls.
const pinia = createPinia();
setActivePinia(pinia);

// The canvas is created here, detached, and handed to the Viewport before Vue
// runs at all. Two reasons:
//   1. Viewport / DocumentStore / SketchMode / all ten tools must be fully
//      constructed before any component's setup() executes, the components
//      read them synchronously.
//   2. It keeps the boot sequence (and the ordering constraints documented
//      inside createEngine) in one place, top to bottom, with no Vue lifecycle
//      interleaved.
// components/shell/ViewportPane.vue adopts it in onMounted.
const canvas = document.createElement("canvas");
canvas.id = "canvas"; // keeps the #canvas rule in styles/_layout.scss
const engine = createEngine(canvas);

const app = createApp(App);
// markRaw: the engine is a graph of Three.js objects, the document store and
// ten tool classes. Wrapping any of it in a reactive proxy would break
// structuredClone in the undo snapshot and the reference-identity checks the
// delta wire protocol depends on. See app/docBridge.ts.
app.provide(ENGINE, markRaw(engine));
app.use(pinia);
app.mount("#app");

// mount() is synchronous, so the shell, and the container elements the
// not-yet-converted panels mount into, exist by the time this runs.
mountUi(engine);

installDevGlobals(engine);
