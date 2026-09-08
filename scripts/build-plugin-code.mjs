// Build one plugin directory into a single module the app can load at runtime.
//
// A plugin that draws — a menu row, a panel, paint on the model — runs in the
// application's own JavaScript context. It cannot be a Worker and it cannot be a
// process: those cannot touch the DOM, the viewport or Vue's reactivity. So the
// only way for such a plugin to arrive from a release rather than from the app's
// own bundle is for its code to be built separately and evaluated on load.
//
// WHAT THIS PRODUCES: `main.js`, an IIFE that takes one argument and returns the
// module's exports. Every import the plugin makes of something the APP already
// has is externalised and resolved through that argument at load time. Nothing
// shared is duplicated, and that is not a size argument:
//
//   - two copies of Vue is two reactivity systems that cannot see each other's
//     refs, so a plugin's component would never re-render on an app change;
//   - two copies of Pinia is two store registries, so `usePrintStatusStore()`
//     in the plugin and in its own component would be different stores;
//   - two copies of three.js is `instanceof` failing between them, which the
//     viewport uses to decide what it was handed.
//
// Each of those fails at runtime, silently, in a way that looks like a bug in
// the plugin. So the externals list is not an optimisation to tune; it is the
// set of things that MUST be shared, and anything a plugin imports that is not
// on it is bundled in.
//
// Usage:  node scripts/build-plugin-code.mjs <plugin-dir> <out-file>

import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";

/** The repository root, from the plugin directory rather than from this file.
 *
 *  `import.meta.url` is not a file URL when this module is loaded through a
 *  test runner's transform pipeline, and the failure is at import time, before
 *  anything can report it usefully. Every plugin lives at <repo>/plugins/<id>,
 *  which is the same rule the packager and the app's glob both follow. */
const repoOf = (dir) => path.resolve(dir, "..", "..");

/** Specifier -> the expression that yields it at load time.
 *
 *  `__fundacadHost` is the one argument the built module takes. Bracket
 *  notation throughout, because two of these have a slash in them and because a
 *  uniform shape is one less thing to get wrong when adding one. */
const SHARED = [
  "fundacad",
  "fundacad/ui",
  "vue",
  "pinia",
  "three",
];

const globals = Object.fromEntries(
  SHARED.map((id) => [id, `__fundacadHost[${JSON.stringify(id)}]`]),
);

/** The name the IIFE assigns its exports to, and what the loader reads back. */
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
      // Kept readable on purpose. This code is EVALUATED by the app, so a person
      // asking what a bundle they installed actually does has to be able to read
      // it; a minified answer to that question is not an answer.
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

  // One chunk, always. A dynamic import inside a plugin would produce a second
  // one, and a second file is a second thing to fetch, verify and evaluate that
  // nothing here is built to carry. A plugin that needs laziness gets it from
  // the app's own lazy loading of the whole plugin.
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

/** The externals a built plugin resolves. Exported so the loader and the tests
 *  read the same list rather than two copies of it. */
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
