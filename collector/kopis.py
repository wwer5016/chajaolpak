"""(선택) KOPIS 공연예술통합전산망 — 올림픽공원 공연장의 최근 공연 목록.

KOPIS_KEY 가 있을 때만 collect.py 가 이 모듈을 부른다. 키가 없으면 사이트의 '최근 공연' 줄은 숨겨진다.
올림픽공원 공연정보 API 가 2024년 이후 갱신되지 않아, 최근 공연은 KOPIS 로 보완한다.

주의: 2026-11 현재 KOPIS 키가 없어 실제 호출로 검증하지 못했다. 응답 형식이 다르면 FetchError 로 끝나고
사이트의 다른 기능에는 영향이 없다.
"""
from __future__ import annotations

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


def _ymd(s: str) -> str:
    s = (s or "").strip().replace(".", "-")
    return s if len(s) == 10 else ""


def _fetch_window(key: str, start, end) -> list[dict]:
    out = []
    for page in range(1, 11):
        body = http_get(BASE, {
            "service": key, "stdate": f"{start:%Y%m%d}", "eddate": f"{end:%Y%m%d}",
            "cpage": page, "rows": ROWS, "signgucode": SIGNGU, "signgucodesub": SIGNGU_SUB,
        }, timeout=60, retries=3)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as e:
            raise FetchError(f"KOPIS 응답 XML 해석 실패: {e}")
        dbs = root.findall(".//db")
        for db in dbs:
            out.append({c.tag: (c.text or "").strip() for c in db})
        if len(dbs) < ROWS:
            break
    return out


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
    seen = set()
    shows = []
    for r in rows:
        sid = r.get("mt20id", "")
        fac = r.get("fcltynm", "")
        if not sid or sid in seen or "올림픽공원" not in fac.replace(" ", "") and normalize_venue(fac) is None:
            continue
        venue = normalize_venue(fac)
        if not venue:
            continue
        seen.add(sid)
        d1, d2 = _ymd(r.get("prfpdfrom", "")), _ymd(r.get("prfpdto", ""))
        if not d1:
            continue
        shows.append({"id": sid, "name": r.get("prfnm", ""), "venue": venue, "from": d1, "to": d2 or d1,
                      "genre": r.get("genrenm", "")})
    shows.sort(key=lambda s: s["from"], reverse=True)
    log(f"  KOPIS: 송파구 공연 {len(rows)}건 중 올림픽공원 공연장 {len(shows)}건")
    # 점검용: 공연시설·지역 이름 분포(공개 정보, 키 없음)
    fac_cnt: dict[str, int] = {}
    for r in rows:
        k = f"{r.get('area', '')} | {r.get('fcltynm', '')}"
        fac_cnt[k] = fac_cnt.get(k, 0) + 1
    log("  KOPIS 공연시설: " + ", ".join(f"{k}({v})" for k, v in sorted(fac_cnt.items(), key=lambda kv: -kv[1])[:25]))
    if rows:
        log("  KOPIS 첫 항목 필드: " + ", ".join(sorted(rows[0].keys())))
    return shows
