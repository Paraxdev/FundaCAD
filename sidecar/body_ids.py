"""Stable body ids.

A body's id is remembered against where it came from (the feature that made it,
and which of that feature's bodies it was) in the document's `bodyIds` map, so
switching off, failing or reordering a feature leaves every other body's id
alone. A document without the map is numbered by position, exactly as before
the map existed, and the build reports the map it used so the app can keep it.
"""

import re

_NUM = re.compile(r"body(\d+)")


def number(bid):
    m = _NUM.fullmatch(bid) if isinstance(bid, str) else None
    return int(m.group(1)) if m else 0


class BodyIds:
    def __init__(self, recorded):
        self.recorded = recorded if isinstance(recorded, dict) else None
        self.floor = max((number(v) for v in (self.recorded or {}).values()), default=0)
        self.events = []
        self.taken = set()
        self.top = 0
        self.feature = None
        self.made = 0
        self.keys = set()

    def start_feature(self, fid):
        self.feature = fid
        self.made = 0

    def key(self, node_ref=None):
        key = node_ref or f"{self.feature}:{self.made}"
        if key in self.keys:
            key = f"{self.feature}:{self.made}#"
        self.made += 1
        self.keys.add(key)
        return key

    def assign(self, key, inherit=None):
        rec = self.recorded
        if rec is None:
            bid = None
        elif inherit and rec.get(key, inherit) == inherit:
            bid = inherit
        elif rec.get(key) and rec[key] not in self.taken:
            bid = rec[key]
        else:
            bid = None
        if bid is None:
            bid = f"body{max(self.top, self.floor) + 1}"
        self.top = max(self.top, number(bid))
        self.taken.add(bid)
        self.keys.add(key)
        self.events.append((key, inherit, bid))
        return bid

    def mark(self):
        return len(self.events)

    def restore(self, events):
        """Replay a cached prefix under this document's map. False when the map
        would now number that prefix differently, so the cache cannot be used."""
        for key, inherit, bid in events:
            if self.assign(key, inherit) != bid:
                return False
        return True

    def resulting_map(self):
        out = dict(self.recorded or {})
        for key, _inherit, bid in self.events:
            out[key] = bid
        return out
