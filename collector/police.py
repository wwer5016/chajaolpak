"""경찰청 포털기관 습득물(LOST112) — 공원 주변 역에 보관 중인 습득물.

'보관장소명 검색'(getPtLosfundInfoAccTpNmCstdyPlace)만 쓴다.
목록에는 습득 위치가 없으므로 보관장소(역)의 좌표에 표시한다.
"""
from __future__ import annotations

import csv
import sys
import xml.etree.ElementTree as ET
from datetime import timedelta

from common import FetchError, REFERENCE, get_key, http_get, log, now_kst
from privacy import mask_text

BASE = "https://apis.data.go.kr/1320000/LosPtfundInfoInqireService"
OP_PLACE = "/getPtLosfundInfoAccTpNmCstdyPlace"
ROWS = 100
MAX_PAGES = 5            # 역 하나당 최대 500건
MAX_AGE_DAYS = 180       # 이보다 오래된 습득물은 표시하지 않는다
ID_LIKE_TOPS = {"카드", "증명서", "지갑", "서류", "유가증권"}   # 품명에 이름이 적히기 쉬운 분류


def load_stations() -> list[dict]:
    with open(REFERENCE / "stations.csv", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["lat"] = float(r["lat"])
        r["lng"] = float(r["lng"])
        r["match"] = [m.strip() for m in r["match"].split("|") if m.strip()]
    return rows


def search_place(keyword: str, key: str) -> list[dict]:
    """보관장소명 부분 일치 검색 → 원본 item dict 목록."""
    out: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        body = http_get(BASE + OP_PLACE, {
            "serviceKey": key, "pageNo": page, "numOfRows": ROWS,
            "DEP_PLACE": keyword, "PRDT_NM": "",
        }, timeout=60, retries=4)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as e:
            raise FetchError(f"경찰청 응답 XML 해석 실패: {e}")
        code = (root.findtext("./header/resultCode") or root.findtext(".//returnReasonCode") or "").strip()
        if code not in ("00", "0000"):
            msg = (root.findtext("./header/resultMsg") or root.findtext(".//returnAuthMsg") or "").strip()
            raise FetchError(f"경찰청 API 오류 코드 {code} {msg}")
        items = root.findall("./body/items/item")
        for it in items:
            out.append({c.tag: (c.text or "").strip() for c in it})
        total = int((root.findtext("./body/totalCount") or "0").strip() or 0)
        if page * ROWS >= total or not items:
            break
    return out


def collect() -> dict:
    """주변 역 습득물을 모아 사이트용 구조로 돌려준다. 실패하면 FetchError."""
    key = get_key("DATA_GO_KR_KEY")
    if not key:
        raise FetchError("DATA_GO_KR_KEY 가 없습니다")
    stations = load_stations()
    seen: set[tuple[str, str]] = set()
    items: list[dict] = []
    # 보관장소 검색은 몇 년 전 기록까지 돌려준다. 법정 보관 기간(6개월)이 지난 것은 뺀다.
    oldest = (now_kst() - timedelta(days=MAX_AGE_DAYS)).strftime("%Y-%m-%d")
    for st in stations:
        raw = search_place(st["keyword"], key)
        kept = 0
        for r in raw:
            dep = r.get("depPlace", "")
            if not any(m in dep for m in st["match"]):
                continue                      # 예: '방이' 검색에 섞이는 다이소(방이시장점)
            if r.get("fdYmd", "") < oldest:
                continue
            uid = (r.get("atcId", ""), r.get("fdSn", ""))
            if not uid[0] or uid in seen:
                continue
            seen.add(uid)
            cls = r.get("prdtClNm", "")
            top = cls.split(">")[0].strip()
            img = r.get("fdFilePathImg", "")
            items.append({
                "id": f"{uid[0]}-{uid[1]}",
                "date": r.get("fdYmd", ""),
                "name": mask_text(r.get("fdPrdtNm", ""), names=True, id_like=top in ID_LIKE_TOPS),
                "cls": cls,
                "top": top,
                "color": r.get("clrNm", ""),
                "dep": dep,
                "station": st["id"],
                "img": bool(img) and "no_img" not in img,
            })
            kept += 1
        log(f"  경찰청 '{st['keyword']}' → {len(raw)}건 중 최근 {MAX_AGE_DAYS}일 {kept}건 사용")
    items.sort(key=lambda x: x["date"], reverse=True)
    return {
        "stations": [{"id": s["id"], "name": s["name"], "lines": s["lines"],
                      "lat": s["lat"], "lng": s["lng"]} for s in stations],
        "items": items,
    }


if __name__ == "__main__":
    # 점검용: python collector/police.py 몽촌토성 한성백제 …  → 보관장소명별 건수만 출력
    k = get_key("DATA_GO_KR_KEY")
    for kw in sys.argv[1:]:
        try:
            rows = search_place(kw, k)
        except FetchError as e:
            log(f"{kw}: 실패 {e}")
            continue
        cnt: dict[str, int] = {}
        for r in rows:
            cnt[r.get("depPlace", "")] = cnt.get(r.get("depPlace", ""), 0) + 1
        log(f"{kw}: {len(rows)}건 {cnt}")
