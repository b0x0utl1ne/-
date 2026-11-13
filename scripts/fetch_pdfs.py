#!/usr/bin/env python3
"""Download CET-6 test PDFs and extract their text for vocabulary coverage.

The 2026-06 paper is not yet available at the CET通 source used here, so the
script records it as a coverage gap instead of failing the whole corpus. The
article corpus still covers that set in full.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import requests


PDF_SETS = {
    "2025-12-1": "2025_12",
    "2025-06-1": "2025_06",
    "2024-12-1": "2024_12",
    "2024-06-1": "2024_06",
    "2023-12-1": "2023_12",
    "2023-06-1": "2023_06",
    "2023-03-1": "2023_03",
    "2022-12-1": "2022_12",
    "2022-09-1": "2022_09",
    "2022-06-1": "2022_06",
    "2021-12-1": "2021_12",
}
PDF_BASE = "https://www.cettong.cn/library/cet6/{slug}_1/test.pdf"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
    )
}


def download(session: requests.Session, url: str, output: Path) -> None:
    if output.exists() and output.stat().st_size > 100_000:
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 4):
        try:
            with session.get(url, timeout=120, stream=True) as response:
                response.raise_for_status()
                temp_path = output.with_suffix(".part")
                with temp_path.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1 << 16):
                        if chunk:
                            handle.write(chunk)
                temp_path.replace(output)
                return
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(2 * attempt)


def extract_text(pdf_path: Path, txt_path: Path) -> str:
    txt_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), str(txt_path)],
        check=True,
    )
    text = txt_path.read_text(encoding="utf-8", errors="replace")
    text = text.replace("\f", "\n\n")
    text = "\n".join(line.rstrip() for line in text.splitlines())
    return text


def main() -> None:
    raw_dir = Path("data/raw/pdf")
    text_dir = Path("data/raw/pdf_text")
    metadata = {}
    session = requests.Session()
    session.headers.update(HEADERS)
    for set_id, slug in PDF_SETS.items():
        url = PDF_BASE.format(slug=slug)
        pdf_path = raw_dir / f"{set_id}.pdf"
        txt_path = text_dir / f"{set_id}.txt"
        try:
            download(session, url, pdf_path)
            text = extract_text(pdf_path, txt_path)
            metadata[set_id] = {
                "status": "ok",
                "url": url,
                "pdf_bytes": pdf_path.stat().st_size,
                "text_chars": len(text),
            }
            print(f"OK {set_id}: {pdf_path.stat().st_size} bytes, {len(text)} chars")
        except Exception as exc:  # noqa: BLE001 - report and continue
            metadata[set_id] = {
                "status": "missing",
                "url": url,
                "error": str(exc),
            }
            print(f"MISS {set_id}: {exc}")

    metadata["2026-06-1"] = {
        "status": "missing",
        "url": PDF_BASE.format(slug="2026_06"),
        "reason": "CET通尚未提供该套 PDF；文章语料仍完整覆盖该套",
    }
    (text_dir / "manifest.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"DONE: {sum(v.get('status') == 'ok' for v in metadata.values())} PDFs")


if __name__ == "__main__":
    main()
