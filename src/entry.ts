// A Reset settings start (app/startChoice.ts) clears localStorage before main.ts, whose imports read settings once;
// the language loads between the two, so no label paints in English first.
import { runStartChoice, startChoiceNotice } from "./app/startChoice";

// A reset that throws still opens the app.
void runStartChoice()
  .catch(() => null)
  .then(async (outcome) => {
    await import("./i18n").then((i18n) => i18n.initLanguage()).catch(() => null);
    await import("./main");
    if (!outcome) return;
    const { toast } = await import("./ui/toast");
    const { text, kind } = startChoiceNotice(outcome);
    toast(text, { kind });
  });
