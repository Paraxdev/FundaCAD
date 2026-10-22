import importlib.util
from pathlib import Path

import pytest

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "big_model_orbit.py"


@pytest.fixture(scope="module")
def orbit():
    spec = importlib.util.spec_from_file_location("example_big_model_orbit", EXAMPLE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_reads_the_product_margins(orbit):
    gain = orbit.product_constant("MIN_GAIN")
    assert 0 < gain < 1
    assert orbit.product_constant("MERGE_ON_DRAWS") >= 1


def test_a_renamed_constant_fails_loudly(orbit, tmp_path):
    src = tmp_path / "edgeMotion.ts"
    src.write_text("export const THIN_BUDGET_MS = 33;\nconst MIN_GAIN = 0.3;\n")
    assert orbit.product_constant("MIN_GAIN", src) == 0.3
    assert orbit.product_constant("THIN_BUDGET_MS", src) == 33
    with pytest.raises(AssertionError):
        orbit.product_constant("MAX_GAIN", src)


@pytest.mark.parametrize(
    "full, thin, pays",
    [
        (469, 92, True),  # a GPU here
        (1043, 550, True),  # CI's software renderer on a green run
        (971.1, 1022.5, False),  # CI's run 39841403474, frames dominated by something else
        (1000, 700, True),  # exactly the margin
        (1000, 701, False),
        (0, 92, False),  # nothing measured
        (469, 0, False),
    ],
)
def test_thin_pays_by_the_product_margin(orbit, full, thin, pays):
    assert orbit.thin_pays(full, thin, 0.3) is pays
