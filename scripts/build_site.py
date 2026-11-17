#!/usr/bin/env python3
"""Generate the browser-ready data file from data/words.json."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "words.json"
LISTENING_SOURCE = ROOT / "data" / "listening_meta.json"
TRANSLATIONS_SOURCE = ROOT / "data" / "translations.json"
TARGET = ROOT / "site" / "data.js"


def main() -> None:
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    if LISTENING_SOURCE.exists():
        data["listening"] = json.loads(LISTENING_SOURCE.read_text(encoding="utf-8"))
    if TRANSLATIONS_SOURCE.exists():
        data["translations"] = json.loads(
            TRANSLATIONS_SOURCE.read_text(encoding="utf-8")
        )
    # 音频放在仓库根目录的 audio/，站点页面在 site/ 下，所以要回退一层
    for item in data.get("listening", {}).get("sets", []):
        url = item.get("audio_url") or ""
        if url.startswith("audio/"):
            item["audio_url"] = f"../{url}"
    payload = "window.CET6_DATA=" + json.dumps(
        data, ensure_ascii=False, separators=(",", ":")
    ) + ";\n"
    TARGET.write_text(payload, encoding="utf-8")
    print(f"Wrote {TARGET} ({TARGET.stat().st_size / 1024 / 1024:.1f} MiB)")


if __name__ == "__main__":
    main()
