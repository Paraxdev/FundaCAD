// Tells the load watchdog in src-tauri/src/lib.rs that the webview runs our code (issue #3).
// Kept out of main.ts so a throwing import there cannot block the ping; vite build merges both entries, so that holds only in dev.
import { invoke } from "@tauri-apps/api/core";

// Outside Tauri (a browser, vitest) there is no IPC, so the rejection is expected.
invoke("frontend_ready").catch(() => {});
