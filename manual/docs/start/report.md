# Report a problem

When something goes wrong, or does not do what you expected, tell us. The report opens from any of these:

1. Help > Report a Problem…
2. the bug button at the foot of the view controls, on the right of the view;
3. Report a problem, on the Home screen or on the safe mode banner;
4. Report, on the notice that says the geometry engine stopped.

## Send a report

1. Write what happened and what you expected. This is the only box you have to fill in.
2. If a picture helps, click Save Picture…. It renders the 3D view and asks where to save `fundacad-report.png`.
3. Click Open on GitHub. The report is copied, and a new Problem report opens on GitHub with the title, your description, the version and your system filled in.
4. Paste the report into the Report box, drag in the picture if you saved one, and submit.

Opening an issue needs a GitHub account, and nothing leaves your computer until you submit it. If signing in replaces what you copied, click Copy Again.

## What a report holds

What will be sent shows the exact text before anything is copied:

1. the version, your system, the engine and the plugins that run;
2. your description;
3. your last steps and the last three errors;
4. the end of the app log, unless you untick it;
5. the current document, only when you tick it.

User names in file paths are hidden. A document too big for an issue is left out, so put the `.funda` file in a `.zip` and drag it into the issue yourself.

## Reduced rights

On Windows and Linux, the geometry engine runs with reduced rights: it can write only to FundaCAD's own folders, and on Linux it cannot reach the network. If support asks you to, start FundaCAD with the environment variable `FUNDACAD_ENGINE_SANDBOX=0` to turn this off.

## Ideas

Help > Suggest an Idea opens the Idea form on GitHub. Say what you are trying to make and what would help.
