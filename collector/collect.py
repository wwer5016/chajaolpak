"""찾아올팍 데이터 수집기 — 공공 API → site/data/*.json

실행:
    python collector/collect.py                 # 실제 API 호출(.env 또는 환경변수의 인증키 사용)
    python collector/collect.py --offline DIR   # 저장해 둔 유실물 XML 폴더로 만들기(경찰청 수집은 건너뜀)
    python collector/collect.py --skip-police   # 유실물만

원칙:
  - 소스(유실물/경찰청)별로 따로 실패한다. 실패한 소스는 **직전 정상 JSON 을 그대로 둔다.**
  - 새로 받은 데이터가 이상하면(건수 급감 등) 덮어쓰지 않는다.
  - 인증키는 어디에도 쓰지 않는다(로그에서도 가림).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import math
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import lost_parser as lp  # noqa: E402
from categories import categorize, categorize_police, category_table  # noqa: E402
from common import (FetchError, REFERENCE, ROOT, SITE_DATA, get_key, log, now_kst,  # noqa: E402
                    read_json, write_json)
from places import PlaceMatcher  # noqa: E402
from privacy import mask_text  # noqa: E402

SCHEMA = 1
CENTERS = {
    "평화의 광장": {"id": "peace", "name": "평화의 광장 안내센터", "tel": "02-2180-3564", "tel_text": "02-2180-3564~5",
                 "place": "peace_plaza"},
    "만남의 광장": {"id": "meeting", "name": "만남의 광장 안내센터", "tel": "02-2180-3566", "tel_text": "02-2180-3566",
                 "place": "meeting_plaza"},
}


def _dist_m(a: dict, b: dict) -> float:
    dy = (a["lat"] - b["lat"]) * 111_320
    dx = (a["lng"] - b["lng"]) * 111_320 * math.cos(math.radians(37.52))
    return math.hypot(dx, dy)


# ------------------------------------------------------------------ 유실물

def build_lost(notices: list, matcher: PlaceMatcher) -> tuple[dict, dict]:
    """공고 목록 → (lost.json 내용, 통계)."""
    items: list[dict] = []
    transfers: list[dict] = []
    parsed, mstats = lp.merge_notices(notices)      # 사본·재게시·수정본 정리
    for p in parsed:
        if p.kind == "items":
            items.extend(p.items)
        elif p.kind == "transfer":
            transfers.append(p.transfer)

    seen_t = {}
    for t in transfers:
        seen_t.setdefault(t["cutoff"], t)
    transfers = sorted(seen_t.values(), key=lambda t: t["cutoff"], reverse=True)
    cutoff = transfers[0]["cutoff"] if transfers else ""

    unmatched: dict[str, int] = {}
    out: list[dict] = []
    dup: dict[str, int] = {}
    for it in items:
        raw_place = lp.clean(it["place_raw"])
        pid = matcher.match(raw_place)
        if pid is None and not matcher.is_unknown_word(raw_place):
            unmatched[raw_place] = unmatched.get(raw_place, 0) + 1
        status = it["status"]
        if status != "returned" and it["date"] and cutoff and it["date"] <= cutoff:
            status = "transferred"                 # 이관 공지의 기준일 이전 습득물
        base = "|".join([it["date"], lp.squash(it["name"]), lp.squash(raw_place), it["center"]])
        dup[base] = dup.get(base, 0) + 1
        iid = hashlib.sha1(f"{base}|{dup[base]}".encode("utf-8")).hexdigest()[:10]
        out.append({
            "id": iid,
            "date": it["date"],
            "name": mask_text(lp.clean(it["name"])),
            "qty": lp.clean(it["qty"]) or "1",
            "place_raw": mask_text(raw_place),
            "place": pid,
            "desc": mask_text(lp.clean(it["desc"])),
            "note": mask_text(lp.clean(it["note"])),
            "status": status,
            "center": CENTERS.get(it["center"], {}).get("id", ""),
            "posted": it["posted"],
            "cat": categorize(it["name"]),
        })
    out.sort(key=lambda r: (r["date"], r["id"]), reverse=True)
    data = {
        "schema": SCHEMA,
        "transfer_cutoff": cutoff,
        "transfers": [{"cutoff": t["cutoff"], "moved": t["moved"]} for t in transfers[:12]],
        "items": out,
    }
    stats = {
        "notices": len(parsed),
        "item_notices": mstats["items"],
        "raw_rows": mstats["raw"],
        "items": len(out),
        "located": sum(1 for r in out if r["place"]),
        "unmatched": dict(sorted(unmatched.items(), key=lambda kv: -kv[1])),
        "latest_item_date": out[0]["date"] if out else "",
    }
    return data, stats


def check_lost(data: dict, stats: dict, prev: dict | None) -> str | None:
    """덮어써도 되는지 검사. 문제가 있으면 이유를 돌려준다."""
    if stats["notices"] < 30:
        return f"공고가 {stats['notices']}건뿐입니다(묶음이 쓰이는 중이거나 응답 이상)"
    if stats["items"] < 20:
        return f"물건이 {stats['items']}행뿐입니다"
    if not data["transfer_cutoff"]:
        return "이관 공지를 하나도 찾지 못했습니다"
    # 직전 데이터와 비교. 다만 직전 데이터가 3일 넘게 묵었으면(= 같은 이유로 계속 거절 중이면)
    # 원본이 실제로 바뀐 것으로 보고 받아들인다 — 영원히 멈춰 있지 않게 하는 안전장치.
    if prev and prev.get("items") and not _stale(prev.get("updated", "")):
        if stats["items"] < 0.8 * len(prev["items"]):
            return f"물건 수가 직전({len(prev['items'])}행)보다 20% 넘게 줄었습니다({stats['items']}행)"
        if data["transfer_cutoff"] < prev.get("transfer_cutoff", ""):
            return "이관 기준일이 과거로 돌아갔습니다"
    return None


def _stale(updated: str, days: int = 3) -> bool:
    """직전 데이터가 days 일보다 오래됐는가."""
    try:
        from datetime import datetime
        return (now_kst() - datetime.fromisoformat(updated)).days >= days
    except Exception:
        return True


def load_offline(folder: Path) -> list:
    rows = []
    files = sorted(folder.glob("*.xml"))
    if not files:
        raise FetchError(f"{folder} 에 XML 이 없습니다")
    for f in files:
        notices, _total, _code = lp.parse_response(f.read_bytes())
        rows.extend(notices)
    log(f"  오프라인: {len(files)}개 파일, 원본 {len(rows)}행")
    return rows


# ------------------------------------------------------------------ 기준 데이터(장소·공연장)

def perf_counts() -> dict[str, int]:
    """올림픽공원 공연정보(KSCperf, 2024년까지 2,502건)의 공연장 표기별 건수 → 표준 공연장별 공연 건수.

    공연정보 API 에는 공연 날짜가 거의 없어(시간만 적힘) 날짜별 비교는 할 수 없고, 공연장별 누적 건수만 쓴다.
    """
    from venues import normalize_venues
    out: dict[str, int] = {}
    path = REFERENCE / "venue_names_raw.csv"
    if not path.exists():
        return out
    with open(path, encoding="utf-8-sig", newline="") as f:
        for i, row in enumerate(csv.reader(f)):
            if i == 0 or len(row) < 2:
                continue
            for vid in normalize_venues(row[0]):
                out[vid] = out.get(vid, 0) + int(row[1])
    return out

def build_base(matcher: PlaceMatcher) -> dict:
    places = [{"id": p["id"], "name": p["name"], "lat": p["lat"], "lng": p["lng"], "zone": p["zone"],
               "conf": p["confidence"]} for p in matcher.places]
    stations = []
    with open(REFERENCE / "stations.csv", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            stations.append({"id": r["id"], "name": r["name"], "lines": r["lines"],
                             "lat": float(r["lat"]), "lng": float(r["lng"])})
    perf = perf_counts()
    venues = []
    with open(REFERENCE / "venues.csv", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            center = matcher.by_id[r["place_id"]]
            radius = int(r["radius_m"])
            near = sorted(((_dist_m(center, p), p["id"]) for p in matcher.places), key=lambda x: x[0])
            near_ids = [pid for d, pid in near if d <= radius]
            st = sorted(((_dist_m(center, s), s["id"]) for s in stations), key=lambda x: x[0])
            venues.append({"id": r["id"], "name": r["name"], "place": r["place_id"], "lat": center["lat"],
                           "lng": center["lng"], "radius": radius, "near": near_ids,
                           "stations": [sid for _d, sid in st[:2]], "perf": perf.get(r["id"], 0)})
    return {
        "schema": SCHEMA,
        "categories": category_table(),
        "centers": [{"id": c["id"], "name": c["name"], "tel": c["tel"], "tel_text": c["tel_text"],
                     "place": c["place"]} for c in CENTERS.values()],
        "places": places,
        "stations": stations,
        "venues": venues,
    }


# ------------------------------------------------------------------ main

def main() -> int:
    ap = argparse.ArgumentParser(description="찾아올팍 데이터 수집")
    ap.add_argument("--offline", metavar="DIR", help="저장된 유실물 XML 폴더로 lost.json 만들기")
    ap.add_argument("--skip-police", action="store_true")
    ap.add_argument("--skip-lost", action="store_true")
    args = ap.parse_args()

    SITE_DATA.mkdir(parents=True, exist_ok=True)
    matcher = PlaceMatcher()
    meta = read_json(SITE_DATA / "meta.json", {}) or {}
    now = now_kst().isoformat(timespec="seconds")
    meta["schema"] = SCHEMA
    meta["checked_at"] = now
    results = {}

    # 기준 데이터 + 장소 사전 CSV(내려받기용)
    write_json(SITE_DATA / "base.json", build_base(matcher))
    shutil.copyfile(REFERENCE / "places.csv", SITE_DATA / "places.csv")

    # ── 유실물 ──
    if not args.skip_lost:
        log("유실물(KSClost) 수집 시작")
        prev = read_json(SITE_DATA / "lost.json")
        m = meta.setdefault("lost", {})
        try:
            if args.offline:
                notices, info = load_offline(Path(args.offline)), {"offline": True, "full_found": True}
            else:
                import lost_fetch
                # 직전 공고 수의 60%(최소 40종)를 넘는 묶음을 '전체 덤프'로 본다
                full_min = max(40, int(0.6 * m.get("notices", 0))) if m.get("notices") else lost_fetch.FULL_MIN_TITLES
                notices, info = lost_fetch.fetch_recent(m.get("total_count"), min(full_min, 250))
            data, stats = build_lost(notices, matcher)
            problem = check_lost(data, stats, prev)
            if not problem and not info.get("full_found") and not prev:
                problem = "전체 덤프 묶음을 찾지 못했습니다(첫 실행)"
            if problem:
                raise FetchError("검증 실패 — " + problem)
            data["updated"] = now
            data["batch"] = info.get("batch_regdate", "")
            write_json(SITE_DATA / "lost.json", data)
            m.update({"ok": True, "updated": now, "error": "", "notices": stats["notices"],
                      "items": stats["items"], "located": stats["located"],
                      "latest_item_date": stats["latest_item_date"],
                      "transfer_cutoff": data["transfer_cutoff"], "unmatched": stats["unmatched"]})
            for k in ("total_count", "pages_read", "batch_regdate"):
                if k in info:
                    m[k] = info[k]
            log(f"  저장: 원본 {stats['raw_rows']}행 → 공고 {stats['notices']}건 → 물건 {stats['items']}행"
                f"(지점 매칭 {stats['located']}행), 이관 기준일 {data['transfer_cutoff']}")
            if stats["unmatched"]:
                log(f"  사전에 없는 습득장소 {len(stats['unmatched'])}종: " +
                    ", ".join(f"{k}({v})" for k, v in list(stats["unmatched"].items())[:20]))
            results["lost"] = True
        except Exception as e:  # 실패하면 직전 정상 데이터를 유지
            msg = str(e) if isinstance(e, FetchError) else f"{type(e).__name__}: {e}"
            m.update({"ok": False, "error": msg, "failed_at": now})
            log(f"  [실패] 유실물: {msg} → 직전 데이터를 유지합니다")
            print(f"::warning::유실물 수집 실패: {msg}")
            results["lost"] = False

    # ── 경찰청(주변 역) ──
    if not args.skip_police and not args.offline:
        log("경찰청 습득물(주변 역) 수집 시작")
        prev = read_json(SITE_DATA / "police.json")
        m = meta.setdefault("police", {})
        try:
            import police
            data = police.collect()
            for it in data["items"]:
                it["cat"] = categorize_police(it["cls"], it["name"])
                it.pop("top", None)
            # 모든 역이 0건이면 응답 이상일 수 있다 → 직전 데이터 유지(3일 넘게 계속되면 받아들인다)
            if (not data["items"] and prev and len(prev.get("items", [])) >= 5
                    and not _stale(prev.get("updated", ""))):
                raise FetchError(f"모든 역이 0건입니다(직전 {len(prev['items'])}건)")
            out = {"schema": SCHEMA, "updated": now, "items": data["items"]}
            write_json(SITE_DATA / "police.json", out)
            m.update({"ok": True, "updated": now, "error": "", "items": len(data["items"])})
            log(f"  저장: 주변 역 습득물 {len(data['items'])}건")
            results["police"] = True
        except Exception as e:
            msg = str(e) if isinstance(e, FetchError) else f"{type(e).__name__}: {e}"
            m.update({"ok": False, "error": msg, "failed_at": now})
            log(f"  [실패] 경찰청: {msg} → 직전 데이터를 유지합니다")
            print(f"::warning::경찰청 수집 실패: {msg}")
            results["police"] = False

    # ── 공연 목록(KOPIS, 선택) ──
    if not args.offline and get_key("KOPIS_KEY"):
        log("KOPIS 공연 목록 수집 시작")
        m = meta.setdefault("kopis", {})
        try:
            import kopis
            shows = kopis.collect()
            write_json(SITE_DATA / "shows.json", {"schema": SCHEMA, "updated": now, "shows": shows})
            m.update({"ok": True, "updated": now, "error": "", "shows": len(shows)})
            log(f"  저장: 공연 {len(shows)}건")
        except Exception as e:
            msg = str(e) if isinstance(e, FetchError) else f"{type(e).__name__}: {e}"
            m.update({"ok": False, "error": msg, "failed_at": now})
            log(f"  [실패] KOPIS: {msg}")
            print(f"::warning::KOPIS 수집 실패: {msg}")

    if not (SITE_DATA / "police.json").exists():
        write_json(SITE_DATA / "police.json", {"schema": SCHEMA, "updated": "", "items": []})
    if not (SITE_DATA / "shows.json").exists():
        write_json(SITE_DATA / "shows.json", {"schema": SCHEMA, "updated": "", "shows": []})

    write_json(SITE_DATA / "meta.json", meta)
    log("끝: " + ", ".join(f"{k}={'성공' if v else '실패'}" for k, v in results.items()))
    if not (SITE_DATA / "lost.json").exists():
        log("lost.json 이 한 번도 만들어지지 않았습니다")
        return 1
    # 모든 소스가 실패하면 실패로 끝내 알림이 가게 한다(사이트는 직전 데이터 그대로)
    if results and not any(results.values()):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
