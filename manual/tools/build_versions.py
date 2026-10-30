"""Build the manual in several versions into one site, with the theme's version switch.

    python manual/tools/build_versions.py --version beta=<manual dir> --version dev=<manual dir> --default beta --out <dir>

Each version is a manual folder (a checkout of one branch) built into <out>/<name>/. The root gets
versions.json for the switch, a redirect stub at the old path of every default version page, a 404 page
that sends other old paths to the default version, robots.txt and a sitemap index. A version other than the
default that fails to build is left out with a warning, and its paths open the same page of the default.
"""
import argparse
import html
import json
import re
import shutil
import subprocess
import sys
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

PATCHED = "zensical.versioned.toml"
STATUS = re.compile(r"^(Build started|No issues found|Build finished)")
SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


class BuildFailed(Exception):
    pass


def version_url(site: str, name: str) -> str:
    return f"{site}{name}/"


def patch_config(text: str, name: str, site: str, default: str) -> str:
    url_line = re.compile(r"^site_url\s*=.*$", re.M)
    if len(url_line.findall(text)) != 1:
        raise ValueError("the config needs exactly one site_url line")
    site_dir = f"site/versioned-{name}"
    text = re.sub(r"^site_dir\s*=.*\n", "", text, flags=re.M)
    text = url_line.sub(f'site_url = "{version_url(site, name)}"\nsite_dir = "{site_dir}"', text)
    if not re.search(r"^\[project\.extra\.version\]", text, re.M):
        text = text.rstrip("\n") + f'\n\n[project.extra.version]\nprovider = "mike"\ndefault = "{default}"\n'
    project = tomllib.loads(text)["project"]
    if project["site_url"] != version_url(site, name) or project["site_dir"] != site_dir:
        raise ValueError("site_url or site_dir is not in the [project] table")
    if project.get("extra", {}).get("version", {}).get("provider") != "mike":
        raise ValueError("[project.extra.version] must use the mike provider")
    return text


def versions_json(names: list[str]) -> str:
    return json.dumps([{"version": n, "title": n.capitalize(), "aliases": []} for n in names], indent=2) + "\n"


def stub_html(path: str, site: str, default: str) -> str:
    target = "../" * path.count("/") + f"{default}/{path}"
    href = html.escape(target)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FundaCAD manual</title>
<link rel="canonical" href="{html.escape(version_url(site, default) + path)}">
<meta http-equiv="refresh" content="0; url={href}">
<script>location.replace({json.dumps(target)} + location.search + location.hash)</script>
</head>
<body><a href="{href}">Open this page in the manual</a></body>
</html>
"""


def robots_txt(site: str, names: list[str], default: str) -> str:
    base = urlparse(site).path
    hidden = "".join(f"Disallow: {base}{n}/\n" for n in names if n != default)
    return f"User-agent: *\nAllow: /\n{hidden}\nSitemap: {version_url(site, default)}sitemap.xml\n"


def sitemap_index(site: str, default: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"  <sitemap><loc>{html.escape(version_url(site, default))}sitemap.xml</loc></sitemap>\n"
        "</sitemapindex>\n"
    )


def redirect_404(page: str, site: str, names: list[str], default: str, gone: list[str] = ()) -> str:
    if "</head>" not in page:
        raise ValueError("the 404 page has no </head>")
    script = (
        "<script>(function () {\n"
        f"  var base = {json.dumps(urlparse(site).path)}, names = {json.dumps(names)}, gone = {json.dumps(list(gone))};\n"
        "  var p = location.pathname;\n"
        "  if (p.indexOf(base) !== 0) return;\n"
        '  var rest = p.slice(base.length), first = rest.split("/")[0];\n'
        "  if (gone.indexOf(first) !== -1) rest = rest.slice(first.length + 1);\n"
        "  else if (names.indexOf(first) !== -1) return;\n"
        f"  location.replace(base + {json.dumps(default + '/')} + rest + location.search + location.hash);\n"
        "})();</script>\n"
    )
    return page.replace("</head>", script + "</head>", 1)


def page_paths(tree: Path, url: str) -> list[str]:
    paths = []
    for loc in ET.parse(tree / "sitemap.xml").iter(f"{SITEMAP_NS}loc"):
        text = (loc.text or "").strip()
        if not text.startswith(url):
            raise ValueError(f"{text} is outside {url}")
        paths.append(text[len(url):])
    return paths


def write_root(out: Path, site: str, names: list[str], default: str, gone: list[str] = ()) -> None:
    for path in page_paths(out / default, version_url(site, default)):
        if path.split("/")[0] in [*names, *gone]:
            raise ValueError(f"the old path of {path} is a version folder")
        stub = out / path / "index.html"
        stub.parent.mkdir(parents=True, exist_ok=True)
        stub.write_text(stub_html(path, site, default), encoding="utf-8")
    (out / "versions.json").write_text(versions_json(names), encoding="utf-8")
    page = (out / default / "404.html").read_text(encoding="utf-8")
    (out / "404.html").write_text(redirect_404(page, site, names, default, gone), encoding="utf-8")
    (out / "robots.txt").write_text(robots_txt(site, names, default), encoding="utf-8")
    (out / "sitemap.xml").write_text(sitemap_index(site, default), encoding="utf-8")


def build(name: str, manual: Path, site: str, default: str, zensical: str, out: Path) -> list[str]:
    patched = manual / PATCHED
    config = (manual / "zensical.toml").read_text(encoding="utf-8")
    patched.write_text(patch_config(config, name, site, default), encoding="utf-8")
    try:
        run = subprocess.run(
            [zensical, "build", "--clean", "-f", PATCHED],
            cwd=manual, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
    finally:
        patched.unlink()
    lines = (run.stdout + run.stderr).splitlines()
    for line in lines:
        print(f"[{name}] {line}")
    if run.returncode != 0:
        raise BuildFailed(f"zensical failed with exit code {run.returncode}")
    shutil.move(str(manual / "site" / f"versioned-{name}"), str(out / name))
    return [line for line in lines if line.strip() and not STATUS.match(line)]


def build_all(names: list[str], default: str, build_one) -> tuple[dict[str, list[str]], list[str]]:
    built, failed = {}, []
    for name in names:
        try:
            built[name] = build_one(name)
        except Exception as error:
            if not isinstance(error, (BuildFailed, OSError, ValueError)):
                error = f"{type(error).__name__}: {error}"
            if name == default:
                raise SystemExit(f"[{name}] {error}")
            # A GitHub Actions annotation, so a broken dev manual shows on the run while beta still publishes.
            print(f"::warning::The {name} manual did not build ({error}), it is left out and its pages open the {default} manual")
            failed.append(name)
    return built, failed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--version", action="append", required=True, metavar="NAME=DIR", help="a version and its manual folder")
    parser.add_argument("--default", required=True, help="the version visitors get")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--zensical", default="zensical", help="the zensical command")
    parser.add_argument("--site", help="the site root URL, by default the site_url of the default version")
    args = parser.parse_args()

    versions = {}
    for item in args.version:
        name, sep, folder = item.partition("=")
        if not sep or not re.fullmatch(r"[a-z0-9-]+", name):
            parser.error(f"--version {item}: use NAME=DIR with a lower case name")
        versions[name] = Path(folder).resolve()
    if args.default not in versions:
        parser.error(f"--default {args.default} is not one of the versions")
    names = list(versions)
    default_config = (versions[args.default] / "zensical.toml").read_text(encoding="utf-8")
    site = args.site or tomllib.loads(default_config)["project"]["site_url"]
    if not site.endswith("/"):
        site += "/"

    out = args.out.resolve()
    if out.exists() and any(out.iterdir()):
        if not (out / "versions.json").is_file():
            raise SystemExit(f"{out} is not empty and holds no earlier build, pick another folder")
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    warnings, failed = build_all(names, args.default, lambda name: build(name, versions[name], site, args.default, args.zensical, out))
    write_root(out, site, list(warnings), args.default, failed)
    for name, lines in warnings.items():
        print(f"{name}: {len(lines)} warning lines")


if __name__ == "__main__":
    sys.exit(main())
