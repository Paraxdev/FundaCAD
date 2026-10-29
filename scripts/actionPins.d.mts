// Types for the action pin scan, so a test can import it under vue-tsc. Hand-written like artifactRetention.d.mts.

/** Workflow and composite action text, keyed by path. */
export type Files = Record<string, string>;

export interface UsesStep {
  /** `path:line` of the `uses:` line. */
  where: string;
  ref: string;
  /** What follows the ref on its line, trimmed, normally `# tag`. */
  comment: string;
  /** The lines of the step that holds it. */
  step: string[];
}

export interface Pin {
  where: string;
  /** owner/repo, without a sub action path such as /restore. */
  repo: string;
  sha: string;
  /** The tag or branch the comment names. */
  ref: string;
}

export declare const BRANCH_PINS: Record<string, string>;
export declare function yamlLines(text: string): { n: number; text: string }[];
export declare function refusedForms(path: string, text: string): string[];
export declare function usesSteps(files: Files): UsesStep[];
export declare function pins(files: Files): Pin[];
export declare function pinFindings(files: Files): string[];
export declare function grants(files: Files): string[];
