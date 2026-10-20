"""The selector grammar for faces, edges and controls, checked before a call reaches the page.

Faces: `[body:]top|bottom|front|back|left|right|+x|-z|normal=x,y,z|largest|smallest [planar|curved]
|near=x,y,z|index=n`. Edges: `[body:]near=x,y,z|between <face> <face>|longest|shortest`.
"""

from __future__ import annotations

import re

from .errors import BadArgs

SIDES = {"top", "bottom", "front", "back", "left", "right", "+x", "-x", "+y", "-y", "+z", "-z"}
REF = re.compile(r"^(#|(action|family|pick|group|feature|item|folder|eye|field|prop|testid|tab|workspace|view-mode|"
                 r"category|menu|ctx|choice|opt|text):)")
_VEC = r"-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?"


def is_ref(target: str) -> bool:
    return bool(REF.match(target))


def _split(sel: str) -> tuple[str | None, str]:
    s = " ".join(sel.strip().split())
    m = re.match(r"^([^:=\s]+):(.*)$", s)
    if m:
        return m.group(1), m.group(2).strip().lower()
    return None, s.lower()


def _face_words_ok(w: str) -> bool:
    w = w.replace(" ", "")
    return (w in SIDES or re.fullmatch(rf"(normal|near)={_VEC}", w) is not None
            or re.fullmatch(r"index=\d+", w) is not None)


def face(sel: str) -> str:
    body, w = _split(sel)
    ok = _face_words_ok(w) or re.fullmatch(r"(largest|smallest)( (planar|curved))?", w) is not None
    if not ok:
        raise BadArgs(f'cannot read face selector "{sel}", use top, bottom, front, back, left, right, '
                      "+x, normal=x,y,z, largest, smallest, near=x,y,z or index=n")
    if w.startswith(("normal=", "near=")):
        w = w.replace(" ", "")
    return f"{body}:{w}" if body else w


def edge(sel: str) -> str:
    body, w = _split(sel)
    m = re.fullmatch(r"between (\S+) (\S+)", w)
    ok = (w in ("longest", "shortest") or re.fullmatch(rf"near={_VEC}", w.replace(" ", "")) is not None
          or (m is not None and all(_face_words_ok(x) or x in ("largest", "smallest") for x in m.groups())))
    if not ok:
        raise BadArgs(f'cannot read edge selector "{sel}", use near=x,y,z, between <face> <face>, longest or shortest')
    if w.startswith("near="):
        w = w.replace(" ", "")
    return f"{body}:{w}" if body else w


def canvas_target(target: str) -> tuple[str, str] | None:
    """`face:body1:top` or `edge:near=1,2,3` name something on the canvas; anything else is a control."""
    for kind in ("face", "edge"):
        if target.startswith(kind + ":"):
            rest = target[len(kind) + 1:]
            return kind, face(rest) if kind == "face" else edge(rest)
    return None
