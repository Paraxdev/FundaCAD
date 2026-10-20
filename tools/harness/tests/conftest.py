import os

import pytest

from fundacad_harness import Session
from fundacad_harness.browser import find_chrome
from fundacad_harness.errors import LaunchError
from fundacad_harness.launch import find_engine, find_repo


_why: list[str] = []


def _missing() -> str:
    if _why:
        return _why[0]
    _why.append("")
    try:
        find_engine(find_repo())
        find_chrome()
    except LaunchError as e:
        _why[0] = str(e)
    return _why[0]


def pytest_collection_modifyitems(config, items):
    for item in items:
        if "browser" in item.keywords:
            why = _missing()
            if why and not os.environ.get("CI"):
                item.add_marker(pytest.mark.skip(reason=why))


@pytest.fixture(scope="module")
def session():
    s = Session()
    yield s
    s.close()
