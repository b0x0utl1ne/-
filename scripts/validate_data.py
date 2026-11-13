#!/usr/bin/env python3
"""Cheap acceptance checks for the generated CET-6 wordbook dataset."""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = json.loads((ROOT / "data" / "words.json").read_text(encoding="utf-8"))
WORD_RE = re.compile(r"[A-Za-z]+(?:[-'][A-Za-z]+)*")


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def main() -> None:
    meta = DATA["meta"]
    words = DATA["words"]
    core = [word for word in words if word["core"]]
    articles = DATA["articles"]
    by_id = {word["id"]: word for word in words}
    article_ids = {article["id"] for article in articles}
    if len(DATA["sets"]) != 12:
        fail(f"expected 12 sets, got {len(DATA['sets'])}")
    if len(core) != 700:
        fail(f"expected 700 core words, got {len(core)}")
    if len(by_id) != len(words):
        fail("duplicate word ids")
    if len(article_ids) != len(articles):
        fail("duplicate article ids")
    if len(DATA["forms"]) < 6000:
        fail(f"too few form mappings: {len(DATA['forms'])}")
    rank_values = [word["daily_rank"] for word in core]
    if sorted(rank_values) != list(range(1, 701)):
        fail("core daily_rank is not exactly 1..700")
    for word in core:
        if not word["phonetic"].startswith("/") or len(word["phonetic"]) < 3:
            fail(f"core word lacks phonetic: {word['id']}")
        if not word["definition"]:
            fail(f"core word lacks definition: {word['id']}")
        if not word["context"] or not word["context"].get("text"):
            fail(f"core word lacks context: {word['id']}")
        if word["context"].get("article_id") and word["context"]["article_id"] not in article_ids:
            fail(f"core context article missing: {word['id']}")
    teacher_picks = [word for word in words if word["teacher_pick"]]
    if len(teacher_picks) < 300:
        fail(f"too few teacher picks: {len(teacher_picks)}")
    if not all(word["core"] for word in teacher_picks):
        fail("some teacher-pick words are not in the core queue")

    forms = DATA["forms"]
    missing = Counter()
    total = 0
    covered = 0
    for article in articles:
        for paragraph in article["paragraphs"]:
            for match in WORD_RE.finditer(paragraph):
                form = match.group(0).lower().replace("’", "'")
                total += 1
                if form in forms:
                    covered += 1
                else:
                    missing[form] += 1
    if covered / total < 0.94:
        fail(f"form coverage too low: {covered}/{total}")

    plan = DATA["plan"]
    if len(plan) != 30 or plan[-1]["kind"] != "exam":
        fail("plan must contain 29 study days plus exam day")
    if plan[0]["date"] != "2026-11-13" or plan[-1]["date"] != "2026-12-12":
        fail("plan date range is wrong")

    site_data = ROOT / "site" / "data.js"
    if not site_data.exists() or "window.CET6_DATA=" not in site_data.read_text(encoding="utf-8")[:100]:
        fail("site/data.js missing or malformed")
    site_payload = json.loads(
        site_data.read_text(encoding="utf-8")
        .split("=", 1)[1]
        .rsplit(";", 1)[0]
    )
    site_listening = site_payload.get("listening")
    if not site_listening:
        fail("site/data.js missing listening metadata")
    if len(site_listening.get("sets", [])) != len(DATA["sets"]):
        fail("listening metadata does not cover every set")
    starts = []
    listening_ids = set()
    listening_words = 0
    for listening_set in site_listening["sets"]:
        segments = listening_set.get("segments", [])
        if len(segments) != 7:
            fail(f"{listening_set.get('id')}: expected 7 listening segments")
        if not listening_set.get("audio_url"):
            fail(f"{listening_set.get('id')}: missing audio URL")
        set_starts = [segment["start"] for segment in segments]
        if set_starts != sorted(set_starts) or len(set_starts) != len(set(set_starts)):
            fail(f"{listening_set.get('id')}: segment starts are not increasing")
        for segment in segments:
            if segment["id"] in listening_ids:
                fail(f"duplicate listening segment id: {segment['id']}")
            listening_ids.add(segment["id"])
            if not segment.get("paragraphs") or not segment.get("questions"):
                fail(f"{segment['id']}: missing transcript or question range")
            if not segment.get("label") or segment.get("word_count", 0) < 20:
                fail(f"{segment['id']}: invalid label or word count")
            listening_words += segment["word_count"]
        starts.extend(set_starts)
    single_html = ROOT / "CET6-词书.html"
    if single_html.exists():
        single_text = single_html.read_text(encoding="utf-8")
        if "<script src=" in single_text or "<link rel=\"stylesheet\"" in single_text:
            fail("single-file HTML still contains external dependencies")
        if "window.CET6_DATA=" not in single_text:
            fail("single-file HTML missing embedded data")

    print("PASS")
    print(f"sets={len(DATA['sets'])} articles={len(articles)} words={len(words)} core={len(core)}")
    print(f"teacher_picks={len(teacher_picks)} forms={len(forms)}")
    print(f"article_token_coverage={covered}/{total} ({covered / total:.1%})")
    print(f"missing_top={missing.most_common(12)}")
    print(f"plan_days={len(plan)} plan_range={plan[0]['date']}..{plan[-1]['date']}")
    print(
        f"listening_sets={len(site_listening['sets'])} "
        f"listening_segments={len(listening_ids)} "
        f"listening_words={listening_words}"
    )
    print(f"site_data={site_data.stat().st_size / 1024 / 1024:.1f} MiB")
    if single_html.exists():
        print(f"single_html={single_html.stat().st_size / 1024 / 1024:.1f} MiB")
    print(f"wordbook_meta_core={meta['core_count']} word_count={meta['word_count']}")


if __name__ == "__main__":
    main()
