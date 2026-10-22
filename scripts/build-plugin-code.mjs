// Builds a plugin into main.js, an IIFE the app evaluates with the SHARED host modules as its one argument. Those must
// never be bundled: a second Vue, Pinia or three.js has its own reactivity, stores or instanceof and fails silently.

import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";

// From the plugin directory, because import.meta.url is not a file URL under a test runner's transform.
const repoOf = (dir) => path.resolve(dir, "..", "..");

const SHARED = ["fundacad", "fundacad/ui", "vue", "pinia", "three"];

const globals = Object.fromEntries(SHARED.map((id) => [id, `__fundacadHost[${JSON.stringify(id)}]`]));

// The loader reads the exports back from this global.
const EXPORT_NAME = "__fundacadPlugin";

export async function buildPlugin(dir, outFile) {
  const REPO = repoOf(dir);
  const entry = path.join(dir, "main.ts");
  const result = await build({
    root: REPO,
    configFile: false,
    logLevel: "warn",
    plugins: [vue()],
    resolve: {
      alias: {
        "fundacad/ui": path.join(REPO, "src/plugins/hostUi.ts"),
        fundacad: path.join(REPO, "src/plugins/host.ts"),
      },
    },
    define: {
      __VUE_OPTIONS_API__: "false",
      __VUE_PROD_DEVTOOLS__: "false",
    },
    build: {
      write: false,
      // Unminified so a person can read what the code of an installed plugin does when the app evaluates it.
      minify: false,
      target: "es2022",
      lib: { entry, formats: ["iife"], name: EXPORT_NAME, fileName: () => "main.js" },
      rollupOptions: {
        external: SHARED,
        output: { globals, extend: false },
      },
    },
  });

  const chunks = Array.isArray(result) ? result : [result];
  const files = chunks.flatMap((c) => c.output ?? []);
  const js = files.filter((f) => f.type === "chunk");
  const css = files.filter((f) => f.type === "asset" && f.fileName.endsWith(".css"));

  // A dynamic import would make a second chunk, a second file to fetch, verify and evaluate that nothing carries.
  if (js.length !== 1) {
    throw new Error(
      `${dir}: expected one chunk, got ${js.length} (${js.map((f) => f.fileName).join(", ")}). ` +
        "A dynamic import() of a plugin's own module splits the build; import it directly.",
    );
  }
  if (css.length) {
    throw new Error(
      `${dir}: a <style> block produced ${css.map((f) => f.fileName).join(", ")}. ` +
        "A plugin styles itself with the app's own classes or with inline styles; " +
        "there is nowhere to put a stylesheet a downloaded plugin brought with it.",
    );
  }

  const code = js[0].code;
  if (outFile) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, code);
  }
  return code;
}

// Shared with the loader and the tests so the list exists once.
export { SHARED, EXPORT_NAME };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [, , dir, out] = process.argv;
  if (!dir) {
    console.error("usage: node scripts/build-plugin-code.mjs <plugin-dir> [out-file]");
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const code = await buildPlugin(dir, out);
  console.log(`${manifest.id}: ${code.length} bytes${out ? ` -> ${out}` : ""}`);
}
