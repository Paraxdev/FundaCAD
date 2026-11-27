"""Build the fundacad.dev home pages: the landing page, Download, and News with its Atom feed.

    python manual/tools/build_home.py --out <dir>

News posts are YYYY-MM-DD-slug.md files in the news folder of manual/home, with title, date and summary in front
matter. The pages share the manual's colours and header (manual/docs/stylesheets/site.css) and link it at beta/.
"""
from __future__ import annotations

import argparse
import html
import math
import re
import shutil
import sys
import tomllib
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import markdown

MANUAL = Path(__file__).resolve().parents[1]
HOME = MANUAL / "home"
REPO_URL = "https://github.com/Paraxdev/fundacad"
DOCS = "beta/"
POST_NAME = re.compile(r"^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$")
PAGES = ("", "download/", "news/")


@dataclass
class Post:
    slug: str
    title: str
    date: date
    summary: str
    body: str


def parse_post(path: Path) -> Post:
    match = POST_NAME.match(path.name)
    if not match:
        raise ValueError(f"{path.name}: name a post YYYY-MM-DD-slug.md")
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    head, sep, body = text.removeprefix("---\n").partition("\n---\n")
    if not text.startswith("---\n") or not sep:
        raise ValueError(f"{path.name}: the post needs front matter between --- lines")
    meta = {}
    for line in head.splitlines():
        key, colon, value = line.partition(":")
        if colon:
            meta[key.strip()] = value.strip().strip('"')
    missing = [k for k in ("title", "date", "summary") if not meta.get(k)]
    if missing:
        raise ValueError(f"{path.name}: the front matter lacks {', '.join(missing)}")
    when = date.fromisoformat(meta["date"])
    if when.isoformat() != match.group(1):
        raise ValueError(f"{path.name}: the date in the name and the front matter differ")
    rendered = markdown.markdown(body, extensions=["attr_list", "tables", "fenced_code"])
    return Post(match.group(2), meta["title"], when, meta["summary"], rendered)


def load_posts(folder: Path) -> list[Post]:
    posts = [parse_post(p) for p in folder.glob("*.md")]
    slugs = [p.slug for p in posts]
    if len(set(slugs)) != len(slugs):
        raise ValueError("two posts share a slug")
    return sorted(posts, key=lambda p: (p.date, p.slug), reverse=True)


def nice_date(d: date) -> str:
    return f"{d.day} {d:%B %Y}"


ICONS = {
    "moon": '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    "sun-moon": '<path d="M12 2v2M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715M16 12a4 4 0 0 0-4-4M19 5l-1.256 1.256M20 12h2"/>',
    "github": '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
}


def icon(name: str) -> str:
    return (f'<svg class="fc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
            f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{ICONS[name]}</svg>')


MARK = ('<svg class="fc-mark" viewBox="8 6 48 54" aria-hidden="true" focusable="false">'
        '<path d="M32 32 L53 20 L53 45 L32 57 Z" fill="#1f4f70"/><path d="M32 32 L11 20 L11 45 L32 57 Z" fill="#2d76a4"/>'
        '<path d="M32 8 L53 20 L32 32 L11 20 Z" fill="#4ca5e0"/></svg>')

# The same three entries, storage key and first visit default as the manual (zensical.toml, overrides/main.html),
# so a light or dark choice holds across the whole site.
PALETTE = (
    ("(prefers-color-scheme: dark)", "slate", "moon", "Switch to light mode"),
    ("(prefers-color-scheme: light)", "default", "sun", "Follow the system setting"),
    ("(prefers-color-scheme)", "default", "sun-moon", "Switch to dark mode"),
)
PALETTE_BOOT = """<script>(function () {
  var k = "/.__palette", p = null;
  try { p = JSON.parse(localStorage.getItem(k)); } catch (e) {}
  if (!p || !p.color) {
    p = {index: 0, color: {media: "(prefers-color-scheme: dark)", scheme: "slate", primary: "indigo", accent: "indigo"}};
    try { localStorage.setItem(k, JSON.stringify(p)); } catch (e) {}
  }
  var s = p.color.scheme;
  if (p.color.media === "(prefers-color-scheme)") s = matchMedia("(prefers-color-scheme: light)").matches ? "default" : "slate";
  document.body.setAttribute("data-md-color-scheme", s === "default" ? "default" : "slate");
  document.body.setAttribute("data-fc-palette", String(p.index || 0));
})();</script>"""


def palette_form() -> str:
    parts = ['<form class="fc-palette" data-md-component="palette">']
    for i, (media, scheme, name, label) in enumerate(PALETTE):
        parts.append(f'<input class="fc-option" type="radio" name="__palette" id="__palette_{i}" aria-label="{label}" '
                     f'data-md-color-media="{media}" data-md-color-scheme="{scheme}">')
        parts.append(f'<label class="fc-icon-btn" title="{label}" for="__palette_{(i + 1) % len(PALETTE)}" hidden>'
                     f'{icon(name)}</label>')
    parts.append("</form>")
    return "".join(parts)


def layout(*, root: str, title: str, description: str, current: str, body: str, path: str, site: str) -> str:
    links = [("Download", "download/"), ("News", "news/"), ("Docs", DOCS)]
    nav = "".join(
        f'<a href="{root}{href}"{" aria-current=\"page\"" if name == current else ""}>{name}</a>' for name, href in links
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(description)}">
<link rel="canonical" href="{site}{path}">
<meta name="color-scheme" content="dark light">
<meta property="og:type" content="website">
<meta property="og:site_name" content="FundaCAD">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(description)}">
<meta property="og:url" content="{site}{path}">
<meta property="og:image" content="{site}static/hero.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{root}static/mark.png">
<link rel="alternate" type="application/atom+xml" title="FundaCAD news" href="{root}news/feed.xml">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&amp;family=JetBrains+Mono:wght@500&amp;family=Space+Grotesk:wght@500;700&amp;display=swap">
<link rel="stylesheet" href="{root}static/site.css">
<link rel="stylesheet" href="{root}static/home.css">
<script src="{root}static/home.js" defer></script>
</head>
<body data-md-color-scheme="slate">
{PALETTE_BOOT}
<a class="fc-skip" href="#main">Skip to content</a>
<header class="fc-header">
<div class="fc-header-inner">
<a class="fc-brand" href="{root}" aria-label="FundaCAD home">{MARK}<span>FundaCAD</span></a>
<nav class="fc-site-nav" aria-label="FundaCAD site">{nav}</nav>
{palette_form()}
<a class="fc-icon-btn fc-github" href="{REPO_URL}" aria-label="FundaCAD on GitHub" title="FundaCAD on GitHub">{icon("github")}</a>
</div>
</header>
<main id="main" class="fc-main">
{body}
</main>
<footer class="fc-footer">
<div class="fc-footer-brand">
<p class="fc-footer-name">{MARK}<span>FundaCAD</span></p>
<p>FundaCAD is free software under the <a href="{REPO_URL}/blob/main/LICENSE">AGPL 3.0</a>.</p>
<p class="fc-footer-links"><a href="{REPO_URL}">GitHub</a> <a href="{root}news/feed.xml">News feed</a> <a href="{root}{DOCS}">Docs</a></p>
</div>
{title_block()}
</footer>
</body>
</html>
"""


TITLE_BLOCK = (
    ("Part", "FundaCAD", "wide"),
    ("Licence", f'<a href="{REPO_URL}/blob/main/LICENSE">AGPL 3.0</a>', ""),
    ("Price", "Free", ""),
    ("Platforms", "Windows, macOS, Linux", "wide"),
    ("Account", "None", ""),
    ("Ads", "None", ""),
    ("Source", f'<a href="{REPO_URL}">github.com/Paraxdev/fundacad</a>', "wide"),
    ("Scale", '<span class="fc-num">1:1</span>', ""),
    ("Sheet", '<span class="fc-num">1</span> of <span class="fc-num">1</span>', ""),
)


def title_block() -> str:
    cells = "".join(f'<div class="{cls}"><dt>{key}</dt><dd>{value}</dd></div>' for key, value, cls in TITLE_BLOCK)
    return f'<dl class="fc-titleblock fc-glass" aria-label="FundaCAD at a glance">{cells}</dl>'


def dim(label: str = "", vertical: bool = False) -> str:
    """A dimension line with arrowheads and extension lines, drawn in CSS."""
    text = f'<span class="fc-num">{label}</span>' if label else ""
    return f'<span class="fc-dim{" fc-dim-v" if vertical else ""}" aria-hidden="true"><i></i>{text}<i></i></span>'


def heading(tag: str, name: str, ident: str) -> str:
    return f'<div class="fc-head"><{tag} id="{ident}">{name}</{tag}>{dim()}</div>'


def bracket() -> str:
    """An isometric L bracket with two holes and their centre marks, as SVG strokes."""
    c, s = math.cos(math.radians(30)), math.sin(math.radians(30))

    def pt(x: float, y: float, z: float) -> str:
        return f"{(x - y) * c:.1f} {(x + y) * s - z:.1f}"

    def box(x0, x1, y0, y1, z0, z1) -> str:
        v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        edges = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)]
        return "".join(f"M{pt(*v[a])}L{pt(*v[b])}" for a, b in edges)

    def ring(f) -> str:
        return "M" + "L".join(pt(*f(2 * math.pi * i / 48)) for i in range(48)) + "Z"

    def line(a, b) -> str:
        return f"M{pt(*a)}L{pt(*b)}"

    paths = [
        ("fc-part", box(0, 120, 0, 70, 0, 10)),
        ("fc-part", box(0, 10, 0, 70, 10, 90)),
        ("fc-part", ring(lambda t: (80 + 12 * math.cos(t), 35 + 12 * math.sin(t), 10))),
        ("fc-part", ring(lambda t: (10, 35 + 12 * math.cos(t), 58 + 12 * math.sin(t)))),
        ("fc-centre", line((62, 35, 10), (98, 35, 10)) + line((80, 17, 10), (80, 53, 10))
         + line((10, 17, 58), (10, 53, 58)) + line((10, 35, 40), (10, 35, 76))),
    ]
    body = "".join(f'<path class="{cls}" d="{d}" pathLength="1" style="--i:{i}"/>' for i, (cls, d) in enumerate(paths))
    return f'<svg class="fc-bracket" viewBox="-66 -96 176 197" aria-hidden="true" focusable="false">{body}</svg>'


def post_list(posts: list[Post], root: str, heading_tag: str = "h2") -> str:
    items = "".join(
        f'<li class="fc-card fc-glass fc-marks fc-rise" style="--i:{i}"><time datetime="{p.date.isoformat()}">{nice_date(p.date)}</time>'
        f'<{heading_tag}><a href="{root}news/{p.slug}/">{html.escape(p.title)}</a></{heading_tag}>'
        f"<p>{html.escape(p.summary)}</p></li>"
        for i, p in enumerate(posts)
    )
    return f'<ul class="fc-posts" role="list">{items}</ul>'


STEPS = (
    ("Sketch", "Draw a flat shape, then pin it down with constraints and exact sizes.", "sketch/start/",
     "sketch-constraints.png", 860, 730, "A 40 by 20 mm rectangle in a sketch, fully defined"),
    ("Model", "Extrude, fillet, shell and pattern. Change a number later and the part rebuilds.", "model/extrude/",
     "fillet-edge.png", 860, 640, "A box with one edge being rounded by a 6 mm fillet"),
    ("Print", "See overhangs and bed fit before you slice, then export STL or 3MF.", "inspect/overhang/",
     "overhang-red.png", 850, 440, "A T shaped part with its overhangs painted red by the overhang analysis"),
)
SHOTS = [s[3] for s in STEPS]


def landing(posts: list[Post]) -> str:
    steps = "".join(
        f'<li class="fc-step fc-card fc-glass fc-marks fc-rise" style="--i:{i}">'
        f'<div class="fc-step-img"><img src="static/{img}" width="{w}" height="{h}" alt="{alt}" loading="lazy" decoding="async"></div>'
        f'<div class="fc-step-text"><h3><span class="fc-balloon fc-num" aria-hidden="true">{i + 1}</span>'
        f'<a href="{DOCS}{href}">{name}</a></h3><p>{text}</p></div></li>'
        for i, (name, text, href, img, w, h, alt) in enumerate(STEPS)
    )
    news = ""
    if posts:
        news = (f'<section class="fc-section" aria-labelledby="news-h"><div class="fc-section-head">'
                f'{heading("h2", "News", "news-h")}<a href="news/">All news</a></div>'
                f'{post_list(posts[:3], "", "h3")}</section>')
    return f"""<section class="fc-hero">
{bracket()}
<div class="fc-hero-text">
<p class="fc-eyebrow fc-rise" style="--i:0">Free and open source</p>
<h1 class="fc-hero-title fc-rise" style="--i:1">CAD for the parts you <em>3D print.</em></h1>
<p class="fc-lead fc-rise" style="--i:2">Sketch a shape, give it exact sizes, turn it into a solid and export it for your slicer. Every step stays editable.</p>
<p class="fc-actions fc-rise" style="--i:3"><a class="fc-btn fc-btn-primary" href="download/">Download</a><a class="fc-btn fc-btn-ghost" href="{DOCS}">Read the docs</a></p>
</div>
<div class="fc-shot-wrap fc-rise" style="--i:2">
{dim("240.00 mm")}
<figure class="fc-shot fc-glass">
<div class="fc-shot-bar" aria-hidden="true"><span>Planetary gearbox</span><span>FundaCAD 1 beta</span></div>
<img src="static/hero.jpg" width="1200" height="630" alt="The FundaCAD window with an exploded planetary gearbox">
</figure>
{dim("134.00 mm", vertical=True)}
</div>
<ul class="fc-status fc-rise" style="--i:4" role="list" aria-label="Release status" data-fc-repo="Paraxdev/fundacad">
<li><span class="fc-dot" aria-hidden="true"></span>Latest <span class="fc-status-value" data-fc-latest>FundaCAD 1 beta</span></li>
<li>Runs on <span class="fc-status-value">Windows, macOS, Linux</span></li>
<li>Licence <span class="fc-status-value">AGPL 3.0</span></li>
<li>Price <span class="fc-status-value">Free</span></li>
</ul>
</section>
<section class="fc-section" aria-labelledby="how-h">
<div class="fc-section-head">{heading("h2", "How it works", "how-h")}<p class="fc-section-lede">Three steps from an idea to a file your slicer opens.</p></div>
<ol class="fc-steps" role="list">{steps}</ol>
</section>
{news}"""


def download_page() -> str:
    releases = f"{REPO_URL}/releases"
    return f"""<section class="fc-page fc-download" data-fc-repo="Paraxdev/fundacad">
<div class="fc-head fc-rise" style="--i:0"><h1>Download FundaCAD</h1>{dim()}</div>
<p class="fc-lead fc-rise" style="--i:1">The FundaCAD 1 beta, free for Windows, macOS and Linux. No account needed.</p>
<div class="fc-release fc-card fc-glass fc-marks fc-rise" style="--i:2" aria-live="polite">
<p class="fc-release-status">The files are on the <a href="{releases}">GitHub releases page</a>.</p>
</div>
<p class="fc-more fc-rise" style="--i:3"><a href="{DOCS}start/install/">How to install</a><a href="{releases}">All releases</a></p>
</section>"""


def news_page(posts: list[Post]) -> str:
    listing = post_list(posts, "../") if posts else "<p>No news yet.</p>"
    return f"""<section class="fc-page">
<div class="fc-section-head fc-rise" style="--i:0"><div class="fc-head"><h1>News</h1>{dim()}</div><a href="feed.xml">Atom feed</a></div>
{listing}
</section>"""


def post_page(post: Post) -> str:
    return f"""<article class="fc-page fc-post">
<p class="fc-back fc-rise" style="--i:0"><a href="../">All news</a></p>
<time class="fc-rise" style="--i:0" datetime="{post.date.isoformat()}">{nice_date(post.date)}</time>
<h1 class="fc-rise" style="--i:1">{html.escape(post.title)}</h1>
<div class="fc-prose fc-rise" style="--i:2">{post.body}</div>
</article>"""


def atom(posts: list[Post], site: str) -> str:
    updated = (posts[0].date if posts else date(2026, 1, 1)).isoformat()
    entries = "".join(
        f"""  <entry>
    <title>{html.escape(p.title)}</title>
    <link href="{site}news/{p.slug}/"/>
    <id>{site}news/{p.slug}/</id>
    <updated>{p.date.isoformat()}T00:00:00Z</updated>
    <summary>{html.escape(p.summary)}</summary>
    <content type="html" xml:base="{site}news/{p.slug}/">{html.escape(p.body)}</content>
  </entry>
"""
        for p in posts
    )
    return f"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>FundaCAD news</title>
  <link href="{site}news/"/>
  <link rel="self" href="{site}news/feed.xml"/>
  <id>{site}news/</id>
  <updated>{updated}T00:00:00Z</updated>
  <author><name>FundaCAD</name></author>
{entries}</feed>
"""


def sitemap(paths: list[str], site: str) -> str:
    urls = "".join(f"  <url><loc>{html.escape(site + p)}</loc></url>\n" for p in paths)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n'


def build(out: Path, site: str) -> list[str]:
    """Write the home pages into out and return their paths, relative to the site root."""
    posts = load_posts(HOME / "news")
    meta = "FundaCAD is free, open source parametric CAD for 3D printing on Windows, macOS and Linux."
    pages = {
        "": ("FundaCAD: free, open source CAD for 3D printing", meta, "", landing(posts)),
        "download/": ("Download FundaCAD", "Download the FundaCAD 1 beta for Windows, macOS and Linux.", "Download", download_page()),
        "news/": ("FundaCAD news", "News about FundaCAD.", "News", news_page(posts)),
    }
    for p in posts:
        pages[f"news/{p.slug}/"] = (f"{p.title} | FundaCAD", p.summary, "News", post_page(p))
    for path, (title, description, current, body) in pages.items():
        target = out / path / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        root = "../" * path.count("/")
        target.write_text(layout(root=root, title=title, description=description, current=current, body=body,
                                 path=path, site=site), encoding="utf-8")
    (out / "news" / "feed.xml").write_text(atom(posts, site), encoding="utf-8")
    (out / "sitemap-home.xml").write_text(sitemap(list(pages), site), encoding="utf-8")
    static = out / "static"
    static.mkdir(exist_ok=True)
    shutil.copyfile(MANUAL / "docs" / "stylesheets" / "site.css", static / "site.css")
    shutil.copyfile(HOME / "home.css", static / "home.css")
    shutil.copyfile(HOME / "home.js", static / "home.js")
    shutil.copyfile(HOME / "mark.png", static / "mark.png")
    shutil.copyfile(MANUAL / "docs" / "img" / "social-card.jpg", static / "hero.jpg")
    for name in SHOTS:
        shutil.copyfile(MANUAL / "docs" / "img" / name, static / name)
    return list(pages)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--site", help="the site root URL, by default the manual's site_url")
    args = parser.parse_args()
    site = args.site or tomllib.loads((MANUAL / "zensical.toml").read_text(encoding="utf-8"))["project"]["site_url"]
    if not site.endswith("/"):
        site += "/"
    paths = build(args.out.resolve(), site)
    print(f"home: {len(paths)} pages in {args.out}")


if __name__ == "__main__":
    sys.exit(main())
