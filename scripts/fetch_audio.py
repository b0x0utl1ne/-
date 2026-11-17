#!/usr/bin/env python3
"""Download the listening audio into ./audio and point the metadata at local files."""

from __future__ import annotations

import json
import shutil
import ssl
import subprocess
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
META = ROOT / "data" / "listening_meta.json"
AUDIO = ROOT / "audio"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)
REFERER = "https://www.cettong.cn/library/cet6"


def find_curl() -> str:
    found = shutil.which("curl")
    if found:
        return found
    for candidate in (r"C:\Windows\System32\curl.exe", "/usr/bin/curl"):
        if Path(candidate).exists():
            return candidate
    return ""


def suffix_from(url: str) -> str:
    path = url.split("?", 1)[0]
    for ext in (".m4a", ".mp3", ".wav", ".ogg"):
        if path.lower().endswith(ext):
            return ext
    return ".mp3"


def download(url: str, target: Path, curl: str) -> None:
    target.unlink(missing_ok=True)
    if curl:
        # CET通 会拒绝 HTTP/1.1 请求，curl 默认走 HTTP/2，配合 UA/Referer 才稳定
        subprocess.run(
            [
                curl, "-L", "--fail", "--silent", "--show-error",
                "--retry", "3", "--retry-delay", "2", "--max-time", "300",
                "-A", UA, "-e", REFERER, "-o", str(target), url,
            ],
            check=True,
        )
        return
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER})
    with urllib.request.urlopen(request, timeout=300, context=context) as response:
        target.write_bytes(response.read())


def main() -> None:
    AUDIO.mkdir(parents=True, exist_ok=True)
    curl = find_curl()
    print(f"curl: {curl or 'not found, falling back to urllib'}")
    data = json.loads(META.read_text(encoding="utf-8"))

    for section in data.get("sets", []):
        url = section.get("audio_url") or ""
        if not url.startswith("http"):
            print(f"skip {section['id']}: already local ({url})")
            continue
        name = f"{section['id']}{suffix_from(url)}"
        target = AUDIO / name
        if target.exists() and target.stat().st_size > 1024 * 1024:
            print(f"keep {name} ({target.stat().st_size / 1024 / 1024:.1f} MB)")
        else:
            print(f"download {name} ...")
            try:
                download(url, target, curl)
                print(f"  saved {target.stat().st_size / 1024 / 1024:.1f} MB")
            except Exception as exc:  # noqa: BLE001 - report and keep the old URL
                print(f"  FAILED: {exc}")
                continue
        section["audio_url"] = f"audio/{name}"

    META.write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    total = sum(item.stat().st_size for item in AUDIO.glob("*"))
    print(f"done: {total / 1024 / 1024:.1f} MB in {AUDIO}")


if __name__ == "__main__":
    main()
