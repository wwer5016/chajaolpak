"""(선택) KOPIS 공연예술통합전산망 — 올림픽공원 공연장의 최근 공연 목록.

KOPIS_KEY 가 있을 때만 collect.py 가 이 모듈을 부른다. 키가 없으면 사이트의 '최근 공연' 줄은 숨겨진다.
올림픽공원 공연정보 API 가 2024년 이후 갱신되지 않아, 최근 공연은 KOPIS 로 보완한다.

확인한 사실(2026-11-15 실제 호출):
  - 공연목록(pblprfr)의 공연시설명(fcltynm)은 "올림픽공원"까지만 나온다(어느 공연장인지 없음).
  - 그래서 "올림픽공원" 공연만 골라 공연상세(pblprfr/{공연ID})를 한 번 더 불러 공연장 이름을 얻는다.
이용 조건: 서비스에 "출처: (재)예술경영지원센터 공연예술통합전산망(www.kopis.or.kr)"을 표시해야 한다.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import timedelta

from common import FetchError, get_key, http_get, log, now_kst
from venues import normalize_venue

BASE = "http://www.kopis.or.kr/openApi/restful/pblprfr"
SIGNGU = "11"          # 서울
SIGNGU_SUB = "1171"    # 송파구
ROWS = 100
LOOK_BACK_DAYS = 60
LOOK_AHEAD_DAYS = 7
WINDOW_DAYS = 30       # KOPIS 는 한 번에 조회할 수 있는 기간이 31일 이내
MAX_DETAIL = 80        # 한 번 수집에서 공연상세를 부르는 최대 횟수(호출량 제한 대비)


def _ymd(s: str) -> str:
    s = (s or "").strip().replace(".", "-")
    return s if len(s) == 10 else ""


def _dbs(body: bytes) -> list[dict]:
    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        raise FetchError(f"KOPIS 응답 XML 해석 실패: {e}")
    return [{c.tag: (c.text or "").strip() for c in db} for db in root.findall(".//db")]


def _fetch_window(key: str, start, end) -> list[dict]:
    out = []
    for page in range(1, 11):
        dbs = _dbs(http_get(BASE, {
            "service": key, "stdate": f"{start:%Y%m%d}", "eddate": f"{end:%Y%m%d}",
            "cpage": page, "rows": ROWS, "signgucode": SIGNGU, "signgucodesub": SIGNGU_SUB,
        }, timeout=60, retries=3))
        out.extend(dbs)
        if len(dbs) < ROWS:
            break
    return out


_DETAIL_ERR: list[str] = []


def _detail(key: str, sid: str) -> dict:
    """공연상세. 실패하면 빈 dict(그 공연만 건너뛴다). 첫 실패의 응답 앞부분은 점검용으로 남긴다."""
    import urllib.error
    import urllib.parse
    import urllib.request
    for base in (BASE, BASE.replace("http://", "https://")):
        url = f"{base}/{sid}?" + urllib.parse.urlencode({"service": key})
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "chajaolpak-collector/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                dbs = _dbs(r.read())
            return dbs[0] if dbs else {}
        except urllib.error.HTTPError as e:
            if not _DETAIL_ERR:
                body = e.read()[:300].decode("utf-8", "replace").replace(key, "***")
                _DETAIL_ERR.append(f"{base.split('//')[0]} HTTP {e.code}: {body}")
        except Exception as e:  # 타임아웃 등
            if not _DETAIL_ERR:
                _DETAIL_ERR.append(type(e).__name__)
    return {}


def _is_olympic_park(fac: str) -> bool:
    return "올림픽공원" in re.sub(r"\s+", "", fac or "")


def collect() -> list[dict]:
    key = get_key("KOPIS_KEY")
    if not key:
        raise FetchError("KOPIS_KEY 가 없습니다")
    today = now_kst().date()
    start = today - timedelta(days=LOOK_BACK_DAYS)
    stop = today + timedelta(days=LOOK_AHEAD_DAYS)
    rows: list[dict] = []
    cur = start
    while cur <= stop:
        end = min(cur + timedelta(days=WINDOW_DAYS), stop)
        rows.extend(_fetch_window(key, cur, end))
        cur = end + timedelta(days=1)

    seen: set[str] = set()
    shows: list[dict] = []
    unknown_halls: dict[str, int] = {}
    n_park = n_detail = 0
    for r in rows:
        sid = r.get("mt20id", "")
        fac = r.get("fcltynm", "")
        if not sid or sid in seen or not _is_olympic_park(fac):
            continue
        seen.add(sid)
        n_park += 1
        venue = normalize_venue(fac)                 # 목록에 공연장까지 적혀 오는 경우
        hall = fac
        if not venue and n_detail < MAX_DETAIL:
            n_detail += 1
            d = _detail(key, sid)
            hall = d.get("fcltynm", "") or fac      # 예: "올림픽공원 (KSPO DOME)"
            venue = normalize_venue(hall)
        if not venue:
            unknown_halls[hall] = unknown_halls.get(hall, 0) + 1
            continue
        d1, d2 = _ymd(r.get("prfpdfrom", "")), _ymd(r.get("prfpdto", ""))
        if not d1:
            continue
        shows.append({"id": sid, "name": r.get("prfnm", ""), "venue": venue, "from": d1, "to": d2 or d1,
                      "genre": r.get("genrenm", "")})
    shows.sort(key=lambda s: s["from"], reverse=True)
    log(f"  KOPIS: 송파구 공연 {len(rows)}건 → 올림픽공원 {n_park}건(상세 조회 {n_detail}건) → 공연장 확인 {len(shows)}건")
    if unknown_halls:
        log("  KOPIS 공연장을 정하지 못한 공연시설: " + ", ".join(f"{k}({v})" for k, v in unknown_halls.items()))
    if _DETAIL_ERR:
        log("  KOPIS 공연상세 오류 예: " + _DETAIL_ERR[0])
    if n_park and not shows:
        raise FetchError("올림픽공원 공연은 있는데 공연장을 하나도 정하지 못했습니다")
    return shows
