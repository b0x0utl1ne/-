#!/usr/bin/env python3
"""Fetch Chinese translations for every example sentence and cache them locally.

The public translation endpoint is only used at build time. The generated
data/translations.json is bundled into the page, so the page itself never
calls an external service.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORDS = ROOT / "data" / "words.json"
OUT = ROOT / "data" / "translations.json"
ENDPOINT = "https://clients5.google.com/translate_a/t"
BATCH = 10
DELAY = 0.4


def load_cache() -> dict[str, str]:
    if OUT.exists():
        return json.loads(OUT.read_text(encoding="utf-8"))
    return {}


def fetch(batch: list[str]) -> list[str]:
    query = urllib.parse.urlencode(
        [("client", "dict-chrome-ex"), ("sl", "en"), ("tl", "zh-CN")]
    )
    for text in batch:
        query += "&q=" + urllib.parse.quote(text, safe="")
    request = urllib.request.Request(
        f"{ENDPOINT}?{query}", headers={"User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if isinstance(payload, str):
        payload = [payload]
    return payload


def main() -> None:
    words = json.loads(WORDS.read_text(encoding="utf-8"))["words"]
    texts: list[str] = []
    seen: set[str] = set()
    for word in words:
        context = word.get("context") or {}
        text = " ".join((context.get("text") or "").split())
        if text and text not in seen:
            seen.add(text)
            texts.append(text)

    cache = load_cache()
    missing = [text for text in texts if text not in cache]
    print(f"total={len(texts)} cached={len(cache)} missing={len(missing)}")

    failed = 0
    for index in range(0, len(missing), BATCH):
        batch = missing[index:index + BATCH]
        try:
            result = fetch(batch)
            if len(result) != len(batch):
                raise ValueError(f"length mismatch {len(result)} != {len(batch)}")
            for source, target in zip(batch, result):
                if isinstance(target, str) and target.strip():
                    cache[source] = target.strip()
        except Exception as exc:  # noqa: BLE001 - keep going, report at the end
            failed += len(batch)
            print(f"  batch {index // BATCH} failed: {exc}")
            time.sleep(3)
            continue
        if (index // BATCH) % 5 == 0:
            OUT.write_text(
                json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8"
            )
            print(f"  {min(index + BATCH, len(missing))}/{len(missing)}")
        time.sleep(DELAY)

    OUT.write_text(json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"saved {len(cache)} translations to {OUT} (failed {failed})")


if __name__ == "__main__":
    main()
