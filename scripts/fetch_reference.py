#!/usr/bin/env python3
"""Fetch the CET-6 high-frequency reference list used only for CEFR ranking."""

from __future__ import annotations

import json
from pathlib import Path

import requests
from lxml import html


URL = "https://english-exam.lazynote.cn/cet6/words/stats/frequency/"


def clean(node: html.HtmlElement) -> str:
    return " ".join(" ".join(node.itertext()).split())


def main() -> None:
    response = requests.get(
        URL,
        timeout=60,
        headers={"User-Agent": "Mozilla/5.0 CET-6 wordbook builder"},
    )
    response.raise_for_status()
    doc = html.fromstring(response.text)
    entries = []
    for row in doc.xpath("//li[contains(@class,'freqrow')]"):
        word_node = row.xpath(".//*[contains(@class,'freqrow__word')]")
        def_node = row.xpath(".//*[contains(@class,'freqrow__def')]")
        cefr_node = row.xpath(".//*[contains(@class,'cefr')]")
        count_node = row.xpath(".//*[contains(@class,'freqrow__c')]")
        rank_node = row.xpath(".//*[contains(@class,'freqrow__rank')]")
        if not word_node:
            continue
        entries.append(
            {
                "rank": int(clean(rank_node[0])) if rank_node else len(entries) + 1,
                "word": clean(word_node[0]).lower(),
                "cefr": clean(cefr_node[0]) if cefr_node else "",
                "definition": clean(def_node[0]) if def_node else "",
                "sentence_count": int(clean(count_node[0])) if count_node else 0,
            }
        )
    output_dir = Path("data/reference")
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "懒笔记：英语六级高频词汇表（仅用于排序/CEFR 参考）",
        "source_url": URL,
        "count": len(entries),
        "entries": entries,
    }
    (output_dir / "cet6_frequency.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"OK: {len(entries)} reference words")


if __name__ == "__main__":
    main()
