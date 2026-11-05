// A Reset settings start (app/startChoice.ts) clears localStorage before main.ts loads, since its imports read their
// settings once, as they load.
import { runStartChoice, startChoiceNotice } from "./app/startChoice";

void runStartChoice().then(async (outcome) => {
  await import("./main");
  if (!outcome) return;
  const { toast } = await import("./ui/toast");
  const { text, kind } = startChoiceNotice(outcome);
  toast(text, { kind });
});
