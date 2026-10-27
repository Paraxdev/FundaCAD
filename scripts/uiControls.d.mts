// Types for the raw control scan, so tests/ui/uiControls.test.ts type checks under vue-tsc without @types/node.

export interface Finding {
  path: string;
  /** 1-based. */
  line: number;
  /** For example `button`, `input[type=range]`, `role=tab`, `createElement:input`, `style:inline`. */
  kind: string;
}

export interface AllowEntry {
  path: string;
  kind: string;
  count: number;
  reason: string;
}

export declare function isScanned(path: string): boolean;
export declare function useInstead(kind: string): string;
export declare function scanControls(files: Record<string, string>, options?: { legacyClasses?: boolean }): Finding[];
export declare function checkAllowlist(findings: readonly Finding[], allow: readonly AllowEntry[]): string[];
export declare function lowerAllowlist(findings: readonly Finding[], allow: readonly AllowEntry[]): AllowEntry[];
export declare function formatAllowlist(allow: readonly AllowEntry[]): string;
