"""The Stress material rows sit all beside their labels or all under them, never a mix, with the boxes and the Material
select at one x, in the shipped face and Comfortable text, and a wider fallback face cuts no word and keeps one x for the
rows beside their labels. The Stress panel with History open stays inside a small window with its Run button in view, in
English, German, French and Spanish, and under a History of ten, fourteen and twenty-four features, opened before or after
it, with History whole again once Stress closes. The e2e job runs the light cases, e2e-heavy the rest."""

import pytest
from test_a11y import show_stress

from fundacad_harness import Session
from fundacad_harness.screens import out_dir, pick, settled

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

# Ten boxes, so History is tall enough to leave the Stress panel under it less room than its fixed rows and a short scroller.
TEN = "tools/harness/fixtures/history_ten.json"
SIZES = [(900, 800), (1366, 768), (1024, 600)]
LANGS = ["en", "de", "fr", "es"]
# Too short for the shelf under History, so the panel takes the narrow column left of it.
NARROW = (1024, 600)

# The visible box edges: the number wells and the Material select trigger, not the inputs inside the wells.
BOXES = ".stress-e, .stress-nu, .stress-yield, .stress-density"
MATERIAL = ".stress-keyed .select-trigger"

# A face wider than the shipped one, as a system face is when Space Grotesk fails to load.
WIDE_FACE = ':root { --ui: Verdana, "DejaVu Sans", sans-serif !important; }'
TEXTS = {
    "plain": (False, False),
    "wide": (True, False),
    "comfortable": (False, True),
}
SHIPPED = ("plain", "comfortable")
# The windows and texts whose rows sit beside their labels, the other shipped ones stack. Comfortable text at 900x800 gets
# a 250px row, under the width it stacks below.
BESIDE = {((900, 800), "plain"), ((1366, 768), "plain"), ((1366, 768), "comfortable")}


def case(light: bool, *values):
    """A case the e2e job runs when light, else one only e2e-heavy runs."""
    name = "-".join(f"{v[0]}x{v[1]}" if isinstance(v, tuple) else str(v) for v in values)
    return pytest.param(*values, marks=() if light else pytest.mark.heavy, id=name)


def wanted(request, keys) -> set:
    """What the selected tests that use this fixture read, from their parameters, so a run measures only that."""
    return {
        k
        for item in request.session.items
        if request.fixturename in getattr(item, "fixturenames", ())
        for k in keys(item.callspec.params if hasattr(item, "callspec") else {})
    }


READ = """([boxes, material]) => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const panel = document.querySelector('.stress-panel');
  const run = panel.querySelector('.stress-run');
  const body = panel.querySelector('.stress-setup');
  // Measured after scrolling the box into view, a box clipped out of the scrolled body reads the same left but not a real one.
  const seen = (e) => { e.scrollIntoView({ block: 'nearest' }); return e; };
  const row = (c) => {
    const k = seen(c.closest('.stress-field')).querySelector('.measure-k');
    const kb = box(k), cb = box(seen(c));
    return { l: Math.round(cb.l * 10) / 10, one_line: cb.t < kb.b && cb.b > kb.t };
  };
  // A word is cut when its own range spans two lines.
  const cut = [...panel.querySelectorAll('.stress-field > .measure-k:first-child')].flatMap((k) => {
    const node = k.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return [];
    return [...node.data.matchAll(/[^ ]+/g)].filter((m) => {
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      return new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size > 1;
    }).map((m) => m[0]);
  });
  return {
    window: [innerWidth, innerHeight],
    cut,
    panel: box(panel),
    run: run ? box(run) : null,
    step: body ? { client: body.clientWidth, bar: body.offsetWidth - body.clientWidth } : null,
    boxes: [...panel.querySelectorAll(boxes)].map(row),
    material: row(panel.querySelector(material)),
  };
}"""


def read(s: Session) -> dict:
    return s.page.evaluate(READ, [BOXES, MATERIAL])


def style(s: Session, id_: str, css: str) -> None:
    s.page.evaluate(
        """([id, css]) => { document.getElementById(id)?.remove();
          if (css) { const e = document.createElement('style'); e.id = id; e.textContent = css; document.head.append(e); } }""",
        [id_, css],
    )


def show_text(s: Session, wide: bool, comfortable: bool) -> None:
    style(s, "probe-face", WIDE_FACE if wide else "")
    s.page.evaluate("(c) => { if (c) document.documentElement.dataset.text = 'comfortable'; else delete document.documentElement.dataset.text; }", comfortable)


@pytest.fixture(scope="module")
def seen(request):
    keys = wanted(request, lambda p: [(p["size"], p.get("text", "plain"), p["lang"])])
    found = {}
    for size in sorted({k[0] for k in keys}):
        s = Session(viewport=size)
        try:
            s.open_file(TEN)
            s.panel("History", open=True)
            show_stress(s)
            pick(s, ".stress-material", "Custom")
            for text, look in TEXTS.items():
                langs = [lang for lang in LANGS if (size, text, lang) in keys]
                if langs:
                    show_text(s, *look)
                for lang in langs:
                    s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
                    settled(s)
                    found[(size, text, lang)] = read(s)
                    if text == "plain":
                        s.page.screenshot(path=str(out_dir() / f"stress_{size[0]}x{size[1]}_{lang}.png"))
        finally:
            s.close()
    return found


SEEN_CASES = [case(size == NARROW and text in SHIPPED and lang in ("en", "de"), size, text, lang) for size in SIZES for text in TEXTS for lang in LANGS]


def rows(got: dict) -> list:
    assert len(got["boxes"]) == 4, got
    return [got["material"], *got["boxes"]]


@pytest.mark.parametrize("size,text,lang", SEEN_CASES)
def test_the_material_rows_sit_all_beside_or_all_under_their_labels_at_one_x(seen, size, text, lang):
    got = seen[(size, text, lang)]
    every = rows(got)
    if text in SHIPPED:
        assert len({r["one_line"] for r in every}) == 1, got
        assert every[0]["one_line"] == ((size, text) in BESIDE), got
    else:
        # A fallback face can need more room than the stacking width allows for, so only its rows beside their labels
        # are held to one x.
        every = [r for r in every if r["one_line"]]
    lefts = [r["l"] for r in every]
    assert not lefts or max(lefts) - min(lefts) <= 1, got


@pytest.mark.parametrize("size,lang", [case(size == NARROW and lang in ("en", "de"), size, lang) for size in SIZES for lang in LANGS])
def test_stress_panel_and_run_stay_inside_the_window(seen, size, lang):
    got = seen[(size, "plain", lang)]
    assert got["run"] is not None
    assert got["panel"]["t"] >= -1
    assert got["panel"]["b"] <= size[1] + 1, got
    assert got["run"]["b"] <= got["panel"]["b"] + 1 and got["run"]["t"] >= got["panel"]["t"], got


@pytest.mark.parametrize("size,text,lang", SEEN_CASES)
def test_no_stress_label_is_cut_inside_a_word(seen, size, text, lang):
    assert seen[(size, text, lang)]["cut"] == [], seen[(size, text, lang)]


FIXTURES = {10: TEN, 14: "tools/harness/fixtures/history_fourteen.json", 24: "tools/harness/fixtures/history_twentyfour.json"}
GROWN_SIZES = [(900, 800), (1366, 768)]
# The History that is cut at 900x800, the one window and length the e2e job opens.
GROWN_LIGHT = ((900, 800), 24)

GROWN_READ = """() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const panel = document.querySelector('.stress-panel');
  const history = document.querySelector('#timeline');
  const run = panel.querySelector('.stress-run');
  return {
    panel: box(panel),
    run: run ? box(run) : null,
    history: box(history),
    history_cap: history.style.maxHeight,
    list: box(history.querySelector('.timeline-scroll')),
  };
}"""

HISTORY_READ = """() => {
  const history = document.querySelector('#timeline');
  const r = history.getBoundingClientRect();
  const list = history.querySelector('.timeline-scroll');
  return { cap: history.style.maxHeight, t: r.top, b: r.bottom, list: list.clientHeight };
}"""

# Scrolls History's list to its end and reads it again after one window resize.
SCROLL_KEPT = """async () => {
  const list = document.querySelector('#timeline .timeline-scroll');
  list.scrollTop = list.scrollHeight;
  const end = list.scrollTop;
  window.dispatchEvent(new Event('resize'));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { end, after: list.scrollTop };
}"""


@pytest.fixture(scope="module")
def grown(request):
    found = {}
    for size, count in sorted(wanted(request, lambda p: [(p["size"], c) for c in ([p["count"]] if "count" in p else FIXTURES)])):
        s = Session(viewport=size)
        try:
            s.open_file(FIXTURES[count])
            s.panel("History", open=True)
            settled(s)
            found[(size, count, "alone")] = s.page.evaluate(HISTORY_READ)
            show_stress(s)
            settled(s)
            found[(size, count, "history first")] = s.page.evaluate(GROWN_READ)
            found[(size, count, "scroll")] = s.page.evaluate(SCROLL_KEPT)
            s.panel("History", open=False)
            settled(s)
            s.panel("History", open=True)
            settled(s)
            found[(size, count, "stress first")] = s.page.evaluate(GROWN_READ)
            s.page.get_by_role("button", name="Close Stress").click()
            settled(s)
            found[(size, count, "closed")] = s.page.evaluate(HISTORY_READ)
        finally:
            s.close()
    return found


GROWN_CASES = [case((size, count) == GROWN_LIGHT, size, count) for size in GROWN_SIZES for count in FIXTURES]


@pytest.mark.parametrize("order", ["history first", "stress first"])
@pytest.mark.parametrize("size,count", GROWN_CASES)
def test_stress_panel_and_run_stay_inside_the_window_under_a_history_of_any_length(grown, size, count, order):
    got = grown[(size, count, order)]
    assert got["panel"]["t"] >= -1 and got["panel"]["b"] <= size[1] + 1, got
    assert got["run"]["t"] >= got["panel"]["t"] and got["run"]["b"] <= got["panel"]["b"] + 1, got
    assert got["panel"]["r"] - got["panel"]["l"] >= 250, got
    beside = got["panel"]["r"] <= got["history"]["l"] + 1 or got["panel"]["l"] >= got["history"]["r"] - 1
    assert beside or got["history"]["b"] <= got["panel"]["t"] + 1, got


@pytest.mark.heavy
@pytest.mark.parametrize("size", GROWN_SIZES)
def test_history_is_cut_only_where_the_panel_under_it_has_no_room_otherwise(grown, size):
    cut = {count: grown[(size, count, "history first")]["history_cap"] != "" for count in FIXTURES}
    if size == (900, 800):
        assert cut == {10: False, 14: True, 24: True}, grown
    else:
        assert not any(cut.values()), grown


@pytest.mark.parametrize("size,count", [case(True, *GROWN_LIGHT)])
def test_history_keeps_a_list_to_scroll_when_it_gives_room(grown, size, count):
    got = grown[(size, count, "history first")]
    assert got["list"]["b"] - got["list"]["t"] >= 40, got


@pytest.mark.parametrize("size,count", GROWN_CASES)
def test_history_is_whole_again_once_the_stress_panel_closes(grown, size, count):
    assert grown[(size, count, "closed")] == grown[(size, count, "alone")], grown


@pytest.mark.parametrize("size,count", GROWN_CASES)
def test_history_keeps_its_list_scrolled_where_it_was_when_the_window_resizes(grown, size, count):
    got = grown[(size, count, "scroll")]
    assert got["after"] == got["end"], got


# (window, interface size, History features, text, language). The first are shelves that History is cut for, the last
# two windows are shelves that hold the panel's least at its natural width but not at the 284px it gets there.
SHELF_CASES = [
    *[((900, h), 100, n, t, lang) for h in (800, 600) for n in (14, 24) for t in ("wide", "comfortable") for lang in ("en", "fr")],
    *[((1920, 1080), 200, n, "comfortable", lang) for n in (14, 24) for lang in ("en", "fr")],
    *[((900, h), 100, 10, "wide", "en") for h in (720, 725)],
    *[((900, h), 100, 10, "comfortable", "en") for h in (730, 735, 740)],
]
# Windows where History cut to its least still leaves the shelf short of the panel's least. At 990 wide the column left
# of History is 173px, under the panel's 180px min-width, and the shelf as short as that column.
LEAST_CASES = [
    *[((900, h), 100, 14, "wide", "en") for h in (398, 404, 407)],
    *[((900, h), 100, 14, "comfortable", "en") for h in (407, 413, 419)],
    *[((990, h), 100, n, "wide", "en") for h in (398, 402, 406) for n in (10, 14, 24)],
]
# One of each, both in the one session the e2e job opens.
SHELF_LIGHT = {((900, 800), 100, 14, "comfortable", "en"), ((900, 407), 100, 14, "comfortable", "en")}

# The column's bottom is the layer's, less the view cube's margin that place() keeps in CSS pixels under the root zoom.
COLUMN_BOTTOM = """() => {
  const z = Number(document.documentElement.style.zoom) || 1;
  const panel = document.querySelector('.stress-panel').getBoundingClientRect();
  const run = document.querySelector('.stress-panel .stress-run').getBoundingClientRect();
  const layer = document.getElementById('float-layer').getBoundingClientRect();
  return { panel_b: panel.bottom, panel_w: panel.width / z, run_b: run.bottom, column_b: layer.bottom - 14 * z, window_b: innerHeight };
}"""


@pytest.fixture(scope="module")
def shelved(request):
    found = {}
    cases = wanted(request, lambda p: [p["case"]])
    for pct, count in sorted({(c[1], c[2]) for c in cases}):
        s = Session(viewport=(900, 800))
        try:
            if pct != 100:
                s.page.evaluate("async (p) => (await import('/src/ui/interfaceSize.ts')).applyInterfaceSize(p)", pct)
            s.open_file(FIXTURES[count])
            s.panel("History", open=True)
            show_stress(s)
            pick(s, ".stress-material", "Custom")
            for one in [c for c in SHELF_CASES + LEAST_CASES if c in cases and c[1:3] == (pct, count)]:
                size, _, _, text, lang = one
                show_text(s, *TEXTS[text])
                s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
                s.page.set_viewport_size({"width": size[0], "height": size[1]})
                s.page.evaluate("() => window.dispatchEvent(new Event('resize'))")
                settled(s)
                found[one] = s.page.evaluate(COLUMN_BOTTOM)
        finally:
            s.close()
    return found


def shelf(c, interface: bool):
    name = f"{c[0][0]}x{c[0][1]}" + (f"@{c[1]}" if interface else "") + f"-{c[2]}-{c[3]}-{c[4]}"
    return pytest.param(c, marks=() if c in SHELF_LIGHT else pytest.mark.heavy, id=name)


@pytest.mark.parametrize("case", [shelf(c, True) for c in SHELF_CASES])
def test_stress_panel_ends_inside_its_column_and_the_window_under_a_cut_history(shelved, case):
    got = shelved[case]
    assert got["panel_b"] <= got["column_b"] + 1, got
    assert got["panel_b"] <= got["window_b"] + 1 and got["run_b"] <= got["panel_b"] + 1, got


# The column left of History is under the panel's min-width there, at 900 wide under 100px where its rows wrap far past
# the window.
@pytest.mark.parametrize("case", [shelf(c, False) for c in LEAST_CASES])
def test_stress_panel_keeps_its_shelf_when_history_is_cut_to_its_least(shelved, case):
    got = shelved[case]
    assert got["panel_w"] >= 180 and got["panel_b"] <= got["window_b"] + 1, got
