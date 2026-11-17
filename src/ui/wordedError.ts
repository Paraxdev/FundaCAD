import { t, tEnglish, type MessageArgs, type MessageKey } from "../i18n";

/** A refusal whose message stays English for logs, crumbs, MCP replies and the problem report. Where it is shown,
 *  `shownMessage` words it from the key in the chosen language. */
export class WordedError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly args: MessageArgs = {},
  ) {
    super(tEnglish(key, args));
  }
}

/** The sentence in the chosen language when the app worded it, any other error's message as it was written. */
export function shownMessage(err: unknown): string {
  if (err instanceof WordedError) return t(err.key, err.args);
  return err instanceof Error ? err.message : String(err);
}

/** The message as the log and the problem report keep it. */
export function englishMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
