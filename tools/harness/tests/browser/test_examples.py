import importlib.util
from pathlib import Path

import pytest

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def example(name):
    spec = importlib.util.spec_from_file_location(f"example_{name}", EXAMPLES / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    yield session


def test_assembly_tree(s, tmp_path):
    example("assembly_tree").run(s, tmp_path)


def test_refused_commit(s):
    example("refused_commit").run(s)


def test_extrude_reedit(s):
    example("extrude_reedit").run(s)


def test_big_model_orbit(s, tmp_path):
    example("big_model_orbit").run(s, tmp_path)
