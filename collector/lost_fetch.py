"""올림픽공원 유실물 정보(KSClost) 수집 — 맨 끝(최신)부터 거꾸로 읽는다.

이 API 는 같은 공고가 수집될 때마다 계속 뒤에 쌓인다(totalCount 5만 건 이상, 실제 공고는 약 300건).
  - 페이지는 regDate 오름차순 → 최신 수집분은 맨 끝에 있다.
  - 한 번의 수집분(묶음)은 regDate 가 몇 초 안에 몰려 있다.
  - 묶음이 항상 '전체 덤프'는 아니다(2026-11-14 묶음은 592행, 11-13 묶음은 4행뿐이었다).
그래서 **마지막 페이지부터 거꾸로** 읽으면서 '전체 덤프로 보이는 묶음'(제목이 충분히 많은 묶음)을
하나 다 읽을 때까지 모은다. 그보다 최근의 작은 묶음도 함께 모은다. 중복·수정본 정리는 lost_parser.merge_notices 가 한다.

504 가 잦아서 numOfRows=20, 타임아웃 90초, 지수 백오프 재시도 5회.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

from common import FetchError, get_key, http_get, log
from lost_parser import Notice, parse_response

BASE = "https://api.kcisa.kr/openapi/service/rest/meta/KSClost"
ROWS = 20
MAX_PAGES = 100                  # 안전장치: 한 번에 거꾸로 읽는 최대 페이지 수(2,000행)
GAP = timedelta(minutes=10)      # 이보다 시간이 벌어지면 다른 묶음으로 본다
FULL_MIN_TITLES = 150            # 한 묶음의 서로 다른 제목이 이만큼이면 '전체 덤프'


def _dt(s: str) -> datetime | None:
    try:
        return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _fetch_page(key: str, page: int) -> tuple[list[Notice], int]:
    body = http_get(BASE, {"serviceKey": key, "numOfRows": ROWS, "pageNo": page},
                    timeout=90, retries=5, backoff=4.0)
    try:
        notices, total, code = parse_response(body)
    except Exception as e:
        raise FetchError(f"유실물 응답 XML 해석 실패(page {page}): {type(e).__name__}")
    if code not in ("0000", "00"):
        raise FetchError(f"유실물 API 오류 코드 {code} (page {page})")
    return notices, total


def fetch_recent(hint_total: int | None = None, full_min: int = FULL_MIN_TITLES) -> tuple[list[Notice], dict]:
    """가장 최근의 전체 덤프 묶음부터 맨 끝까지의 공고(수집 순서: 오래된 것 → 최신)와 수집 정보.

    실패하면 FetchError.
    """
    key = get_key("KCISA_LOST_KEY")
    if not key:
        raise FetchError("KCISA_LOST_KEY 가 없습니다")

    # 1) 마지막 페이지 찾기 (직전 totalCount 를 알면 바로 그 근처로 간다)
    page = max(1, math.ceil(hint_total / ROWS)) if hint_total else 1
    notices, total = _fetch_page(key, page)
    for _ in range(4):
        last = max(1, math.ceil(total / ROWS))
        if page == last and notices:
            break
        page = last
        notices, total = _fetch_page(key, page)
        if not notices and page > 1:          # 경계에 딱 걸린 경우: 한 페이지 앞으로
            page -= 1
            notices, total = _fetch_page(key, page)
            break
    if not notices:
        raise FetchError("마지막 페이지에 공고가 없습니다")
    last_page = page

    # 2) 거꾸로 읽기
    rows: list[Notice] = []                   # 최신 → 오래된 순
    batches: list[dict] = []
    cur = None                                # 지금 읽고 있는 묶음
    pages = 1
    full_found = False
    while True:
        for n in reversed(notices):
            t = _dt(n.reg_date)
            if t is None:
                continue
            if cur is not None and cur["oldest"] - t > GAP:
                if len(cur["titles"]) >= full_min:   # 전체 덤프 하나를 끝까지 읽었다
                    full_found = True
                    break
                cur = None
            if cur is None:
                cur = {"newest": t, "oldest": t, "titles": set(), "rows": 0}
                batches.append(cur)
            cur["oldest"] = t
            cur["titles"].add(n.title)
            cur["rows"] += 1
            rows.append(n)
        if full_found or page <= 1 or pages >= MAX_PAGES:
            break
        page -= 1
        notices, _ = _fetch_page(key, page)
        pages += 1
    if not full_found and cur is not None and len(cur["titles"]) >= full_min:
        full_found = True                     # 1쪽까지 다 읽은 경우
    rows.reverse()
    info = {
        "total_count": total,
        "last_page": last_page,
        "pages_read": pages,
        "raw_rows": len(rows),
        "batch_regdate": batches[0]["newest"].strftime("%Y-%m-%d %H:%M") if batches else "",
        "batches": [{"at": b["newest"].strftime("%Y-%m-%d %H:%M"), "rows": b["rows"], "titles": len(b["titles"])}
                    for b in batches],
        "full_found": full_found,
    }
    log(f"  유실물: totalCount={total}, 끝에서 {pages}쪽 읽음, 원본 {len(rows)}행, 묶음 " +
        ", ".join(f"{b['at']}({b['rows']}행·제목 {b['titles']}종)" for b in info["batches"]) +
        ("" if full_found else " — 전체 덤프 묶음을 찾지 못함"))
    return rows, info
