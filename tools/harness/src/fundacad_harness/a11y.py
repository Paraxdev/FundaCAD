"""Accessibility checks over a harness page: a vendored axe-core run and a baseline that only shrinks."""

from __future__ import annotations

import hashlib
import json
from importlib import resources
from pathlib import Path
from typing import Any

from .errors import HarnessError

AXE_VERSION = "4.10.2"
AXE_SHA256 = "b511cd9dec01c76f4b2ad1723b66b6db37d4c2eb4ed199076e1829d9ee7b75e3"
# wcag22aa alone holds only the rules new in 2.2, the 2.0 and 2.1 tags carry the rest.
AXE_TAGS = ("wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa")

_RUN = (
    "(tags) => axe.run(document, {runOnly: {type: 'tag', values: tags}, resultTypes: ['violations']})"
    ".then(r => r.violations.map(v => ({id: v.id, impact: v.impact, help: v.help,"
    " nodes: v.nodes.map(n => ({target: n.target, html: n.html, summary: n.failureSummary}))})))"
)

Counts = dict[str, int]
Baseline = dict[str, Counts]


def axe_source(data: bytes | None = None) -> str:
    if data is None:
        data = (resources.files(__package__) / "vendor" / f"axe-{AXE_VERSION}.min.js").read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != AXE_SHA256:
        raise HarnessError(f"vendored axe-core {AXE_VERSION} has sha256 {digest}, expected {AXE_SHA256}")
    return data.decode("utf-8")


def load_axe(page: Any) -> str:
    if not page.evaluate("() => typeof window.axe === 'object' && typeof window.axe.run === 'function'"):
        page.add_script_tag(content=axe_source())
    return page.evaluate("() => axe.version")


def axe_violations(page: Any) -> list[dict]:
    load_axe(page)
    return page.evaluate(_RUN, list(AXE_TAGS))


def counts(violations: list[dict]) -> Counts:
    return {v["id"]: len(v["nodes"]) for v in violations if v["nodes"]}


def over_baseline(found: Counts, allowed: Counts) -> list[str]:
    return [
        f"{rule}: {n} nodes, the baseline allows {allowed.get(rule, 0)}"
        for rule, n in sorted(found.items())
        if n > allowed.get(rule, 0)
    ]


def under_baseline(found: Counts, allowed: Counts) -> list[str]:
    return [
        f"{rule}: {found.get(rule, 0)} nodes, the baseline allows {n}, lower it with FUNDACAD_AXE_LOWER=1"
        for rule, n in sorted(allowed.items())
        if found.get(rule, 0) < n
    ]


def lowered(found: Counts, allowed: Counts) -> Counts:
    out = {rule: min(n, found.get(rule, 0)) for rule, n in sorted(allowed.items())}
    return {rule: n for rule, n in out.items() if n > 0}


def lowered_baseline(results: dict[str, Counts], baseline: Baseline) -> Baseline:
    """Lower each screen that ran, keep the ones that did not, never add a screen or a rule."""
    out: Baseline = {}
    for screen, allowed in sorted(baseline.items()):
        out[screen] = lowered(results[screen], allowed) if screen in results else dict(allowed)
    return {screen: rules for screen, rules in out.items() if rules}


def read_baseline(path: Path) -> Baseline:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_baseline(path: Path, baseline: Baseline) -> None:
    path.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n", encoding="utf-8")
