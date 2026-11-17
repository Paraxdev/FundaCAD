"""A chamfer on every edge of a body says so in its History properties and in the selection editor, where its one
selector read as "1 edge" and as an edge missing from the build."""

import json
import re

import pytest
from playwright.sync_api import expect

from fundacad_harness import Session

pytestmark = [pytest.mark.browser]

DOC = {
    "version": 10,
    "parameters": {},
    "features": [
        {"id": "bx", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "c", "type": "chamfer", "distance": 1, "edges": {"kind": "edge", "by": "all", "body": "body1"}},
    ],
}


@pytest.fixture(scope="module")
def s(tmp_path_factory):
    path = tmp_path_factory.mktemp("every-edge") / "every-edge.json"
    path.write_text(json.dumps(DOC), encoding="utf-8")
    session = Session(settle_timeout=120)
    try:
        session.dismiss_start()
        session.open_file(path, discard=True)
        session.settle()
        yield session
    finally:
        session.close()


def test_the_properties_row_says_every_edge(s):
    s.page.locator(".timeline-node[data-id=c]").click()
    row = s.page.locator(".timeline-props .param-row", has_text="Edges")
    expect(row.locator(".target-count")).to_have_text("every edge")


def test_the_editor_names_the_row_by_what_it_covers(s):
    row = s.page.locator(".timeline-props .param-row", has_text="Edges")
    row.locator(".target-edit").click()
    panel = s.page.locator(".tgt-panel")
    try:
        expect(panel.locator(".tgt-sub")).to_have_text("every edge")
        item = panel.locator(".tgt-item")
        expect(item).to_have_count(1)
        expect(item).to_contain_text("Every edge")
        expect(item).not_to_have_class(re.compile(r"tgt-unresolved"))
    finally:
        panel.locator(".tgt-cancel").click()
