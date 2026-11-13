#!/usr/bin/env python3
"""Build the study dataset from the article corpus, PDF supplements and ECDICT."""

from __future__ import annotations

import csv
import json
import math
import re
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
CORPUS_DIR = ROOT / "data" / "corpus"
REFERENCE_PATH = ROOT / "data" / "reference" / "cet6_frequency.json"
ECDICT_PATH = ROOT / "data" / "raw" / "ecdict.csv"
PDF_TEXT_DIR = ROOT / "data" / "raw" / "pdf_text"
OUTPUT_PATH = ROOT / "data" / "words.json"

WORD_RE = re.compile(r"[A-Za-z]+(?:[-'][A-Za-z]+)*")
SET_ORDER = [
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
SECTION_WEIGHTS = {
    "仔细阅读1": 9,
    "仔细阅读2": 9,
    "长篇阅读": 8,
    "选词填空": 7,
    "听力·讲座1": 5,
    "听力·讲座2": 5,
    "听力·讲座3": 5,
    "听力·短文1": 4,
    "听力·短文2": 4,
    "听力·长对话1": 3,
    "听力·长对话2": 3,
}

STOPWORDS = set(
    """
    a an the and or but if because so than then that this these those
    i me my mine myself we us our ours ourselves you your yours yourself
    yourselves he him his himself she her hers herself it its itself
    they them their theirs themselves who whom whose which what whatever
    when where why how whether while whereas although though unless until
    of to in on at for from with by about into over after before between
    under through during without within across against among around upon
    above below off out up down onto toward towards per via
    is am are was were be been being have has had having do does did done
    doing can could may might must shall should will would
    not no nor only also just even still yet already very too quite rather
    more most less least many much some any each every all both either
    neither another other others such same own few several enough
    one two three four five six seven eight nine ten first second third
    last next previous following
    there here now today tomorrow yesterday
    about above across after again against ago along already also although
    always among around away before behind below beneath beside besides
    between beyond both down during each either else even ever every from
    however if in into like may might more most much must near never no
    not now of off often on once only onto or other out over per perhaps
    quite rather since so some soon still such than that the their them
    then there therefore these they this those though through thus to
    together too toward towards under until up upon very via was we were
    what when where whether which while who why will with within without
    would yet
    mr mrs ms dr prof st vs etc eg ie am pm
    """.split()
)

CORE_EXCLUDE = set(
    """
    according including given provided regarding concerning based used related
    compared following depending something anyone everyone someone nothing
    everything anything
    """.split()
)

MANUAL_WORDS = {
    "affordable": ("/əˈfɔːdəbl/", "adj. 负担得起的；价格合理的"),
    "co-founder": ("/ˌkəʊˈfaʊndə/", "n. 联合创始人"),
    "counter-intuitive": ("/ˌkaʊntər ɪnˈtjuːɪtɪv/", "adj. 反直觉的"),
    "decision-making": ("/dɪˈsɪʒn ˌmeɪkɪŋ/", "n. 决策；决策过程"),
    "laptop": ("/ˈlæptɒp/", "n. 笔记本电脑"),
    "long-term": ("/ˌlɒŋ ˈtɜːm/", "adj. 长期的"),
    "online": ("/ˌɒnˈlaɪn/", "adj. 在线的；联网的 | adv. 在线地"),
    "self-denial": ("/ˌself dɪˈnaɪəl/", "n. 自我否定；克己"),
    "short-term": ("/ˌʃɔːt ˈtɜːm/", "adj. 短期的"),
    "smartphone": ("/ˈsmɑːtfəʊn/", "n. 智能手机"),
    "so-called": ("/ˌsəʊ ˈkɔːld/", "adj. 所谓的"),
    "ultra-processed": ("/ˌʌltrəˈprəʊsest/", "adj. 超加工的"),
    "website": ("/ˈwebsaɪt/", "n. 网站"),
    "workforce": ("/ˈwɜːkfɔːs/", "n. 劳动力；全体员工"),
    "workplace": ("/ˈwɜːkpleɪs/", "n. 工作场所"),
    "year-old": ("/ˈjɪər əʊld/", "adj. ……岁的"),
}

ABBREVIATIONS = [
    "Mr.",
    "Mrs.",
    "Ms.",
    "Dr.",
    "Prof.",
    "St.",
    "No.",
    "vs.",
    "etc.",
    "e.g.",
    "i.e.",
    "U.S.",
    "U.K.",
    "a.m.",
    "p.m.",
    "Ph.D.",
    "Jan.",
    "Feb.",
    "Mar.",
    "Apr.",
    "Jun.",
    "Jul.",
    "Aug.",
    "Sept.",
    "Oct.",
    "Nov.",
    "Dec.",
]


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_apostrophes(text: str) -> str:
    return text.replace("’", "'").replace("‘", "'")


def split_sentences(text: str) -> list[str]:
    text = normalize_space(text)
    if not text:
        return []
    protected = text
    for index, abbrev in enumerate(ABBREVIATIONS):
        placeholder = chr(0xE000 + index)
        protected = protected.replace(abbrev, abbrev.replace(".", placeholder))
    parts = re.split(
        r"(?<=[.!?])\s+|(?<=[.!?][\"'”’])\s+",
        protected,
    )
    sentences = []
    for part in parts:
        for index, abbrev in enumerate(ABBREVIATIONS):
            placeholder = chr(0xE000 + index)
            part = part.replace(abbrev.replace(".", placeholder), abbrev)
        part = normalize_space(part)
        if part:
            sentences.append(part)
    if not sentences:
        return [text]
    merged: list[str] = []
    for sentence in sentences:
        if merged and len(merged[-1].split()) < 6:
            merged[-1] = f"{merged[-1]} {sentence}"
        else:
            merged.append(sentence)
    return merged


def tokenize(text: str) -> list[tuple[str, str]]:
    tokens = []
    for match in WORD_RE.finditer(normalize_apostrophes(text)):
        original = match.group(0)
        form = original.lower()
        if len(form) < 2:
            continue
        tokens.append((form, original))
    return tokens


def parse_exchange(value: str) -> list[str]:
    forms = []
    for part in value.split("/"):
        if ":" not in part:
            continue
        key, payload = part.split(":", 1)
        if key not in {"s", "p", "d", "i", "3", "r", "t"}:
            continue
        for form in payload.split(","):
            form = normalize_apostrophes(form.strip().lower())
            if form:
                forms.append(form)
    return forms


def normalize_phonetic(value: str) -> str:
    value = normalize_space(value).strip("/[]")
    if not value:
        return ""
    value = value.replace("ә", "ə")
    value = value.replace("ɑ:", "ɑː").replace("a:", "ɑː")
    value = value.replace("ɒ:", "ɔː").replace("ɔ:", "ɔː")
    value = value.replace("i:", "iː").replace("u:", "uː")
    value = value.replace("ə:", "ɜː").replace("e:", "eɪ")
    value = value.replace("ei", "eɪ").replace("ai", "aɪ").replace("au", "aʊ")
    value = value.replace("ɔi", "ɔɪ").replace("əu", "oʊ").replace("ou", "oʊ")
    value = value.replace("'", "ˈ").replace(",", "ˌ")
    value = value.replace(".", "ˌ")
    value = re.sub(r"[ˈˌ]{2,}", "ˈ", value)
    return f"/{value}/"


def clean_definition(value: str) -> str:
    if not value:
        return ""
    value = value.replace("\\r", "\n").replace("\\n", "\n")
    lines = []
    for raw_line in value.splitlines():
        line = normalize_space(raw_line)
        if not line:
            continue
        if re.match(r"^\[[^\]]+\]", line):
            continue
        line = re.sub(r"\[[^\]]+\]", "", line)
        line = line.strip()
        if not line:
            continue
        line = re.sub(r"^([a-z]{1,4})\.\s*", lambda m: m.group(1) + ". ", line)
        line = re.sub(r"^vt\.vi\.\s*", "v. ", line)
        line = re.sub(r"^vi\.vt\.\s*", "v. ", line)
        line = re.sub(r"^vt\.\s*", "v. ", line)
        line = re.sub(r"^vi\.\s*", "v. ", line)
        line = re.sub(r"[；|]\s*(DOS内部命令|该命令用于).*$", "", line)
        line = line.replace("...", "…").replace("...", "…")
        line = re.sub(r"\s*,\s*", "；", line)
        line = re.sub(r"；{2,}", "；", line)
        line = line.strip("； ")
        if line:
            lines.append(line)
    if not lines:
        return ""
    pos_map = [
        (r"^a\.\s*", "adj. "),
        (r"^ad\.\s*", "adv. "),
        (r"^adv\.\s*", "adv. "),
        (r"^adj\.\s*", "adj. "),
        (r"^vt\.\s*", "v. "),
        (r"^vi\.\s*", "v. "),
        (r"^v\.\s*", "v. "),
        (r"^n\.\s*", "n. "),
        (r"^prep\.\s*", "prep. "),
        (r"^conj\.\s*", "conj. "),
        (r"^pron\.\s*", "pron. "),
        (r"^num\.\s*", "num. "),
        (r"^aux\.\s*", "aux. "),
        (r"^int\.\s*", "int. "),
    ]
    normalized = []
    seen = set()
    for line in lines:
        for pattern, replacement in pos_map:
            if re.match(pattern, line):
                line = re.sub(pattern, replacement, line)
                break
        line = re.sub(
            r"^(v|adj|adv|n|prep|conj|pron|num|aux|int)\.\s+(vi|vt)\.\s*",
            r"\1. ",
            line,
        )
        line = re.sub(r"；{2,}", "；", line).strip("； ")
        if not line or line in seen:
            continue
        seen.add(line)
        normalized.append(line)
        if len(normalized) >= 3:
            break
    result = " | ".join(normalized)
    if len(result) > 130:
        result = result[:129].rstrip("；|, ") + "…"
    return result


def reference_word_score(
    word: str,
    ref_map: dict[str, dict[str, Any]],
) -> float:
    item = ref_map.get(word)
    if not item:
        return 0.0
    rank = max(1, int(item["rank"]))
    return max(0.0, 8.0 - math.log10(rank) * 2.0)


def choose_lemma(
    form: str,
    candidates: list[str],
    dict_entries: dict[str, dict[str, Any]],
    ref_map: dict[str, dict[str, Any]],
) -> str:
    regular_inflection = (
        form.endswith("ed")
        or form.endswith("ing")
        or form.endswith("ies")
        or form.endswith("ied")
        or (
            form.endswith("s")
            and not form.endswith(("ss", "us", "is"))
        )
    )
    if form in dict_entries and form in ref_map and not regular_inflection:
        return form
    best = form if form in dict_entries else ""
    best_score = -1e9
    for candidate in candidates:
        if candidate not in dict_entries:
            continue
        entry = dict_entries[candidate]
        score = reference_word_score(candidate, ref_map)
        tags = set(entry["tags"])
        if "cet6" in tags:
            score += 4
        elif "ky" in tags:
            score += 2
        if entry["phonetic"]:
            score += 0.5
        score += 0.2 if candidate == form else 0
        if score > best_score:
            best = candidate
            best_score = score
    return best or form


def suffix_lemma(
    form: str,
    dict_entries: dict[str, dict[str, Any]],
) -> str:
    best = ""
    best_score = -1.0
    for candidate in lookup_candidates(form):
        if candidate == form:
            continue
        entry = dict_entries.get(candidate)
        if not entry:
            continue
        score = 0.0
        if entry["phonetic"]:
            score += 3
        if entry["translation"]:
            score += 1
        if entry["tags"]:
            score += 1
        score += len(candidate) * 0.01
        if score > best_score:
            best = candidate
            best_score = score
    return best


def lookup_candidates(form: str) -> list[str]:
    candidates = [form]
    if form.endswith("'s") and len(form) > 3:
        candidates.append(form[:-2])
    if form.endswith("n't") and len(form) > 4:
        candidates.append(form[:-3])
    contraction_map = {
        "can't": "can",
        "won't": "will",
        "shan't": "shall",
        "let's": "let",
    }
    if form in contraction_map:
        candidates.append(contraction_map[form])
    if form.endswith("ies") and len(form) > 4:
        candidates.append(form[:-3] + "y")
    if form.endswith("ied") and len(form) > 4:
        candidates.append(form[:-3] + "y")
    if form.endswith("ing") and len(form) > 5:
        base = form[:-3]
        candidates.extend([base, base + "e", base[:-1] if len(base) > 3 else base])
    if form.endswith("ed") and len(form) > 4:
        base = form[:-2]
        candidates.extend([base, base + "e", base[:-1] if len(base) > 3 else base])
    if form.endswith("ly") and len(form) > 5:
        base = form[:-2]
        candidates.append(base)
        if base.endswith("i"):
            candidates.append(base[:-1] + "y")
    if form.endswith("able") and len(form) > 6:
        candidates.append(form[:-4])
    if form.endswith("ible") and len(form) > 6:
        candidates.append(form[:-4])
    if form.endswith("ness") and len(form) > 6:
        candidates.append(form[:-4])
    if form.endswith("ment") and len(form) > 6:
        candidates.append(form[:-4])
    if form.endswith("ful") and len(form) > 5:
        candidates.append(form[:-3])
    if form.endswith("less") and len(form) > 6:
        candidates.append(form[:-4])
    if form.endswith("ive") and len(form) > 5:
        candidates.extend([form[:-3], form[:-3] + "e"])
    if form.endswith("ous") and len(form) > 5:
        candidates.extend([form[:-3], form[:-3] + "e"])
    if form.endswith("es") and len(form) > 4:
        candidates.extend([form[:-2], form[:-1]])
    if form.endswith("s") and len(form) > 3:
        candidates.append(form[:-1])
    return list(dict.fromkeys(candidates))


def spelling_variants(form: str) -> set[str]:
    variants = {form}
    suffix_map = [
        ("isation", "ization"),
        ("isations", "izations"),
        ("ise", "ize"),
        ("ised", "ized"),
        ("ising", "izing"),
        ("ises", "izes"),
        ("yse", "yze"),
        ("ysed", "yzed"),
        ("ysing", "yzing"),
        ("yses", "yzes"),
    ]
    for british, american in suffix_map:
        if form.endswith(british):
            variants.add(form[: -len(british)] + american)
    return variants


def canonicalize_lemma(
    lemma: str,
    dict_entries: dict[str, dict[str, Any]],
) -> str:
    candidates = [lemma]
    if lemma.endswith(("ise", "ised", "ising", "ises")):
        for variant in spelling_variants(lemma):
            if variant != lemma:
                candidates.append(variant)
    best = lemma
    best_score = -1
    for candidate in candidates:
        entry = dict_entries.get(candidate)
        if not entry:
            continue
        score = 0
        if entry["phonetic"]:
            score += 2
        if entry["translation"]:
            score += 1
        if entry["tags"]:
            score += 1
        if candidate == lemma:
            score += 0.5
        if score > best_score:
            best = candidate
            best_score = score
    return best


def load_ecdict(all_forms: set[str]) -> tuple[dict[str, dict[str, Any]], dict[str, list[str]]]:
    if not ECDICT_PATH.exists():
        raise SystemExit(
            f"missing {ECDICT_PATH}; run: curl -L "
            "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv "
            "-o data/raw/ecdict.csv"
        )
    entries: dict[str, dict[str, Any]] = {}
    reverse: dict[str, list[str]] = defaultdict(list)
    lookup_forms: set[str] = set()
    for form in all_forms:
        lookup_forms.update(spelling_variants(form))
        lookup_forms.update(lookup_candidates(form))
    with ECDICT_PATH.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            word = normalize_apostrophes((row.get("word") or "").strip().lower())
            if not word:
                continue
            exchange_forms = parse_exchange(row.get("exchange") or "")
            if word not in lookup_forms and not any(f in all_forms for f in exchange_forms):
                continue
            entry = {
                "word": word,
                "phonetic": normalize_phonetic(row.get("phonetic") or ""),
                "translation": row.get("translation") or "",
                "definition": row.get("definition") or "",
                "pos": row.get("pos") or "",
                "collins": int(row.get("collins") or 0),
                "oxford": int(row.get("oxford") or 0),
                "tags": [tag for tag in (row.get("tag") or "").split() if tag],
                "bnc": int(row.get("bnc") or 0),
                "frq": int(row.get("frq") or 0),
                "exchange": exchange_forms,
            }
            entries[word] = entry
            for form in exchange_forms:
                if form in all_forms and form != word:
                    reverse[form].append(word)
    return entries, reverse


def occurrence_score(
    sentence: str,
    section: str,
    set_id: str,
) -> float:
    length = len(sentence.split())
    score = SECTION_WEIGHTS.get(section, 2) * 2.0
    if 10 <= length <= 32:
        score += 10
    elif 8 <= length <= 45:
        score += 5
    elif length < 8:
        score -= 5
    else:
        score -= min(8, (length - 45) * 0.25)
    if sentence.startswith(("W:", "M:", "Man:", "Woman:")):
        score -= 4
    if "___" in sentence or "____" in sentence:
        score -= 15
    if "?" in sentence:
        score -= 1
    score += max(0, 12 - SET_ORDER.index(set_id)) * 0.1
    return score


def clean_pdf_sentence(sentence: str) -> bool:
    if not sentence:
        return False
    lowered = sentence.lower()
    if any(marker in sentence for marker in ("A)", "B)", "C)", "D)")):
        return False
    if any(
        marker in lowered
        for marker in (
            "directions:",
            "answer sheet",
            "questions ",
            "question ",
            "part i",
            "section a",
            "section b",
            "section c",
            "you should write",
            "you are allowed",
        )
    ):
        return False
    if "___" in sentence:
        return False
    length = len(sentence.split())
    return 8 <= length <= 48


def build_plan(set_payloads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    start = date(2026, 11, 13)
    by_id = {item["id"]: item for item in set_payloads}
    plan: list[dict[str, Any]] = []
    cursor = 0
    for group_index in range(4):
        for _ in range(3):
            set_id = SET_ORDER[cursor]
            cursor += 1
            payload = by_id[set_id]
            listening = [
                article["slug"]
                for article in payload["articles"]
                if article["section"].startswith("听力")
                or article["section"] == "选词填空"
            ]
            reading = [
                article["slug"]
                for article in payload["articles"]
                if article["section"] in ("长篇阅读", "仔细阅读1", "仔细阅读2")
            ]
            for part, slugs, focus in (
                (
                    "A",
                    listening,
                    "听力原文 + 选词填空：先听/做题，再逐段精读",
                ),
                (
                    "B",
                    reading,
                    "长篇阅读 + 仔细阅读：先限时做题，再回看生词",
                ),
            ):
                plan.append(
                    {
                        "day": len(plan) + 1,
                        "date": str(start + timedelta(days=len(plan))),
                        "kind": "study",
                        "set_id": set_id,
                        "set_label": payload["label"],
                        "part": part,
                        "focus": focus,
                        "article_slugs": slugs,
                        "new_target": 25,
                        "minutes": 75,
                    }
                )
        if group_index < 3:
            plan.append(
                {
                    "day": len(plan) + 1,
                    "date": str(start + timedelta(days=len(plan))),
                    "kind": "weekly",
                    "set_id": "",
                    "set_label": "阶段复习",
                    "part": "",
                    "focus": "回看本周陌生/收藏词，做 20 道语境题，不碰新文章",
                    "article_slugs": [],
                    "new_target": 10,
                    "minutes": 55,
                }
            )
    plan.append(
        {
            "day": len(plan) + 1,
            "date": str(start + timedelta(days=len(plan))),
            "kind": "mock",
            "set_id": "2026-06-1",
            "set_label": "2026年6月 第1套",
            "part": "全卷",
            "focus": "15:00–17:25 全真模考；晚上只复盘错题，不再开新文章",
            "article_slugs": [],
            "new_target": 0,
            "minutes": 195,
        }
    )
    plan.append(
        {
            "day": len(plan) + 1,
            "date": str(start + timedelta(days=len(plan))),
            "kind": "sprint",
            "set_id": "",
            "set_label": "考前轻复习",
            "part": "",
            "focus": "只过陌生/收藏词与作文模板；检查证件、耳机、电池；23:00 前睡",
            "article_slugs": [],
            "new_target": 0,
            "minutes": 40,
        }
    )
    plan.append(
        {
            "day": len(plan) + 1,
            "date": "2026-12-12",
            "kind": "exam",
            "set_id": "",
            "set_label": "CET-6 笔试",
            "part": "",
            "focus": "15:00–17:25 考试；提前 40 分钟到场",
            "article_slugs": [],
            "new_target": 0,
            "minutes": 145,
        }
    )
    return plan


def main() -> None:
    if not CORPUS_DIR.exists():
        raise SystemExit("missing data/corpus; run scripts/fetch_corpus.py first")
    if not REFERENCE_PATH.exists():
        raise SystemExit("missing CET-6 reference list; run scripts/fetch_reference.py first")

    manifest = json.loads((CORPUS_DIR / "manifest.json").read_text(encoding="utf-8"))
    set_payloads = []
    for set_id in SET_ORDER:
        payload = json.loads((CORPUS_DIR / f"{set_id}.json").read_text(encoding="utf-8"))
        set_payloads.append(payload)

    reference = json.loads(REFERENCE_PATH.read_text(encoding="utf-8"))
    ref_map = {item["word"]: item for item in reference["entries"]}

    all_forms: set[str] = set()
    article_tokens: list[tuple[dict[str, Any], int, int, str, str, str]] = []
    pdf_texts: dict[str, str] = {}
    for payload in set_payloads:
        for article in payload["articles"]:
            for paragraph_index, paragraph in enumerate(article["paragraphs"]):
                for sentence_index, sentence in enumerate(split_sentences(paragraph)):
                    for form, original in tokenize(sentence):
                        all_forms.add(form)
                        article_tokens.append(
                            (
                                article,
                                paragraph_index,
                                sentence_index,
                                sentence,
                                form,
                                original,
                            )
                        )
    for set_id in SET_ORDER:
        path = PDF_TEXT_DIR / f"{set_id}.txt"
        if path.exists():
            pdf_texts[set_id] = path.read_text(encoding="utf-8", errors="replace")
            for form, _ in tokenize(pdf_texts[set_id]):
                all_forms.add(form)

    dict_entries, reverse_candidates = load_ecdict(all_forms)
    for word, (phonetic, translation) in MANUAL_WORDS.items():
        existing = dict_entries.get(word)
        if existing:
            if not existing["phonetic"]:
                existing["phonetic"] = phonetic
            if not existing["translation"]:
                existing["translation"] = translation
        else:
            dict_entries[word] = {
                "word": word,
                "phonetic": phonetic,
                "translation": translation,
                "definition": "",
                "pos": "",
                "collins": 0,
                "oxford": 0,
                "tags": [],
                "bnc": 0,
                "frq": 0,
                "exchange": [],
            }
    form_to_lemma: dict[str, str] = {}
    for form in all_forms:
        lemma = choose_lemma(
            form,
            reverse_candidates.get(form, []),
            dict_entries,
            ref_map,
        )
        lemma = canonicalize_lemma(lemma, dict_entries)
        if lemma not in dict_entries or not dict_entries[lemma]["phonetic"]:
            lemma = suffix_lemma(form, dict_entries) or form
            lemma = canonicalize_lemma(lemma, dict_entries)
        form_to_lemma[form] = lemma

    article_freq: Counter[str] = Counter()
    article_sets: dict[str, set[str]] = defaultdict(set)
    pdf_freq: Counter[str] = Counter()
    pdf_sets: dict[str, set[str]] = defaultdict(set)
    occurrences: dict[str, list[dict[str, Any]]] = defaultdict(list)
    forms_by_lemma: dict[str, set[str]] = defaultdict(set)
    teacher_pick_counts: Counter[str] = Counter()

    for payload in set_payloads:
        for article in payload["articles"]:
            for key_word in article.get("key_words", []):
                form = normalize_apostrophes(key_word.strip().lower())
                if " " in form or not form:
                    continue
                lemma = form_to_lemma.get(form, form)
                lemma = canonicalize_lemma(lemma, dict_entries)
                if lemma in dict_entries and lemma not in STOPWORDS:
                    teacher_pick_counts[lemma] += 1

    for (
        article,
        paragraph_index,
        sentence_index,
        sentence,
        form,
        original,
    ) in article_tokens:
        lemma = form_to_lemma.get(form, form)
        if lemma not in dict_entries:
            continue
        if len(lemma) < 2:
            continue
        article_freq[lemma] += 1
        article_sets[lemma].add(article["set_id"])
        forms_by_lemma[lemma].add(form)
        suffix = min(len(sentence), 420)
        occurrences[lemma].append(
            {
                "sentence": sentence[:suffix].strip(),
                "surface": original,
                "article_id": article["id"],
                "set_id": article["set_id"],
                "section": article["section"],
                "title": article["title"],
                "part": article["part"],
                "paragraph_index": paragraph_index,
                "sentence_index": sentence_index,
                "score": occurrence_score(
                    sentence,
                    article["section"],
                    article["set_id"],
                ),
            }
        )

    pdf_occurrences: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for set_id, text in pdf_texts.items():
        compact = normalize_space(text)
        for sentence in split_sentences(compact):
            if not clean_pdf_sentence(sentence):
                continue
            for form, original in tokenize(sentence):
                lemma = form_to_lemma.get(form, form)
                if lemma not in dict_entries:
                    continue
                pdf_freq[lemma] += 1
                pdf_sets[lemma].add(set_id)
                forms_by_lemma[lemma].add(form)
                if len(pdf_occurrences[lemma]) < 6:
                    pdf_occurrences[lemma].append(
                        {
                            "sentence": sentence,
                            "surface": original,
                            "set_id": set_id,
                            "score": 2.0,
                        }
                    )

    words = []
    for lemma, entry in dict_entries.items():
        if lemma not in article_freq and lemma not in pdf_freq:
            continue
        definition = clean_definition(entry["translation"])
        if not definition:
            reference_item = ref_map.get(lemma)
            if reference_item:
                definition = reference_item["definition"]
        if not entry["phonetic"] or not definition:
            continue
        if len(lemma) < 2:
            continue
        if not all(part.isalpha() or part in "-'" for part in lemma):
            continue
        ref_item = ref_map.get(lemma, {})
        cefr = ref_item.get("cefr", "")
        ref_rank = int(ref_item.get("rank", 99999))
        tags = entry["tags"]
        article_count = article_freq[lemma]
        pdf_count = pdf_freq[lemma]
        doc_freq = len(article_sets[lemma] | pdf_sets[lemma])
        if article_count == 0 and doc_freq < 2:
            continue

        cefr_weight = {
            "A1": -10,
            "A2": -6,
            "B1": 0,
            "B2": 5,
            "C1": 10,
            "C2": 12,
        }.get(cefr, 3)
        tag_bonus = 0
        if "cet6" in tags:
            tag_bonus += 6
        if "ky" in tags:
            tag_bonus += 4
        if any(tag in tags for tag in ("toefl", "ielts")):
            tag_bonus += 2
        if "gre" in tags:
            tag_bonus += 2
        common_penalty = 0
        if ref_rank <= 100:
            common_penalty = 10
        elif ref_rank <= 300:
            common_penalty = 6
        elif ref_rank <= 600:
            common_penalty = 3
        rare_hard_bonus = 0
        if doc_freq <= 2 and cefr in ("C1", "C2"):
            rare_hard_bonus += 12
        if doc_freq <= 2 and "gre" in tags:
            rare_hard_bonus += 8
        teacher_pick_count = teacher_pick_counts[lemma]
        teacher_bonus = min(teacher_pick_count, 4) * 18
        score = (
            doc_freq * 2.5
            + min(article_count, 20) * 0.7
            + min(pdf_count, 20) * 0.25
            + cefr_weight * 2.4
            + tag_bonus * 1.6
            + rare_hard_bonus
            + teacher_bonus
            - common_penalty
        )
        hard_tags = bool(
            set(tags) & {"cet6", "ky", "toefl", "ielts", "gre"}
        )
        is_basic = (
            cefr in ("A1", "A2")
            or (cefr == "B1" and ref_rank <= 1200)
            or "zk" in tags
            or ("gk" in tags and not cefr and "gre" not in tags)
        )
        core_candidate = (
            article_count > 0
            and lemma not in CORE_EXCLUDE
            and lemma not in STOPWORDS
            and cefr not in ("A1", "A2")
            and (
                teacher_pick_count > 0
                or (
                    not is_basic
                    and (
                        cefr in ("B2", "C1", "C2")
                        or (not cefr and hard_tags)
                        or (cefr == "" and doc_freq >= 3 and len(lemma) >= 8)
                    )
                )
            )
        )
        if teacher_pick_count > 0:
            core_candidate = True
        best_occurrence = None
        if occurrences[lemma]:
            best_occurrence = max(occurrences[lemma], key=lambda item: item["score"])
        context = None
        if best_occurrence:
            source_set = next(
                item for item in set_payloads if item["id"] == best_occurrence["set_id"]
            )
            context = {
                "text": best_occurrence["sentence"],
                "surface": best_occurrence["surface"],
                "set_id": best_occurrence["set_id"],
                "set_label": source_set["label"],
                "article_id": best_occurrence["article_id"],
                "article_title": best_occurrence["title"],
                "section": best_occurrence["section"],
                "part": best_occurrence["part"],
                "kind": "article",
            }
        elif pdf_occurrences[lemma]:
            best_pdf = max(pdf_occurrences[lemma], key=lambda item: item["score"])
            source_set = next(
                item for item in set_payloads if item["id"] == best_pdf["set_id"]
            )
            context = {
                "text": best_pdf["sentence"],
                "surface": best_pdf["surface"],
                "set_id": best_pdf["set_id"],
                "set_label": source_set["label"],
                "article_id": "",
                "article_title": "试卷题干 / 选项",
                "section": "试卷补充",
                "part": "",
                "kind": "paper",
            }

        words.append(
            {
                "id": lemma,
                "lemma": lemma,
                "phonetic": entry["phonetic"],
                "definition": definition,
                "pos": entry["pos"],
                "cefr": cefr,
                "tags": tags,
                "article_freq": article_count,
                "pdf_freq": pdf_count,
                "doc_freq": doc_freq,
                "reference_rank": ref_rank if ref_item else None,
                "score": round(score, 3),
                "core_candidate": core_candidate,
                "is_function": lemma in STOPWORDS,
                "teacher_pick_count": teacher_pick_count,
                "teacher_pick": teacher_pick_count > 0,
                "core": False,
                "daily_rank": None,
                "plan_day": None,
                "forms": sorted(forms_by_lemma[lemma])[:12],
                "context": context,
            }
        )

    words.sort(key=lambda item: (-item["score"], item["lemma"]))
    picked = [item for item in words if item["teacher_pick"]]
    picked_ids = {item["id"] for item in picked}
    remaining = [
        item
        for item in words
        if item["core_candidate"] and item["id"] not in picked_ids
    ]
    core_words = picked + remaining[: max(0, 700 - len(picked))]
    core_words.sort(key=lambda item: (-item["score"], item["lemma"]))
    core_ids = {item["id"] for item in core_words}
    for rank, item in enumerate(core_words, start=1):
        item["core"] = True
        item["daily_rank"] = rank
        item["plan_day"] = math.ceil(rank / 25)
    for item in words:
        if item["id"] in core_ids:
            continue
        item["daily_rank"] = None
        item["plan_day"] = None

    words.sort(key=lambda item: (not item["core"], item["daily_rank"] or 99999, -item["score"], item["lemma"]))
    ranked_words = []
    for rank, item in enumerate(words, start=1):
        item["rank"] = rank
        ranked_words.append(item)

    word_ids = {item["id"] for item in ranked_words}
    forms = {
        form: lemma
        for form, lemma in form_to_lemma.items()
        if lemma in word_ids
    }
    plan = build_plan(set_payloads)
    pdf_manifest_path = PDF_TEXT_DIR / "manifest.json"
    pdf_manifest = {}
    if pdf_manifest_path.exists():
        pdf_manifest = json.loads(pdf_manifest_path.read_text(encoding="utf-8"))

    data = {
        "meta": {
            "title": "CET-6 12套一卷语境词书",
            "exam_date": "2026-12-12",
            "exam_time": "15:00–17:25",
            "plan_start": "2026-11-13",
            "plan_last_study_day": "2026-12-11",
            "core_count": len(core_words),
            "word_count": len(ranked_words),
            "teacher_pick_words": sum(
                1 for item in ranked_words if item["teacher_pick"]
            ),
            "articles": manifest["article_count"],
            "corpus_words": manifest["word_count"],
            "sets": len(set_payloads),
            "daily_new_default": 25,
            "sources": [
                {
                    "label": "全国大学英语四、六级考试报名网：2026年下半年考试时间",
                    "url": "https://cet.neea.cn/html1/report/2609/1-1.htm",
                    "note": "官方公告：考试日期 2026-12-12，笔试 15:00–17:25。",
                },
                {
                    "label": "懒笔记：CET-6 真题文章原文",
                    "url": "https://english-exam.lazynote.cn/cet6/articles/",
                    "note": "12 次第1套的成篇原文；仅用于个人学习。",
                },
                {
                    "label": "CET通：六级真题 PDF",
                    "url": "https://www.cettong.cn/library/cet6",
                    "note": "补充试卷题干、选项与部分缺失的选词填空文本。",
                },
                {
                    "label": "ECDICT 英汉词典",
                    "url": "https://github.com/skywind3000/ECDICT",
                    "note": "音标与中文释义，MIT License。",
                },
            ],
            "pdf_sets_available": sum(
                1 for value in pdf_manifest.values() if value.get("status") == "ok"
            ),
            "pdf_gap": pdf_manifest.get("2026-06-1", {}),
            "method": [
                "先做真题，再精读；生词在原文语境中记，不背孤立字母表。",
                "每天先复习到期词，再学新词；新词第二天必须回看。",
                "标记熟悉/陌生/收藏会改变复习队列，不做一次性浏览。",
                "最后 5 天只做错题、陌生词和收藏词，不再扩大范围。",
            ],
        },
        "sets": [
            {
                "id": item["id"],
                "label": item["label"],
                "source_url": item["source_url"],
                "article_count": item["article_count"],
                "word_count": item["word_count"],
            }
            for item in set_payloads
        ],
        "articles": [
            {
                "id": article["id"],
                "set_id": article["set_id"],
                "title": article["title"],
                "section": article["section"],
                "part": article["part"],
                "genre": article["genre"],
                "cefr": article["cefr"],
                "source_note": article["source_note"],
                "url": article["url"],
                "key_words": article.get("key_words", []),
                "paragraphs": article["paragraphs"],
                "word_count": article["word_count"],
            }
            for payload in set_payloads
            for article in payload["articles"]
        ],
        "plan": plan,
        "words": ranked_words,
        "forms": forms,
    }

    OUTPUT_PATH.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {OUTPUT_PATH}: {len(ranked_words)} words, "
        f"{len(core_words)} core, {len(data['articles'])} articles, "
        f"{OUTPUT_PATH.stat().st_size / 1024 / 1024:.1f} MiB"
    )
    print(
        "Core preview:",
        ", ".join(item["lemma"] for item in core_words[:20]),
    )


if __name__ == "__main__":
    main()
