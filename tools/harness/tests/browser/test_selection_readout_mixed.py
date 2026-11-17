"""A face and an edge picked together are both named in the selection readout, the edge beside its length."""

import pytest
from playwright.sync_api import expect

from fundacad_harness import Session

pytestmark = [pytest.mark.browser]

READOUT = "[data-testid=selection-readout]"


@pytest.fixture(scope="module")
def s():
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        session.open_file("tools/harness/fixtures/block.json", discard=True)
        session.view("iso")
        yield session
    finally:
        session.close()


def test_a_face_and_an_edge_read_as_both(s):
    s.pick_face("top")
    s.pick_edge("between front right", add=True)
    expect(s.page.locator(READOUT)).to_have_text("1 face · 1 edge · 30 mm")
    s.pick_face("front", add=True)
    expect(s.page.locator(READOUT)).to_have_text("2 faces · 1 edge · 30 mm")
