"""A traced picture is taken, heard and cancelled by keys alone, and axe passes the Camera tab. The harness browser has
no tracer, so the two viewport methods are stubbed on the live instance the component uses."""

import pytest
from fundacad_harness.a11y import AXE_TAGS, load_axe
from test_announcer import heard, listen
from test_sketch_keys import COUNT_POINTERS, no_pointer

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

STUB = """(png) => {
  const v = window.viewport;
  v.tracedPictureSize = (s) => ({ width: 320 * s, height: 200 * s });
  window.__trace = null;
  v.renderTracedPicture = (o) => new Promise((resolve, reject) => {
    const t = { onProgress: o.onProgress, samples: o.samples, aborted: false, finish: () => resolve(png) };
    o.signal.addEventListener("abort", () => {
      t.aborted = true;
      reject(new DOMException("The picture was cancelled", "AbortError"));
    });
    // Reported in the task that stamped the start, so the one second hold never depends on the runner's speed.
    o.onProgress(12);
    window.__trace = t;
  });
}"""
UNSTUB = """() => {
  delete window.viewport.tracedPictureSize;
  delete window.viewport.renderTracedPicture;
  delete window.__trace;
}"""
SET_VERBOSITY = """async (v) => (await import("/src/ui/a11yPrefs.ts")).setA11yPref("verbosity", v)"""
FOCUS = """() => {
  const e = document.activeElement;
  return { id: e?.id ?? "", role: e?.getAttribute("role") ?? "", text: (e?.textContent ?? "").trim(),
    dock: !!e?.closest("#renderdock") };
}"""
BUTTON = "() => document.getElementById('rd-take-picture').textContent.trim()"
BAR = "#renderdock [role=progressbar]"
SAMPLES = 256


def go_to_the_take_picture_button(s):
    kb = s.page.keyboard
    kb.press("Control+K")
    s.page.wait_for_selector(".cmdk-card")
    kb.type("materials")
    s.page.wait_for_timeout(200)
    kb.press("Enter")
    s.page.locator("#renderdock").wait_for()
    walk = []
    for _ in range(200):
        kb.press("Tab")
        walk.append(s.page.evaluate(FOCUS))
        if walk[-1]["role"] == "tab" and walk[-1]["dock"]:
            break
    else:
        raise AssertionError(f"no tab reached, walk {walk}")
    for _ in range(3):
        if s.page.evaluate(FOCUS)["text"] == "Camera":
            break
        kb.press("ArrowRight")
    assert s.page.evaluate(FOCUS)["text"] == "Camera"
    for _ in range(120):
        kb.press("Tab")
        walk.append(s.page.evaluate(FOCUS))
        if walk[-1]["id"] == "rd-take-picture":
            return
    raise AssertionError(f"rd-take-picture not reached, walk {walk[-12:]}")


def trace(s):
    s.page.wait_for_function("() => window.__trace !== null")


def value_text(s):
    return s.page.locator(BAR).get_attribute("aria-valuetext")


def wait_value(s, want):
    s.page.wait_for_function(
        "([sel, want]) => document.querySelector(sel)?.getAttribute('aria-valuetext') === want", arg=[BAR, want]
    )


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    session.page.evaluate(STUB, PNG)
    yield session
    try:
        session.page.evaluate(SET_VERBOSITY, "normal")
        session.page.evaluate(UNSTUB)
        session.page.click('[data-workspace="model"]')
        session.page.locator("#renderdock").wait_for(state="detached")
    except Exception:
        pass


def test_a_traced_picture_is_taken_by_keys_and_each_quarter_is_heard_at_verbose(s):
    s.page.evaluate(SET_VERBOSITY, "verbose")
    go_to_the_take_picture_button(s)
    s.page.evaluate(COUNT_POINTERS)
    listen(s)
    kb = s.page.keyboard
    kb.press("Enter")
    heard(s, "Render started, 256 samples")
    trace(s)
    assert s.page.evaluate("() => window.__trace.samples") == SAMPLES
    s.page.wait_for_timeout(120)
    assert value_text(s) == "0 of 256 samples"
    assert s.page.get_by_role("button", name="Cancel render").count() == 1

    s.page.wait_for_timeout(1100)
    s.page.evaluate("() => window.__trace.onProgress(20)")
    wait_value(s, "20 of 256 samples")
    assert s.page.get_by_role("button", name="Cancel render").count() == 1
    assert "Rendered" not in " ".join(s.page.evaluate("() => window.__spoken"))

    quarters = ((64, "Rendered 64 of 256 samples"), (140, "Rendered 140 of 256 samples"), (200, "Rendered 200 of 256 samples"))
    for done, said in quarters:
        s.page.evaluate("n => window.__trace.onProgress(n)", done)
        wait_value(s, f"{done} of 256 samples")
        heard(s, said)
        assert s.page.get_by_role("button", name="Cancel render").count() == 1
        assert s.page.locator(BAR).get_attribute("aria-valuenow") == str(done)

    s.page.evaluate("() => window.__trace.onProgress(256)")
    wait_value(s, "256 of 256 samples")
    assert s.page.locator(BAR).get_attribute("aria-valuemax") == "256"
    s.page.evaluate("() => window.__trace.finish()")
    spoken = heard(s, "Saved render")
    heard(s, "Render finished")
    assert s.page.locator(BAR).count() == 0

    wanted = [
        "Render started, 256 samples",
        "Rendered 64 of 256 samples",
        "Rendered 140 of 256 samples",
        "Rendered 200 of 256 samples",
        "Render finished",
        "Saved render.png",
    ]
    text = s.page.evaluate("() => window.__spoken.join(' | ')")
    at = [text.find(w) for w in wanted]
    assert all(i >= 0 for i in at) and at == sorted(at), f"{spoken}"
    no_pointer(s)


def test_a_traced_picture_is_cancelled_by_keys_at_normal_and_says_so_without_quarters(s):
    s.page.evaluate(SET_VERBOSITY, "normal")
    go_to_the_take_picture_button(s)
    s.page.evaluate(COUNT_POINTERS)
    listen(s)
    kb = s.page.keyboard
    kb.press("Enter")
    heard(s, "Render started, 256 samples")
    trace(s)
    s.page.evaluate("() => window.__trace.onProgress(70)")
    wait_value(s, "70 of 256 samples")
    assert s.page.evaluate(BUTTON) == "Cancel render"
    kb.press("Enter")
    heard(s, "Render cancelled")
    assert s.page.evaluate("() => window.__trace.aborted") is True
    s.page.locator(BAR).wait_for(state="detached")
    s.page.wait_for_function("() => document.getElementById('rd-take-picture').textContent.trim() !== 'Cancel render'")
    assert s.page.evaluate(BUTTON) == "Save picture…"
    spoken = s.page.evaluate("() => window.__spoken.join(' | ')")
    assert "Rendered" not in spoken and "Saved" not in spoken, spoken
    no_pointer(s)


def axe_on_the_dock(s):
    load_axe(s.page)
    return s.page.evaluate(
        """(tags) => axe.run(document.getElementById("renderdock"), {runOnly: {type: "tag", values: tags},
          resultTypes: ["violations"]}).then((r) => r.violations.map((v) => ({ id: v.id,
          nodes: v.nodes.map((n) => n.target) })))""",
        list(AXE_TAGS),
    )


def test_axe_finds_nothing_on_the_camera_tab_idle_or_while_tracing(s):
    go_to_the_take_picture_button(s)
    assert axe_on_the_dock(s) == []
    s.page.keyboard.press("Enter")
    trace(s)
    s.page.evaluate("() => window.__trace.onProgress(64)")
    wait_value(s, "64 of 256 samples")
    assert s.page.locator(BAR).count() == 1
    try:
        assert axe_on_the_dock(s) == []
    finally:
        s.page.evaluate("() => window.__trace.finish()")
        s.page.locator(BAR).wait_for(state="detached")
