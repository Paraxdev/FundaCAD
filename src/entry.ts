// A Reset settings start (app/startChoice.ts) clears localStorage before main.ts loads, since its imports read their
// settings once, as they load. The language loads after the reset and before any label, so nothing paints in English
// first.
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
