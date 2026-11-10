"""Up and Down in a tool's value box step the number as typing it would: the body follows, a screen reader hears the
new value, and Ctrl+Z takes the steps back before it touches the document."""

import pytest

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

BLOCK = "tools/harness/fixtures/block.json"
TOP = 15

# The polite region holds only its latest sentence, so every text it is given is kept for the test to read.
LISTEN = """() => {
  const polite = document.getElementById("a11y-polite");
  window.__spoken = [];
  if (window.__spokenObserver) window.__spokenObserver.disconnect();
  window.__spokenObserver = new MutationObserver(() => {
    const text = polite.textContent;
    if (text) window.__spoken.push(text);
  });
  window.__spokenObserver.observe(polite, { childList: true, characterData: true, subtree: true });
}"""

FIELD = """() => {
  const box = [...document.querySelectorAll('.dim-input')].find((b) => getComputedStyle(b).display !== 'none');
  const input = box?.querySelector('input:not([type=checkbox])');
  const ids = input?.getAttribute('aria-describedby')?.split(' ') ?? [];
  return {
    open: !!box,
    value: input?.value ?? null,
    focused: !!input && document.activeElement === input,
    described: ids.map((id) => document.getElementById(id)?.textContent ?? ''),
    steps: window.store.document.features.length,
    top: window.viewport.modelBox()?.max.z ?? null,
  };
}"""


@pytest.fixture
def s(session):
    yield session
    session.press("Escape")


def field(s):
    s.settle()
    return s.page.evaluate(FIELD)


def press_pull_top(s):
    s.press("Escape")
    s.new_document()
    s.open_file(BLOCK)
    s.view("iso")
    s.pick_face("top")
    s.press("q")
    f = field(s)
    assert f["open"] and f["focused"], f
    assert abs(f["top"] - TOP) < 1e-6, f
    return f


def test_up_steps_the_distance_the_body_follows_and_the_value_is_heard(s):
    start = press_pull_top(s)
    assert any(d.startswith("Up and Down change it by ") for d in start["described"]), start["described"]
    s.page.keyboard.type("5")
    s.page.evaluate(LISTEN)
    s.press("ArrowUp")
    up = field(s)
    assert 5 < float(up["value"]) <= 10, up
    assert abs(up["top"] - (TOP + float(up["value"]))) < 1e-3, up
    s.page.wait_for_function(
        "want => window.__spoken.some((t) => t.startsWith(want))", arg=f"{up['value']} millimetre", timeout=15_000
    )
    s.press("ArrowDown")
    assert field(s)["value"] == "5"
    s.press("Shift+ArrowUp")
    fine = field(s)["value"]
    assert 5 < float(fine) < float(up["value"]), fine
    s.press("Enter")
    after = field(s)
    assert not after["open"] and after["steps"] == start["steps"] + 1, after
    assert abs(after["top"] - (TOP + float(fine))) < 1e-3, after
    assert s.page_errors() == []


def test_ctrl_z_takes_the_steps_back_one_at_a_time_and_leaves_the_document(s):
    start = press_pull_top(s)
    s.page.keyboard.type("5")
    s.press("ArrowUp")
    one = field(s)["value"]
    s.press("ArrowUp")
    two = field(s)["value"]
    assert float(two) > float(one) > 5
    seen = []
    for _ in range(2):
        s.press("Ctrl+Z")
        seen.append(field(s)["value"])
    assert seen == [one, "5"]
    after = field(s)
    assert after["open"] and after["steps"] == start["steps"], after


def test_a_parameter_name_is_left_as_typed(s):
    press_pull_top(s)
    s.page.keyboard.type("width")
    s.press("ArrowUp")
    assert field(s)["value"] == "width"
