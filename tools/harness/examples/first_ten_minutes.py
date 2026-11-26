"""A new maker's first ten minutes in one session, with time budgets. The app starts with Home and its welcome up,
every Start here example opens from its card and builds, the guided first bracket runs by Next from step 1 to its
finish, the part goes through File > Export… as STL, a 3,000 part printer STEP dropped on a blank document imports,
and Report a problem's preview holds the system line and the tour's crumbs.

The walk fails on a page error, an error notice, or a budget: Home 10 s, each document example 15 s, the printer
180 s (the software renderer on CI spends seconds a frame on 3,000 parts, see big_printer_import.py). They are
generous on purpose. A browser tab cannot write the STL, so Export ends in its refusal, which is expected here.

The times to Home, to each example built, to the printer import and for the whole walk are printed. Run with
`python tools/harness/examples/first_ten_minutes.py`.
"""

import json
import time

from fundacad_harness import Session

TOUR = "first-bracket"
STEPS = 14
PRINTER = "tests/fixtures/printer_3000.stpz"
PRINTER_LEAVES = 3000
HOME_BUDGET_S = 10
EXAMPLE_BUDGET_S = 15
PRINTER_BUDGET_S = 180

WATCH_OPEN = """() => {
  window.__exampleOpened = false;
  const off = window.store.onOpen(() => {
    window.__exampleOpened = true;
    off();
  });
}"""
OPENED = "() => window.__exampleOpened && window.store.document.features.length > 0"
HOME_UP = "() => !!document.querySelector('.home .home-example') && !!document.querySelector('.home .home-welcome')"
CARDS = """() => [...document.querySelectorAll('.home-examples .home-cell:not(.home-tour) .home-example-name')]
  .map((n) => n.textContent.trim())"""
PART = """() => {
  window.store.addFeature({ id: 'tenS', type: 'sketch', name: 'Plate sketch', plane: 'XY',
    entities: [{ type: 'rectangle', id: 'tenR', width: 40, height: 20, x: 0, y: 0 }] });
  window.store.addFeature({ id: 'tenE', type: 'extrude', sketch: 'tenS', distance: 10, operation: 'new' });
}"""
PREVIEW = "() => document.querySelector('.bug-preview pre')?.textContent ?? null"
# A browser tab has no filesystem path for the engine to write to, so Export ends in this refusal, which is not a fault.
NO_FILES = "Export needs the desktop app"
LANDED = "() => !window.store.busyState.active && window.store.document.features.some((f) => f.type === 'import')"


def until(s, cond, seconds=8.0):
    for _ in range(int(seconds * 10)):
        v = cond()
        if v:
            return v
        s.page.wait_for_timeout(100)
    return cond()


def expect_step(s, n):
    at = until(s, lambda: (lambda t: t if t and t["step"] == n and not t["ended"] else None)(s.tour(raw=True)))
    assert at == {"id": TOUR, "step": n, "of": STEPS, "ended": None}, (n, s.tour(raw=True), s.status())
    g = until(s, lambda: s.guide(raw=True))
    assert g and g["count"] == f"Step {n} of {STEPS}" and g["caption"], g
    return g


def no_trouble(s, mark, where):
    """Fails on a page error or an error notice since `mark`, naming the stage that raised it."""
    rows = s.messages(since=mark, raw=True)["rows"]
    errors = [m["text"] for m in rows if m["level"] == "error" and NO_FILES not in m["text"]]
    assert not errors, (where, errors)
    assert not s.page_errors(), (where, s.page_errors())


def start_home(s):
    """Reloads the app on the warm dev server and times it to Home with its welcome and examples on screen."""
    t0 = time.monotonic()
    s.page.goto(s.url, wait_until="domcontentloaded", timeout=60_000)
    s._wait_driver()
    s.page.wait_for_function(HOME_UP, timeout=HOME_BUDGET_S * 1000 * 3, polling=100)
    took = time.monotonic() - t0
    s._seen_navs = s._navs
    assert s.bridge.call("startScreen") == "home"
    return took


def home(s):
    if s.bridge.call("startScreen") != "home":
        s.menu("File/Home")


def open_example(s, name):
    unsaved = s.status(raw=True)["dirty"]
    home(s)
    s.page.evaluate(WATCH_OPEN)
    t0 = time.monotonic()
    s.page.click(f'.home-example:has-text("{name}")')
    if unsaved:
        s.click("Discard")
    s.page.wait_for_function(OPENED, timeout=EXAMPLE_BUDGET_S * 1000 * 4, polling=100)
    s.settle()
    return time.monotonic() - t0


def examples(s, mark, times):
    names = s.page.evaluate(CARDS)
    assert len(names) >= 5 and {"Wall bracket", "Box with a lid"} <= set(names), names
    for name in names:
        took = open_example(s, name)
        times[name] = took
        st = s.status(raw=True)
        assert (st["doc"], st["dirty"]) == (name, False), (name, st)
        assert s.last_error() == "none", (name, s.last_error())
        assert s.bodies(raw=True), f"{name} built no body"
        assert took < EXAMPLE_BUDGET_S, (name, took)
        no_trouble(s, mark, name)


def bracket(s, mark):
    """Next from step 1 to the last step, a part added at step 13 so the export has a body to write."""
    home(s)
    s.click("action:first-bracket")
    def is_bracket():
        return s.status(raw=True)["doc"] == "Bracket"

    until(s, lambda: is_bracket() or "Discard" in str(s.bridge.call("screen", region="dialog")["lines"]))
    if not is_bracket():
        s.click("Discard")
    assert until(s, is_bracket), s.status()
    g = expect_step(s, 1)
    assert g["on"] == "action:sketch" and g["ring"], g
    for n in range(1, 13):
        expect_step(s, n)
        s.click("#guide-next")
    expect_step(s, 13)
    s.page.evaluate(PART)
    s.settle()
    assert len(s.bodies(raw=True)) == 1, s.bodies()
    export_stl(s, mark)
    no_trouble(s, mark, "guided bracket")


def export_stl(s, mark):
    s.menu("File/Export…")
    expect_step(s, 14)
    trigger = s.page.locator("[data-testid=export-format]")
    trigger.wait_for(timeout=5000)
    if trigger.get_attribute("data-value") != "stl":
        trigger.click()
        s.page.get_by_role("option", name="STL (*.stl)").click()
    s.page.click("[data-testid=export-confirm]")
    seen = until(s, lambda: [m["text"] for m in s.messages(since=mark, raw=True)["rows"] if NO_FILES in m["text"]])
    assert seen, "Export said nothing in a browser tab"
    assert until(s, lambda: s.page.locator("[data-testid=export-confirm]").count() == 0), "Export stayed open"
    s.click("#guide-next")
    assert s.tour(raw=True) == {"id": TOUR, "step": 14, "of": STEPS, "ended": "finished"}, s.tour()
    s.wait_for("Guide finished")


def printer(s, mark):
    s.new_document()
    t0 = time.monotonic()
    s.import_file(PRINTER, settle=False)
    s.page.wait_for_function(LANDED, timeout=PRINTER_BUDGET_S * 1000, polling=200)
    s.settle(timeout=PRINTER_BUDGET_S)
    took = time.monotonic() - t0
    assert len(s.bodies(raw=True)) == PRINTER_LEAVES, len(s.bodies(raw=True))
    assert took < PRINTER_BUDGET_S, took
    no_trouble(s, mark, "printer")
    return took


def report(s, mark):
    s.menu("Help/Report a Problem…")
    s.page.wait_for_selector(".bug-report-card", timeout=5000)
    s.page.click(".bug-preview summary")
    text = until(s, lambda: s.page.evaluate(PREVIEW))
    assert text and text.startswith("FundaCAD problem report"), text
    lines = text.splitlines()
    system = [l for l in lines if l.startswith("system: ")]
    assert system and system[0][len("system: "):].strip(), lines[:12]
    tour = [l for l in lines if "[tour] " + TOUR in l]
    assert any(l.endswith(f"{TOUR} ended finished at step {STEPS} of {STEPS}") for l in tour), (tour, lines)
    assert any(f"{TOUR} step " in l and f" of {STEPS}" in l for l in tour), tour
    s.page.click(".bug-cancel")
    assert until(s, lambda: s.page.locator(".bug-report-card").count() == 0), "Report a problem stayed open"
    no_trouble(s, mark, "report")


def run(s):
    walk = time.monotonic()
    mark = s.bridge.call("seq")
    times = {"home": start_home(s)}
    assert times["home"] < HOME_BUDGET_S, times
    examples(s, mark, times)
    bracket(s, mark)
    # Before the printer: with 3,000 bodies drawn the page is too busy to take a menu click for seconds.
    report(s, mark)
    times["printer"] = printer(s, mark)
    times["walk"] = time.monotonic() - walk
    print("first ten minutes:", json.dumps({k: round(v, 1) for k, v in times.items()}), flush=True)
    return times


if __name__ == "__main__":
    with Session() as s:
        run(s)
    print("first ten minutes: all checks passed")
