// Types for the artifact-retention scan, so a test can import it under vue-tsc.
//
// Hand-written for the same reason build-plugin-code.d.mts is: the script is a
// .mjs on purpose and this repository has no @types/node.

/** One `uses: actions/upload-artifact` step, and how long it keeps its upload. */
export interface UploadStep {
  /** 1-based line of the `uses:` line, for a message that says where. */
  line: number;
  /** The step's `name:`, or "" when it has none. */
  name: string;
  /** `retention-days`, or null when the step does not say (the default is 90). */
  retention: number | null;
}

/** Every artifact upload in one workflow file's text. */
export declare function uploadSteps(text: string): UploadStep[];

/** The uploads that keep their artifact too long, or do not say. */
export declare function retentionFindings(steps: UploadStep[], maxDays?: number): string[];
