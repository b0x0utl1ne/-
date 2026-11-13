#!/usr/bin/env python3
"""Bundle the local site into one self-contained, double-clickable HTML file."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUTPUT = ROOT / "CET6-词书.html"


def inline_script(payload: str, label: str) -> str:
    # Keep an accidental closing tag inside article text from ending the script.
    payload = re.sub(r"</script", r"<\\/script", payload, flags=re.IGNORECASE)
    return f"\n<!-- {label} -->\n<script>\n{payload}\n</script>"


def main() -> None:
    html = (SITE / "index.html").read_text(encoding="utf-8")
    css = (SITE / "assets" / "styles.css").read_text(encoding="utf-8")
    data_js = (SITE / "data.js").read_text(encoding="utf-8")
    app_js = (SITE / "assets" / "app.js").read_text(encoding="utf-8")

    if "</style" in css.lower():
        raise SystemExit("refusing to inline CSS containing </style")

    html = html.replace(
        '<link rel="stylesheet" href="./assets/styles.css">',
        f"<style>\n{css}\n</style>",
        1,
    )
    html = html.replace(
        '<script src="./data.js"></script>',
        inline_script(data_js, "embedded wordbook data"),
        1,
    )
    html = html.replace(
        '<script src="./assets/app.js"></script>',
        inline_script(app_js, "embedded study app"),
        1,
    )
    if "<style>" not in html or "window.CET6_DATA" not in html:
        raise SystemExit("inlining failed; expected CSS/data markers are missing")
    OUTPUT.write_text(html, encoding="utf-8")
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024 / 1024:.1f} MiB)")


if __name__ == "__main__":
    main()
