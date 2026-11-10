"""Runs axe-core over every page of the built manual, once light with motion and once dark with reduced motion.

    python manual/tools/axe_site.py manual/site [--chrome /usr/bin/google-chrome] [--lower]

Each page must stay within manual/tools/axe-baseline.json, which only shrinks: --lower writes what is found. It also
checks that the palette follows the system's light or dark setting, and that an animation plays or rests as the
system's motion setting says and its button turns it the other way.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import sys
import threading
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "harness" / "src"))

from fundacad_harness.a11y import AXE_TAGS, counts, load_axe, lowered, over_baseline  # noqa: E402

BASELINE = Path(__file__).with_name("axe-baseline.json")
# (colour scheme, motion setting, the palette the theme should pick for it)
MODES = (("light", "no-preference", "default"), ("dark", "reduce", "slate"))

SEARCH_KEY = "the theme's search"
# Zensical's search sits in an open shadow root on a bare div at the end of body. It is the theme's and the same on
# every page, so its nodes are counted once per mode under SEARCH_KEY and taken out of each page's count. axe's exclude
# does not reach into a shadow root, so the nodes are split after the run.
RUN = """(tags) => axe.run(document, {runOnly: {type: 'tag', values: tags}, resultTypes: ['violations'], elementRef: true})
  .then(r => {
    const host = [...document.querySelectorAll('body > div')].find(d => d.shadowRoot?.querySelector('input[role=combobox]'));
    const inSearch = el => !!host && (el === host || host.shadowRoot.contains(el));
    const part = search => r.violations
      .map(v => ({id: v.id, impact: v.impact, help: v.help, nodes: v.nodes
        .filter(n => inSearch(n.element) === search)
        .map(n => ({target: n.target, html: n.html, summary: n.failureSummary}))}))
      .filter(v => v.nodes.length);
    return {page: part(false), search: part(true)};
  })"""

MOTION = """() => [...document.querySelectorAll('.md-typeset img.fc-motion')].map(img => ({
  src: img.getAttribute('src'), button: img.nextElementSibling?.matches('button') ? img.nextElementSibling.textContent : null
}))"""


def page_urls(site: Path) -> list[str]:
    urls = []
    for p in sorted(site.rglob("*.html")):
        rel = p.relative_to(site).as_posix()
        if rel.startswith("assets/"):
            continue
        urls.append("/" + rel.removesuffix("index.html"))
    return urls


def motion_problems(state: list[dict], playing: bool, where: str) -> list[str]:
    want_src, want_button = (".gif", "Pause animation") if playing else ("-still.png", "Play animation")
    return [
        f"{where}: {s['src']} with button {s['button']!r}, expected a {want_src} and {want_button!r}"
        for s in state
        if not (s["src"] or "").endswith(want_src) or s["button"] != want_button
    ]


def serve(site: Path) -> http.server.ThreadingHTTPServer:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(site)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def axe(page) -> dict[str, list[dict]]:
    load_axe(page)
    return page.evaluate(RUN, list(AXE_TAGS))


def walk(site: Path, chrome: str | None) -> tuple[dict[str, dict[str, int]], list[str], dict[str, list[dict]]]:
    from playwright.sync_api import sync_playwright

    found: dict[str, dict[str, int]] = {}
    details: dict[str, list[dict]] = {}
    problems: list[str] = []
    server = serve(site)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=chrome) if chrome else pw.chromium.launch()
            for scheme, motion, palette in MODES:
                context = browser.new_context(
                    color_scheme=scheme, reduced_motion=motion, viewport={"width": 1280, "height": 900}
                )
                page = context.new_page()
                for i, url in enumerate(page_urls(site)):
                    key = f"{scheme}: {url}"
                    page.goto(base + url, wait_until="load")
                    result = axe(page)
                    runs = [(key, result["page"])] + ([(f"{scheme}: {SEARCH_KEY}", result["search"])] if i == 0 else [])
                    for k, violations in runs:
                        if violations:
                            found[k] = counts(violations)
                            details[k] = violations
                    shown = page.evaluate("() => document.body.getAttribute('data-md-color-scheme')")
                    if shown != palette:
                        problems.append(f"{key}: the palette is {shown!r}, a {scheme} system wants {palette!r}")
                    state = page.evaluate(MOTION)
                    playing = motion == "no-preference"
                    problems += motion_problems(state, playing, key)
                    if state and state[0]["button"] is not None:
                        page.click(".md-typeset img.fc-motion + button")
                        problems += motion_problems(page.evaluate(MOTION)[:1], not playing, f"{key} after its button")
                context.close()
            browser.close()
    finally:
        server.shutdown()
    return found, problems, details


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("site", type=Path, help="the folder zensical build wrote")
    ap.add_argument("--chrome", default=os.environ.get("FUNDACAD_CHROME"), help="a Chrome to run, Playwright's own by default")
    ap.add_argument("--lower", action="store_true", help="lower the baseline to what is found, never raise it")
    args = ap.parse_args(argv)

    if not page_urls(args.site):
        print(f"no pages in {args.site}, run zensical build first")
        return 1
    allowed: dict[str, dict[str, int]] = json.loads(BASELINE.read_text(encoding="utf-8")) if BASELINE.exists() else {}
    found, problems, details = walk(args.site, args.chrome)

    if args.lower:
        allowed = {k: c for k in sorted(allowed) if (c := lowered(found.get(k, {}), allowed[k]))}
        BASELINE.write_text(json.dumps(allowed, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    lines = list(problems)
    for key in sorted(set(found) | set(allowed)):
        over = [f"{key}: {o}" for o in over_baseline(found.get(key, {}), allowed.get(key, {}))]
        under = [
            f"{key}: {rule}: {found.get(key, {}).get(rule, 0)} nodes, the baseline allows {n}, lower it with --lower"
            for rule, n in sorted(allowed.get(key, {}).items())
            if found.get(key, {}).get(rule, 0) < n
        ]
        problems += over + under
        lines += over + under
        for v in details.get(key, []) if over else []:
            lines += [f"    {v['id']} ({v['impact']}): {v['help']}, at {n['target']}" for n in v["nodes"][:3]]

    pages = len(page_urls(args.site))
    if problems:
        print(f"manual axe: {len(problems)} problem(s) over {pages} pages in {len(MODES)} modes\n")
        print("\n".join(lines))
        return 1
    print(f"manual axe: {pages} pages in {len(MODES)} modes, nothing over manual/tools/axe-baseline.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
