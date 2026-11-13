#!/usr/bin/env python3
"""Fetch the first set of the latest 12 CET-6 exams and extract article text.

The source pages are kept in data/raw/articles for resumable fetching and
debugging, but only the normalized JSON is intended for version control.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests
from lxml import html


BASE_URL = "https://english-exam.lazynote.cn"
SET_IDS = [
    "2026-06-1",
    "2025-12-1",
    "2025-06-1",
    "2024-12-1",
    "2024-06-1",
    "2023-12-1",
    "2023-06-1",
    "2023-03-1",
    "2022-12-1",
    "2022-09-1",
    "2022-06-1",
    "2021-12-1",
]
SET_LABELS = {
    "2026-06-1": "2026年6月 第1套",
    "2025-12-1": "2025年12月 第1套",
    "2025-06-1": "2025年6月 第1套",
    "2024-12-1": "2024年12月 第1套",
    "2024-06-1": "2024年6月 第1套",
    "2023-12-1": "2023年12月 第1套",
    "2023-06-1": "2023年6月 第1套",
    "2023-03-1": "2023年3月 第1套（加考）",
    "2022-12-1": "2022年12月 第1套",
    "2022-09-1": "2022年9月 第1套（加考）",
    "2022-06-1": "2022年6月 第1套",
    "2021-12-1": "2021年12月 第1套",
}
SECTION_LABELS = {
    "part2-section-a": "听力·长对话1",
    "part2-section-a-1": "听力·长对话1",
    "part2-section-a-2": "听力·长对话2",
    "part2-section-b": "听力·短文1",
    "part2-section-b-1": "听力·短文1",
    "part2-section-b-2": "听力·短文2",
    "part2-section-c": "听力·讲座1",
    "part2-section-c-1": "听力·讲座1",
    "part2-section-c-2": "听力·讲座2",
    "part2-section-c-3": "听力·讲座3",
    "part3-section-a": "选词填空",
    "part3-section-b": "长篇阅读",
    "part3-section-c": "仔细阅读1",
    "part3-section-c-1": "仔细阅读1",
    "part3-section-c-2": "仔细阅读2",
}
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def fetch(session: requests.Session, url: str, cache_path: Path) -> str:
    if cache_path.exists() and cache_path.stat().st_size > 1000:
        return cache_path.read_text(encoding="utf-8")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 4):
        try:
            response = session.get(url, timeout=45)
            response.raise_for_status()
            response.encoding = response.apparent_encoding or "utf-8"
            cache_path.write_text(response.text, encoding="utf-8")
            time.sleep(0.15)
            return response.text
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(1.5 * attempt)
    raise RuntimeError("unreachable")


def parse_meta(text: str) -> dict[str, str]:
    doc = html.fromstring(text)
    description = " ".join(doc.xpath("//meta[@name='description']/@content"))
    cefr_match = re.search(r"CEFR\s+([A-C][12])", description)
    genre_match = re.search(r"体裁([^·]{1,8})\s*·", description)
    part_match = re.search(r"(Part\s+[IVX]+)\s+(Section\s+[A-C])", description)
    title_match = re.search(r"文章\s+(.+?)\s+精读", description)
    return {
        "description": description,
        "cefr": cefr_match.group(1) if cefr_match else "",
        "genre": normalize_space(genre_match.group(1)) if genre_match else "",
        "part": f"{part_match.group(1)} {part_match.group(2)}" if part_match else "",
        "meta_title": normalize_space(title_match.group(1)) if title_match else "",
    }


def extract_article(text: str, set_id: str, slug: str, url: str) -> dict[str, Any]:
    doc = html.fromstring(text)
    title_nodes = doc.xpath("//h1[contains(@class,'art-hero__title')]")
    title = normalize_space(" ".join(title_nodes[0].itertext())) if title_nodes else ""
    paragraphs = []
    for paragraph in doc.xpath(
        "//div[contains(@class,'art-passage__para')]//p"
    ):
        value = normalize_space(" ".join(paragraph.itertext()))
        if value:
            paragraphs.append(value)
    source_nodes = doc.xpath("//*[contains(@class,'art-hero__source')]")
    source = normalize_space(" ".join(source_nodes[0].itertext())) if source_nodes else ""
    key_words = []
    for node in doc.xpath("//*[contains(@class,'wi__word')]"):
        value = normalize_space(" ".join(node.itertext())).strip("*").strip()
        if not value:
            continue
        value = re.sub(r"^[*\s]+|[*\s]+$", "", value).lower()
        if value and value not in key_words:
            key_words.append(value)
    meta = parse_meta(text)
    word_count = sum(len(re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", p)) for p in paragraphs)
    return {
        "id": f"{set_id}/{slug}",
        "set_id": set_id,
        "slug": slug,
        "title": title or meta["meta_title"],
        "section": SECTION_LABELS.get(slug, slug.replace("-", " ")),
        "part": meta["part"],
        "genre": meta["genre"],
        "cefr": meta["cefr"],
        "source_note": source,
        "key_words": key_words,
        "url": url,
        "paragraphs": paragraphs,
        "paragraph_count": len(paragraphs),
        "word_count": word_count,
    }


def fetch_set(session: requests.Session, set_id: str) -> dict[str, Any]:
    index_url = f"{BASE_URL}/cet6/articles/{set_id}/"
    index_path = Path("data/raw/index") / f"{set_id}.html"
    index_html = fetch(session, index_url, index_path)
    index_doc = html.fromstring(index_html)
    links: list[str] = []
    for href in index_doc.xpath("//a[contains(@href,'/cet6/articles/')]/@href"):
        absolute = urljoin(BASE_URL, href)
        if f"/cet6/articles/{set_id}/" not in absolute:
            continue
        if absolute.rstrip("/") == index_url.rstrip("/"):
            continue
        if absolute not in links:
            links.append(absolute)

    articles = []
    for url in links:
        slug = url.rstrip("/").rsplit("/", 1)[-1]
        cache_path = Path("data/raw/articles") / set_id / f"{slug}.html"
        page_html = fetch(session, url, cache_path)
        article = extract_article(page_html, set_id, slug, url)
        if not article["paragraphs"]:
            raise RuntimeError(f"No paragraphs extracted: {url}")
        articles.append(article)
        print(
            f"{set_id} {slug:20s} {article['paragraph_count']:2d} paras "
            f"{article['word_count']:4d} words"
        )
    if len(articles) < 4:
        raise RuntimeError(f"Too few articles for {set_id}: {len(articles)}")
    return {
        "id": set_id,
        "label": SET_LABELS[set_id],
        "source_url": index_url,
        "article_count": len(articles),
        "word_count": sum(a["word_count"] for a in articles),
        "articles": articles,
    }


def main() -> None:
    output_dir = Path("data/corpus")
    output_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update(HEADERS)
    sets = []
    for set_id in SET_IDS:
        payload = fetch_set(session, set_id)
        sets.append(payload)
        output_path = output_dir / f"{set_id}.json"
        output_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(
            f"OK {set_id}: {payload['article_count']} articles, "
            f"{payload['word_count']} words"
        )

    manifest = {
        "source": "懒笔记 CET-6 真题文章",
        "source_url": f"{BASE_URL}/cet6/articles/",
        "selection": "最近12次考试的第1套；包含2022年9月、2023年3月加考",
        "sets": [
            {
                "id": item["id"],
                "label": item["label"],
                "article_count": item["article_count"],
                "word_count": item["word_count"],
                "source_url": item["source_url"],
            }
            for item in sets
        ],
        "article_count": sum(item["article_count"] for item in sets),
        "word_count": sum(item["word_count"] for item in sets),
        "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    manifest["sha256"] = hashlib.sha256(
        json.dumps(sets, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"DONE: {manifest['article_count']} articles, "
        f"{manifest['word_count']} words, sha256={manifest['sha256'][:16]}"
    )


if __name__ == "__main__":
    main()
