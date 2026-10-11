#!/usr/bin/env python3
"""Bump the app version and the ?v= cache-busting query on every local asset.

Usage (run from the repository root):  python3 tools/bump-version.py 1.0.2
Browsers treat app.js?v=1.0.2 as a new file, so a release shows up without a hard refresh.
"""
import re
import sys
from pathlib import Path

if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
    sys.exit("usage: python3 tools/bump-version.py X.Y.Z")
v = sys.argv[1]
root = Path(__file__).resolve().parent.parent
ASSET = r"((?:\.\./)?(?:\./)?(?:app|admin|words|i18n)\.js|(?:\.\./)?style\.css)(?:\?v=[\d.]+)?"
files = ["index.html", "admin.html", "app.js", "admin.js", *[str(p.relative_to(root)) for p in (root / "guide").glob("*.html")]]
for name in files:
    p = root / name
    s = p.read_text(encoding="utf8")
    s2 = re.sub(r"""(["'])""" + ASSET + r"""\1""", lambda m: f"{m.group(1)}{m.group(2)}?v={v}{m.group(1)}", s)
    if name == "app.js":
        s2 = re.sub(r"const APP_VERSION = '[\d.]+';", f"const APP_VERSION = '{v}';", s2)
    if s2 != s:
        p.write_text(s2, encoding="utf8")
        print("updated", name)
print("version", v)
