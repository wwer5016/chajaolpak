"""공연정보 API 의 공연장 표기(reference/venue_names_raw.csv)가 표준 공연장으로 얼마나 묶이는지 확인한다.

    python tools/check_venues.py
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "collector"))

from venues import load_venues, normalize_venues  # noqa: E402


def main() -> int:
    names = {v["id"]: v["name"] for v in load_venues()}
    with open(ROOT / "reference" / "venue_names_raw.csv", encoding="utf-8-sig", newline="") as f:
        rows = [(r[0], int(r[1])) for i, r in enumerate(csv.reader(f)) if i and len(r) >= 2]
    total = sum(c for _n, c in rows)
    hit_rows = hit_cnt = 0
    per: dict[str, int] = {}
    miss = []
    for raw, cnt in rows:
        ids = normalize_venues(raw)
        if ids:
            hit_rows += 1
            hit_cnt += cnt
            for i in ids:
                per[i] = per.get(i, 0) + cnt
        else:
            miss.append((raw, cnt))
    print(f"공연장 표기 {len(rows)}종(공연 {total}건) 중 {hit_rows}종({hit_cnt}건, {hit_cnt / total:.0%})을 표준 공연장으로 묶음")
    for vid, c in sorted(per.items(), key=lambda kv: -kv[1]):
        print(f"  {names[vid]}: {c}건")
    print("묶이지 않은 표기:", ", ".join(f"{n}({c})" for n, c in miss))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
