import pytest

import fundacad_harness
from fundacad_harness import Session

pytestmark = pytest.mark.browser


def test_a_recorded_walk_replays_to_the_same_history(tmp_path, monkeypatch):
    out = tmp_path / "walk.py"
    with Session(record=out) as s:
        s.open_file("tools/harness/fixtures/plate.json")
        s.view("iso")
        s.pick_face("top")
        s.tool("Press/Pull")
        s.type("D", "4", enter=True)
        first = s.history()
    script = out.read_text(encoding="utf-8")
    assert 's.type("field:distance", "4", enter=True)  # "D"' in script
    assert 's.tool("Press/Pull")  # action:offer:presspull' in script

    seen = []

    class Replaying(Session):
        def close(self):
            if not self.closed:
                seen.append(self.history())
            return super().close()

    monkeypatch.setattr(fundacad_harness, "Session", Replaying)
    exec(compile(script, str(out), "exec"), {"__name__": "__main__"})
    assert seen == [first]
    assert "press-pull" in first
