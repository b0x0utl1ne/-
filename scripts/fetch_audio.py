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


def detect_suffix(path: Path) -> str:
    """CET通 把 m4a 内容挂在 .mp3 名字下，按文件头纠正扩展名。"""
    head = path.read_bytes()[:12]
    if len(head) >= 8 and head[4:8] == b"ftyp":
        return ".m4a"
    if head[:3] == b"ID3" or head[:1] == b"\xff":
        return ".mp3"
    return ""


def existing_for(set_id: str) -> Path | None:
    for path in AUDIO.glob(f"{set_id}.*"):
        if path.suffix != ".download" and path.stat().st_size > 1024 * 1024:
            return path
    return None


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
        set_id = section["id"]
        url = section.get("audio_url") or ""
        local = existing_for(set_id)
        if local is None and url.startswith("http"):
            print(f"download {set_id} ...")
            tmp = AUDIO / f"{set_id}.download"
            try:
                download(url, tmp, curl)
            except Exception as exc:  # noqa: BLE001 - report and keep the old URL
                print(f"  FAILED: {exc}")
                tmp.unlink(missing_ok=True)
                continue
            local = tmp
        if local is None:
            print(f"missing {set_id}: no local file and no remote URL")
            continue

        suffix = detect_suffix(local) or local.suffix
        final = AUDIO / f"{set_id}{suffix}"
        if local != final:
            if final.exists():
                final.unlink()
            local.rename(final)
        print(f"keep {final.name} ({final.stat().st_size / 1024 / 1024:.1f} MB)")
        section["audio_url"] = f"audio/{final.name}"

    META.write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    total = sum(item.stat().st_size for item in AUDIO.glob("*") if item.is_file())
    print(f"done: {total / 1024 / 1024:.1f} MB in {AUDIO}")


if __name__ == "__main__":
    main()
