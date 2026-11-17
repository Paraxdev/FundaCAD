import sys
import types
from pathlib import Path

import pytest

from fundacad_harness import Session, session
from fundacad_harness.browser import find_chrome
from fundacad_harness.errors import LaunchError

REPO = Path(__file__).resolve().parents[4]


class FakePlaywright:
    def __init__(self):
        self.contexts: list[dict] = []
        browser = types.SimpleNamespace(new_context=self._new_context, close=lambda: None)
        self.chromium = types.SimpleNamespace(launch=lambda **kw: browser)

    def _new_context(self, **kw):
        self.contexts.append(kw)
        return types.SimpleNamespace(new_page=lambda: types.SimpleNamespace(on=lambda *a: None))

    def start(self):
        return self

    def stop(self):
        pass


def test_the_browser_context_is_english_dark_and_sized(monkeypatch):
    import playwright.sync_api as api

    pw = FakePlaywright()
    monkeypatch.setattr(api, "sync_playwright", lambda: pw)
    s = Session(engine=sys.executable, chrome=sys.executable, repo=REPO, open=False, viewport=(1234, 777), scale=1.5)
    try:
        s._launch_browser()
        assert pw.contexts == [
            {
                "viewport": {"width": 1234, "height": 777},
                "device_scale_factor": 1.5,
                "color_scheme": "dark",
                "locale": "en-US",
            }
        ]
    finally:
        s.close()


# A German browser, so the page reads en-US only because the Session pins it.
# Headless Chrome takes --accept-lang on every OS, --lang is ignored on Linux.
def test_the_page_reads_en_us_in_a_german_browser(monkeypatch):
    try:
        chrome = find_chrome()
    except LaunchError as e:
        pytest.skip(str(e))
    german = session.chrome_args
    monkeypatch.setattr(session, "chrome_args", lambda gpu: [*german(gpu), "--accept-lang=de-DE"])
    s = Session(engine=sys.executable, chrome=chrome, repo=REPO, open=False, headed=False)
    try:
        s._launch_browser()
        langs = "[navigator.language, navigator.languages]"
        assert s.page.evaluate(langs) == ["en-US", ["en-US"]]
        unpinned = s._browser.new_context().new_page()
        assert unpinned.evaluate(langs) == ["de-DE", ["de-DE"]]
    finally:
        s.close()
