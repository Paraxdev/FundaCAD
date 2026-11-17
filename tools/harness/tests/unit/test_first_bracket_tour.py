import importlib.util
from pathlib import Path

import pytest

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "first_bracket_tour.py"

BOX = {"min": [0, -25, 0], "max": [50, 0, 50]}


@pytest.fixture(scope="module")
def walk():
    spec = importlib.util.spec_from_file_location("example_first_bracket_tour", EXAMPLE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_l_has_six_corners_and_stops_short_of_the_first_one(walk):
    assert len(walk.L) == 6 and len(set(walk.L)) == 6
    assert walk.SHORT not in walk.L
    assert walk.SHORT[0] == walk.L[0][0], "on the line back to the first corner, so the L is left open"


def test_extent_is_the_size_along_each_axis(walk):
    assert walk.extent(BOX) == (50, 25, 50)
    assert walk.extent({"min": [-1.004, 2, 3], "max": [49.0, 32.0, 53.5]}) == (50.0, 30, 50.5)


def test_the_inside_corner_is_one_arm_in_from_the_low_corner_halfway_through(walk):
    assert walk.inside_corner(BOX) == "near=5,-12.5,5"
    assert walk.inside_corner({"min": [10, 0, 2], "max": [60, 30, 52]}, arm=4) == "near=14,15,6"


def test_a_point_on_the_inside_face_sits_one_arm_in_from_the_low_x_face(walk):
    assert walk.on_inside(BOX, 42) == (5, -12.5, 42)
