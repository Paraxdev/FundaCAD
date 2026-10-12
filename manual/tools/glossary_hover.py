"""Build includes/glossary.md, the site-wide abbreviation list, from docs/reference/glossary.md.

Run from the manual folder: python tools/glossary_hover.py
Every glossary term becomes an abbreviation, so it gets a dotted underline and
its definition on hover. Forms that never occur in the docs are left out.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = ROOT / "includes" / "glossary.md"

# Everyday words that would underline half of every sentence.
SKIP = {
    "cut", "join", "edge", "face", "folder", "version", "history", "items",
    "feature", "target", "origin", "snap", "section", "material", "pattern",
    "mirror", "shell", "workspace",
}

ENTRY = re.compile(r"^\*\*(.+?)\.\*\*\s+(.+)$")


def forms(term):
    base = [term]
    if not any(c.isupper() for c in term[1:]) and not any(c.isdigit() for c in term):
        base += [term.lower(), term[0].upper() + term[1:].lower()]
    out = []
    for f in dict.fromkeys(base):
        out.append(f)
        out.append(f[:-1] + "ies" if f.endswith("y") else f + "s")
    return out


def main():
    corpus = "\n".join(
        p.read_text(encoding="utf-8") for p in DOCS.rglob("*.md")
    )
    lines, skipped, wired = [], [], []
    for raw in (DOCS / "reference" / "glossary.md").read_text(encoding="utf-8").splitlines():
        m = ENTRY.match(raw)
        if not m:
            continue
        term, text = m.groups()
        if term.lower() in SKIP or term.startswith("."):
            skipped.append(term)
            continue
        text = re.sub(r"[*_`]", "", text).strip()
        used = [
            f for f in forms(term)
            if re.search(r"(?<!\w)" + re.escape(f) + r"(?!\w)", corpus)
        ]
        if not used:
            continue
        wired.append(term)
        lines += [f"*[{f}]: {text}" for f in used]
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"wired {len(wired)} terms ({len(lines)} forms), skipped {len(skipped)}: {', '.join(skipped)}")


if __name__ == "__main__":
    sys.exit(main())
