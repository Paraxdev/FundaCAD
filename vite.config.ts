import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Tauri expects a fixed dev port and no auto-clearing of the screen so its
// logs survive. Frontend talks to the Python sidecar over WS directly.
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // The sidecar's uv venv is ~800MB of Python files that Vite never serves.
    // Watching it wastes inotify handles and, on a container with a modest
    // fs.inotify.max_user_watches, crashes the dev server with ENOSPC.
    watch: { ignored: ["**/sidecar/.venv/**", "**/src-tauri/target/**", "**/third_party/**"] },
  },
  // Tauri builds for a specific target; keep the chunk modern.
  build: {
    target: "esnext",
    minify: false,
    sourcemap: true,
  },
  define: {
    // Vue's esm-bundler build ships these as compile-time flags. Both are off:
    // every component is <script setup> (no Options API) and the prod devtools
    // hook is dead weight in a packaged desktop app. Behaviourally inert — this
    // is a size win only.
    //
    // What is NOT negotiable is which Vue build we resolve. The webview CSP
    // (src-tauri/tauri.conf.json) is `script-src 'self' 'wasm-unsafe-eval'` —
    // no 'unsafe-eval' — so Vue's RUNTIME template compiler cannot run here.
    // The default bundler entry (vue/dist/vue.runtime.esm-bundler.js) has no
    // compiler in it and @vitejs/plugin-vue compiles every <template> ahead of
    // time, which is why this works. Never alias `vue` to the full
    // `vue.esm-bundler.js`, and never pass a string `template` to
    // defineComponent/createApp: either one needs 'unsafe-eval' and would fail
    // at runtime inside Tauri while still working in a plain browser.
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
  },
});
