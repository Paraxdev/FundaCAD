"""Walks the AT-SPI tree of a running app, writes it to a file and fails on what
a screen reader cannot use: a showing button or menu item with no name, or no
web document at all.

    python3 scripts/a11y/atspi_dump.py --app fundacad --out atspi.txt

Linux only, needs at-spi2-core, gir1.2-atspi-2.0 and python3-gi, and a running
accessibility bus. The checks work on a plain tree of dicts, so they are tested
without any of that (tests/build/test_atspi_dump.py).
"""

import argparse
import os
import sys
import time

NAMED_ROLES = ("push button", "toggle button", "push button menu", "menu item")
DOCUMENT_ROLES = ("document web",)


def node(role, name="", states=("showing", "visible"), children=()):
    return {"role": role, "name": name, "states": list(states), "children": list(children)}


def live(n):
    return "defunct" not in n["states"] and "showing" in n["states"]


def label(n):
    return '%s "%s"' % (n["role"], n["name"]) if n["name"] else n["role"]


def select_apps(desktop, patterns):
    wanted = [p.lower() for p in patterns]
    return [a for a in desktop["children"] if any(p in a["name"].lower() for p in wanted)]


def problems(apps):
    if not apps:
        return ["no matching application on the accessibility bus"]
    found = []
    documents = 0

    def visit(n, path):
        nonlocal documents
        here = path + [label(n)]
        if n["role"] in DOCUMENT_ROLES and "defunct" not in n["states"]:
            documents += 1
        if n["role"] in NAMED_ROLES and live(n) and not n["name"].strip():
            found.append("nameless %s at %s" % (n["role"], " > ".join(here[-5:])))
        for c in n["children"]:
            visit(c, here)

    for app in apps:
        visit(app, [])
    if not documents:
        found.append("no document web node, the page never reached the accessibility bus")
    return found


def format_tree(n, depth=0):
    states = ",".join(s for s in n["states"] if s in ("showing", "defunct", "focused"))
    line = "%s%s%s" % ("  " * depth, label(n), " [%s]" % states if states else "")
    return [line] + [l for c in n["children"] for l in format_tree(c, depth + 1)]


def snapshot(max_nodes=20000, max_depth=80):
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib

    Atspi.init()
    # Milliseconds per call, so a hung app costs the walk seconds, not the job.
    Atspi.set_timeout(2000, 15000)
    kinds = [
        ("showing", Atspi.StateType.SHOWING),
        ("visible", Atspi.StateType.VISIBLE),
        ("defunct", Atspi.StateType.DEFUNCT),
        ("focused", Atspi.StateType.FOCUSED),
    ]
    budget = [max_nodes]

    def walk(acc, depth):
        try:
            role = acc.get_role_name() or ""
            name = acc.get_name() or ""
            ss = acc.get_state_set()
            states = [k for k, s in kinds if ss.contains(s)]
            count = acc.get_child_count()
        except GLib.Error as e:
            return node("unreadable", str(e), ("defunct",))
        kids = []
        for i in range(count if depth < max_depth else 0):
            if budget[0] <= 0:
                break
            budget[0] -= 1
            try:
                child = acc.get_child_at_index(i)
            except GLib.Error:
                continue
            if child is not None:
                kids.append(walk(child, depth + 1))
        return node(role, name, states, kids)

    desktop = Atspi.get_desktop(0)
    desktop.clear_cache()
    return walk(desktop, 0)


def run(take, patterns, out, wait, interval, sleep=time.sleep, clock=time.monotonic):
    """Retries until the checks pass or wait runs out, since WebKit builds the
    tree after the page loads, then writes the last walk and returns the exit code."""
    deadline = clock() + wait
    while True:
        desktop = take()
        apps = select_apps(desktop, patterns)
        found = problems(apps)
        if not found or clock() >= deadline:
            break
        sleep(interval)
    names = ", ".join(a["name"] for a in desktop["children"]) or "none"
    with open(out, "w", encoding="utf-8") as f:
        f.write("applications on the bus: %s\nchecked: %s\n\n" % (names, ", ".join(a["name"] for a in apps) or "none"))
        f.write("\n".join(format_tree(desktop)) + "\n")
    mark = "::error::" if os.environ.get("GITHUB_ACTIONS") else ""
    for p in found:
        print("%satspi: %s" % (mark, p))
    if not found:
        print("atspi: %d application(s) checked, no nameless control, a document is present" % len(apps))
    return 1 if found else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--app", action="append", required=True, help="part of the application name, repeatable")
    ap.add_argument("--out", required=True)
    ap.add_argument("--wait", type=float, default=60.0)
    ap.add_argument("--interval", type=float, default=2.0)
    args = ap.parse_args(argv)
    return run(snapshot, args.app, args.out, args.wait, args.interval)


if __name__ == "__main__":
    sys.exit(main())
