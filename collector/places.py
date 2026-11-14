"""습득장소 원문 → 표준 지점(places.csv) 매칭."""
from __future__ import annotations

import csv
import re
from pathlib import Path

from common import REFERENCE

# 지점을 특정할 수 없는 표기 → '공원 전체'(위치 불명)
_UNKNOWN = {"", "공원내", "올림픽공원", "올림픽공원내", "공원", "공원일대", "공원일원", "미상", "불명", "모름", "-"}

_DROP = re.compile(r"[\s()\[\]{}<>,.·ㆍ:;'\"~\-_/]+")


def normalize(s: str) -> str:
    """비교용: 공백·괄호·구두점 제거, 영문 소문자화."""
    return _DROP.sub("", (s or "").replace("\xa0", " ")).lower()


class PlaceMatcher:
    def __init__(self, path: Path | None = None):
        path = path or (REFERENCE / "places.csv")
        self.places: list[dict] = []
        self._aliases: list[tuple[str, str]] = []      # (정규화한 별칭, place id)
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                r["lat"] = float(r["lat"])
                r["lng"] = float(r["lng"])
                self.places.append(r)
                names = [r["name"]] + [a for a in r["aliases"].split("|") if a.strip()]
                for a in names:
                    na = normalize(a)
                    if na:
                        self._aliases.append((na, r["id"]))
        self.by_id = {p["id"]: p for p in self.places}

    def match(self, raw: str) -> str | None:
        """표준 지점 id. 위치 불명이거나 사전에 없으면 None."""
        n = normalize(raw)
        if n in _UNKNOWN:
            return None
        best = None        # (위치, -길이, id)  — 가장 앞에 나오고, 같은 자리면 가장 긴 별칭
        for alias, pid in self._aliases:
            i = n.find(alias)
            if i < 0:
                continue
            cand = (i, -len(alias), pid)
            if best is None or cand < best:
                best = cand
        return best[2] if best else None

    @staticmethod
    def is_unknown_word(raw: str) -> bool:
        return normalize(raw) in _UNKNOWN
