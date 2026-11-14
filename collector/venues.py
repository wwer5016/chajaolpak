"""공연장 이름 정규화.

올림픽공원 공연정보(KSCperf)에는 같은 공연장이 "체조경기장 / KSPO DOME / KSPO DOME(올림픽체조경기장)",
"핸드볼경기장 / SK핸드볼경기장"처럼 여러 이름으로 적혀 있다(reference/venue_names_raw.csv, 95종).
그 표기들을 reference/venues.csv 의 별칭으로 정리해 두고, 여기서 표준 공연장 id 로 바꾼다.
KOPIS 공연 목록의 공연시설명("올림픽공원 (KSPO DOME)")에도 같은 함수를 쓴다.
"""
from __future__ import annotations

import csv
import re

from common import REFERENCE

_DROP = re.compile(r"[\s()\[\]{}<>〈〉,.·ㆍ:;'\"~\-_/]+")


def _norm(s: str) -> str:
    return _DROP.sub("", s or "").lower()


def load_venues() -> list[dict]:
    with open(REFERENCE / "venues.csv", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["_aliases"] = sorted({_norm(a) for a in [r["name"]] + r["aliases"].split("|") if _norm(a)},
                               key=len, reverse=True)
    return rows


_VENUES: list[dict] | None = None


def normalize_venues(name: str) -> list[str]:
    """공연장 표기 하나에 들어 있는 표준 공연장 id 들(여러 곳을 함께 쓴 공연이면 여러 개)."""
    global _VENUES
    if _VENUES is None:
        _VENUES = load_venues()
    n = _norm(name)
    found: list[tuple[int, str]] = []
    for v in _VENUES:
        pos = [n.find(a) for a in v["_aliases"] if a in n]
        if pos:
            found.append((min(pos), v["id"]))
    # "88호수 수변무대"의 '88'·'수변무대'처럼 겹치는 별칭 정리: 수변무대가 있으면 88잔디마당 오인식 방지
    ids = [vid for _p, vid in sorted(found)]
    if "v_lake_stage" in ids and "v_lawn88" in ids and "잔디" not in n and "88마당" not in n:
        ids.remove("v_lawn88")
    return ids


def normalize_venue(name: str) -> str | None:
    ids = normalize_venues(name)
    return ids[0] if ids else None
