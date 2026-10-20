from pathlib import Path

from fundacad_harness import session


def test_remove_dir_tries_again_when_a_file_is_still_held(tmp_path, monkeypatch):
    work = tmp_path / "w"
    (work / "blobs").mkdir(parents=True)
    calls = []
    real = session.shutil.rmtree

    def held_once(path, ignore_errors=False):
        calls.append(path)
        if len(calls) > 1:
            real(path, ignore_errors=ignore_errors)

    monkeypatch.setattr(session.shutil, "rmtree", held_once)
    naps = []
    assert session.remove_dir(work, sleep=naps.append)
    assert len(calls) == 2 and naps == [0.5]
    assert not work.exists()


def test_remove_dir_says_when_the_folder_stays(tmp_path, monkeypatch):
    work = tmp_path / "w"
    work.mkdir()
    monkeypatch.setattr(session.shutil, "rmtree", lambda path, ignore_errors=False: None)
    naps = []
    assert not session.remove_dir(work, sleep=naps.append)
    assert naps == [0.5, 0.5]
    assert work.exists()
