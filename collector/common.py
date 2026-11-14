"""공통 유틸: 경로, 인증키 읽기, 재시도 HTTP, 로그.

인증키는 환경변수(GitHub Secrets) 또는 로컬 .env 에서만 읽고, 절대 출력하지 않는다.
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))

PKG_DIR = Path(__file__).resolve().parent
ROOT = PKG_DIR.parent                      # chajaolpak/
SITE_DATA = ROOT / "site" / "data"
REFERENCE = ROOT / "reference"
STATE_DIR = ROOT / "state"                 # 수집 이력(이관 공지 등) — 저장소에 커밋됨

USER_AGENT = "chajaolpak-collector/1.0 (+https://github.com/)"


def now_kst() -> datetime:
    return datetime.now(KST)


def log(msg: str) -> None:
    print(f"[{now_kst():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def _load_dotenv() -> dict[str, str]:
    """chajaolpak/.env 또는 상위 폴더의 .env 를 읽는다(값은 반환만, 출력 금지)."""
    vals: dict[str, str] = {}
    for cand in (ROOT / ".env", ROOT.parent / ".env"):
        if not cand.exists():
            continue
        for line in cand.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            vals.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        break
    return vals


_DOTENV: dict[str, str] | None = None


def get_key(name: str) -> str | None:
    global _DOTENV
    v = os.environ.get(name)
    if v:
        return v.strip()
    if _DOTENV is None:
        _DOTENV = _load_dotenv()
    return _DOTENV.get(name) or None


class FetchError(Exception):
    pass


def _redact(url: str) -> str:
    """로그용: 인증키 값(serviceKey, KOPIS 의 service 등)을 가린다."""
    parts = urllib.parse.urlsplit(url)
    q = [(k, "***" if k.lower() in ("servicekey", "service", "key", "apikey", "api_key") else v)
         for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(q)))


def http_get(base: str, params: dict, *, timeout: int = 90, retries: int = 5,
             backoff: float = 3.0) -> bytes:
    """GET + 지수 백오프 재시도(504/5xx/타임아웃). 실패 시 FetchError."""
    url = base + "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            return body
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code < 500 and e.code != 429:
                break
        except Exception as e:  # timeout, connection reset ...
            last = type(e).__name__
        if attempt < retries:
            wait = backoff * (2 ** (attempt - 1)) + random.uniform(0, 1.5)
            log(f"  재시도 {attempt}/{retries - 1} ({last}) {wait:.0f}초 후: {_redact(url)}")
            time.sleep(wait)
    raise FetchError(f"{last}: {_redact(url)}")


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
