// Types for the plugin build script, so a test can import it under vue-tsc.
//
// Hand-written rather than generated: the script is a .mjs on purpose (it runs
// under plain node in CI, before anything is compiled), and this repository has
// no @types/node, so a checked .ts version would need one for `path` and
// `process` alone.

/** Specifiers a built plugin leaves external and resolves against the running
 *  app. Must match the keys of `hostModules()` in src/plugins/loader.ts. */
export declare const SHARED: readonly string[];

/** The variable a built module assigns its exports to. */
export declare const EXPORT_NAME: string;

/** Build one plugin directory into the single module a bundle carries.
 *
 *  `dir` may be relative to the working directory. `outFile` writes the result;
 *  pass null to get the code back without touching the disk. */
export declare function buildPlugin(dir: string, outFile: string | null): Promise<string>;
