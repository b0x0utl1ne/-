#!/usr/bin/env python3
"""Build section-level listening metadata from the cached LazyNote pages."""

from __future__ import annotations

import json
import re
import time
from html import unescape
from pathlib import Path
from typing import Any

import requests
from lxml import html


ROOT = Path(__file__).resolve().parents[1]
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
SECTION_LABELS = {
    (1, 4): "长对话1",
    (5, 8): "长对话2",
    (9, 11): "短文1",
    (12, 15): "短文2",
    (16, 18): "讲座1",
    (19, 21): "讲座2",
    (22, 25): "讲座3",
}
AUDIO_OVERRIDES = {
    "2026-06-1": {
        "resolve_page": "https://m.qingting.fm/vchannels/284150/programs/33551172/",
        "source": "蜻蜓FM（25:36 同版）",
        "source_page": "https://m.qingting.fm/vchannels/284150/programs/33551172/",
        "note": "CET通暂未提供本套录音；这里使用与懒笔记分段一致的 25:36 完整录音。",
    },
}
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}
WORD_RE = re.compile(r"[A-Za-z]+(?:[-'][A-Za-z]+)*")


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def fetch_page(session: requests.Session, set_id: str) -> str:
    cache_path = ROOT / "data" / "raw" / "listening" / f"{set_id}.html"
    if cache_path.exists() and cache_path.stat().st_size > 1000:
        return cache_path.read_text(encoding="utf-8")
    url = f"{BASE_URL}/cet6/sections/listening/{set_id}/"
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


def paragraph_text(node: html.HtmlElement) -> str:
    text_nodes = node.xpath(
        './/text()[not(ancestor::span[contains(@class,"exam-pno")])]'
    )
    return normalize_space(" ".join(text_nodes))


def audio_candidates(set_id: str) -> dict[str, str]:
    if set_id in AUDIO_OVERRIDES:
        return AUDIO_OVERRIDES[set_id]
    return {
        "url": (
            "https://www.cettong.cn/library/cet6/"
            f"{set_id.replace('-', '_')}/listening.mp3"
        ),
        "source": "CET通",
        "source_page": "https://www.cettong.cn/library/cet6",
        "note": "",
    }


def check_audio(session: requests.Session, url: str) -> tuple[bool, int | None]:
    try:
        response = session.get(
            url,
            headers={"Range": "bytes=0-1023"},
            timeout=20,
            allow_redirects=True,
        )
        ok = response.status_code in (200, 206) and "audio" in response.headers.get(
            "Content-Type", ""
        )
        content_range = response.headers.get("Content-Range", "")
        total = None
        if "/" in content_range:
            try:
                total = int(content_range.rsplit("/", 1)[1])
            except ValueError:
                pass
        return ok, total
    except requests.RequestException:
        return False, None


def resolve_audio(
    session: requests.Session, set_id: str
) -> tuple[dict[str, str], str, int | None]:
    audio = audio_candidates(set_id)
    if "url" in audio:
        ok, size = check_audio(session, audio["url"])
        if not ok:
            raise RuntimeError(f"{set_id}: audio source is not available: {audio['url']}")
        return audio, audio["url"], size

    page_url = audio["resolve_page"]
    response = session.get(page_url, timeout=30)
    response.raise_for_status()
    match = re.search(r'"audioUrl":"(https:[^"]+)"', response.text)
    if not match:
        raise RuntimeError(f"{set_id}: audioUrl not found on {page_url}")
    redirect_url = (
        match.group(1)
        .replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("&amp;", "&")
    )
    media = session.get(
        redirect_url,
        headers={"Range": "bytes=0-1023"},
        timeout=30,
        allow_redirects=True,
    )
    media.raise_for_status()
    if "audio" not in media.headers.get("Content-Type", ""):
        raise RuntimeError(f"{set_id}: resolved URL is not audio: {media.url}")
    total = None
    content_range = media.headers.get("Content-Range", "")
    if "/" in content_range:
        try:
            total = int(content_range.rsplit("/", 1)[1])
        except ValueError:
            pass
    return audio, media.url, total


def parse_piece_end_times(page_html: str) -> dict[float, float]:
    doc = html.fromstring(page_html)
    values = doc.xpath(
        '//astro-island[contains(@component-url,"ListeningAudioBar")]/@props'
    )
    if not values:
        raise RuntimeError("ListeningAudioBar props not found")
    payload = json.loads(unescape(values[0]))
    pieces = payload.get("pieces", [1, []])[1]
    end_times: dict[float, float] = {}
    for entry in pieces:
        if not entry or entry[0] != 0 or not isinstance(entry[1], dict):
            continue
        piece = entry[1]
        start = piece.get("start", [0, None])[1]
        end = piece.get("end", [0, None])[1]
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            end_times[round(float(start), 3)] = float(end)
    return end_times


def parse_segments(
    page_html: str,
    set_id: str,
    set_label: str,
    article_by_section: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    doc = html.fromstring(page_html)
    end_times = parse_piece_end_times(page_html)
    pieces = doc.xpath('//*[starts-with(@id,"lt-")]')
    segments: list[dict[str, Any]] = []
    for piece in pieces:
        heading = normalize_space(
            " ".join(piece.xpath('.//div[contains(@class,"lt-piece-head")]//span//text()'))
        )
        question_match = re.search(
            r"Questions?\s+(\d+)(?:\s+to\s+(\d+))?", heading, re.IGNORECASE
        )
        seek_values = piece.xpath(".//*[@data-listen-seek]/@data-listen-seek")
        if not question_match or not seek_values:
            continue
        start_question = int(question_match.group(1))
        end_question = int(question_match.group(2) or question_match.group(1))
        key = (start_question, end_question)
        if key not in SECTION_LABELS:
            raise RuntimeError(
                f"{set_id}: unexpected question range {start_question}-{end_question}"
            )
        paragraphs = [
            paragraph_text(node)
            for node in piece.xpath('.//p[contains(@class,"lt-en")]')
        ]
        paragraphs = [value for value in paragraphs if value]
        if not paragraphs:
            raise RuntimeError(f"{set_id}: no transcript for {key}")
        label = SECTION_LABELS[key]
        article = article_by_section.get(label)
        segments.append(
            {
                "id": f"{set_id}/q{start_question}-{end_question}",
                "label": label,
                "questions": (
                    f"Q{start_question}–{end_question}"
                    if start_question != end_question
                    else f"Q{start_question}"
                ),
                "start": float(seek_values[0]),
                "paragraphs": paragraphs,
                "word_count": sum(len(WORD_RE.findall(value)) for value in paragraphs),
                "article_id": article["id"] if article else "",
                "article_url": article["url"] if article else "",
            }
        )
    if len(segments) != 7:
        raise RuntimeError(f"{set_id}: expected 7 listening segments, got {len(segments)}")
    for index, segment in enumerate(segments):
        exact_end = end_times.get(round(float(segment["start"]), 3))
        if exact_end is None or exact_end <= segment["start"]:
            exact_end = (
                segments[index + 1]["start"]
                if index + 1 < len(segments)
                else None
            )
        segment["end"] = exact_end
        segment["set_id"] = set_id
        segment["set_label"] = set_label
    return segments


def main() -> None:
    wordbook = json.loads((ROOT / "data" / "words.json").read_text(encoding="utf-8"))
    set_labels = {item["id"]: item["label"] for item in wordbook["sets"]}
    article_index: dict[str, dict[str, dict[str, Any]]] = {}
    for article in wordbook["articles"]:
        if not article["section"].startswith("听力"):
            continue
        article_index.setdefault(article["set_id"], {})[article["section"][3:]] = article

    session = requests.Session()
    session.headers.update(HEADERS)
    sets = []
    for set_id in SET_IDS:
        page_html = fetch_page(session, set_id)
        segments = parse_segments(
            page_html,
            set_id,
            set_labels[set_id],
            article_index.get(set_id, {}),
        )
        audio, audio_url, audio_bytes = resolve_audio(session, set_id)
        sets.append(
            {
                "id": set_id,
                "label": set_labels[set_id],
                "source_url": f"{BASE_URL}/cet6/sections/listening/{set_id}/",
                "audio_url": audio_url,
                "audio_source": audio["source"],
                "audio_source_page": audio["source_page"],
                "audio_note": audio["note"],
                "audio_status": "ok",
                "audio_bytes": audio_bytes,
                "segments": segments,
            }
        )
        print(
            f"{set_id}: {len(segments)} segments, "
            f"{sum(item['word_count'] for item in segments)} words, audio ok"
        )

    payload = {
        "schema_version": 1,
        "method": "盲听做题 → 核对答案 → 原文精读 → 关键句听写 → 跟读",
        "segment_count": sum(len(item["segments"]) for item in sets),
        "sets": sets,
    }
    target = ROOT / "data" / "listening_meta.json"
    target.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {target} ({target.stat().st_size / 1024:.1f} KiB), "
        f"{payload['segment_count']} segments"
    )


if __name__ == "__main__":
    main()
