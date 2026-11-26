import { t, tEnglish, type MessageArgs, type MessageKey } from "../i18n";

/** A refusal whose message stays English for logs, crumbs, MCP replies and the problem report. Where it is shown,
 *  `shownMessage` words it from the key in the chosen language. `lines` are arguments that are lines themselves,
 *  worded in the same language from the same arguments. */
export class WordedError extends Error {
  readonly lines: Readonly<Record<string, MessageKey>>;
  constructor(
    readonly key: MessageKey,
    readonly args: MessageArgs = {},
    opts: { lines?: Record<string, MessageKey> } = {},
  ) {
    super(tEnglish(key, { ...args, ...wordLines(tEnglish, args, opts.lines) }));
    this.lines = opts.lines ?? {};
  }
}

function wordLines(say: typeof t, args: MessageArgs, lines: Readonly<Record<string, MessageKey>> = {}): MessageArgs {
  return Object.fromEntries(Object.entries(lines).map(([name, key]) => [name, say(key, args)]));
}

/** The sentence in the chosen language when the app worded it, any other error's message as it was written. */
export function shownMessage(err: unknown): string {
  if (err instanceof WordedError) return t(err.key, { ...err.args, ...wordLines(t, err.args, err.lines) });
  return err instanceof Error ? err.message : String(err);
}

/** The message as the log and the problem report keep it. */
export function englishMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
