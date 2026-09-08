// The plugins compiled into a DEVELOPMENT build, and only into one.
//
// A shipped build has none of this. Every plugin arrives as a bundle from a
// release, is unpacked into the app's data directory, and has its app-side
// module read back and evaluated (./loader.ts). That is the whole point of the
// arrangement and it is what "we do not ship the plugins" means.
//
// Development would be miserable under that rule alone: an edit to a plugin
// would mean packaging a zip, publishing it somewhere, and installing it before
// the change could be seen. So `vite dev` and only `vite dev` compiles the
// plugin directories in and runs them from the bundle, exactly as it did when
// they were part of the app.
//
// THIS FILE IS IMPORTED FROM INSIDE AN `import.meta.env.DEV` BRANCH, and that is
// load-bearing rather than tidy. Vite replaces that expression with `false` in a
// production build, rollup drops the dead branch, and the dynamic import inside
// it goes with it — taking this module, the glob, and every plugin's code out of
// the shipped bundle. An import at the top of ./activate.ts would keep all of it,
// and the switch would be a claim rather than a fact. tests/plugins/shipped.test
// checks the built output for exactly that.

/** Every plugin directory with a `main.ts`, as a loader that has not run. */
const MAIN = import.meta.glob("../../plugins/*/main.ts") as Record<
  string,
  () => Promise<unknown>
>;

/** `../../plugins/Some.Thing/main.ts` -> `Some.Thing`. */
function idOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? "";
}

export const devLoaders: Record<string, () => Promise<unknown>> = Object.fromEntries(
  Object.entries(MAIN).map(([path, load]) => [idOf(path), load]),
);
