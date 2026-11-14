"""파서 검증: 저장해 둔 API 원본 응답(tests/fixtures)을 파싱해서 기준 CSV(458행)와 비교한다.

실행:  python tests/test_parser.py
네트워크·인증키가 필요 없다.
"""
from __future__ import annotations

import collections
import csv
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "collector"))

import lost_parser as lp  # noqa: E402

FIX = HERE / "fixtures"


def load_notices():
    seen = {}
    files = sorted((FIX / "lost_latest").glob("*.xml"))
    assert files, "tests/fixtures/lost_latest/*.xml 이 없습니다"
    raw = 0
    for f in files:
        notices, total, code = lp.parse_response(f.read_bytes())
        assert code in ("0000", "00"), f"{f.name}: resultCode={code}"
        raw += len(notices)
        for n in notices:
            seen.setdefault(n.key, n)
    return list(seen.values()), raw


def norm(s):
    return lp.squash(s)


def main() -> int:
    notices, raw = load_notices()
    items, transfers, others = [], [], []
    for n in notices:
        p = lp.parse_notice(n.title, n.description)
        if p.kind == "items":
            items.extend(p.items)
        elif p.kind == "transfer":
            transfers.append(p.transfer)
        else:
            others.append(n.title)
    print(f"원본 {raw}건 → 고유 공고 {len(notices)}건 / 물건 {len(items)}행 / 이관 공지 {len(transfers)}건 / 기타 {len(others)}건")

    with open(FIX / "lost_items_snapshot.csv", encoding="utf-8-sig", newline="") as f:
        snap = list(csv.DictReader(f))

    # 1) 물건 행 비교 (안내센터 제외).
    #    기준 CSV 의 '상동'(위와 같은 장소)은 파서가 윗행 장소로 풀어 주므로 그 행만 장소를 빼고 비교한다.
    def key_snap(r):
        place = norm(r["습득장소"])
        return (r["접수일자"], norm(r["품명"]), "*" if place == "상동" else place, norm(r["비고"]), norm(r["공고제목"]))

    def key_item(r):
        return (r["date"], norm(r["name"]), norm(r["place_raw"]), norm(r["note"]), norm(r["notice"]))

    a = collections.Counter(key_snap(r) for r in snap)
    b = collections.Counter(key_item(r) for r in items)
    for k in [k for k in a if k[2] == "*"]:
        cand = [e for e in (b - a) if (e[0], e[1], e[3], e[4]) == (k[0], k[1], k[3], k[4])]
        if cand:
            a[cand[0]] += a.pop(k)
    missing = a - b
    extra = b - a
    ok = True
    if missing:
        ok = False
        print(f"\n[실패] 기준에는 있는데 파서 결과에 없는 행 {sum(missing.values())}건:")
        for k in list(missing)[:15]:
            print("   ", k)
    if extra:
        ok = False
        print(f"\n[실패] 파서 결과에만 있는 행 {sum(extra.values())}건:")
        for k in list(extra)[:15]:
            print("   ", k)

    # 2) 안내센터. 기준 CSV 는 "( 만남의 광장 안내센터 )"처럼 괄호 안에 공백이 있는 옛 공고와
    #    섹션 제목이 없는 공고를 놓쳤다. 파서는 둘 다 처리하므로 '기준이 틀린 행'은 허용하되 개수를 출력한다.
    def ck_snap(r):
        return key_snap(r) + (r["안내센터"],)

    def ck_item(r):
        return key_item(r) + (r["center"],)

    ca = collections.Counter(ck_snap(r) for r in snap if norm(r["습득장소"]) != "상동")
    cb = collections.Counter(ck_item(r) for r in items)
    diff = sum((ca - cb).values())
    no_center = sum(1 for r in items if r["center"] not in lp.CENTERS)
    print(f"안내센터가 기준과 다른 행: {diff}건 (옛 공고 형식 보정) / 안내센터를 못 찾은 행: {no_center}건")
    if diff > 60 or no_center > 0:
        ok = False
        print("[실패] 안내센터 판별이 기준과 너무 다릅니다")
    recent_diff = [k for k in (ca - cb) if k[0] >= "2018-01-01"]
    if recent_diff:
        ok = False
        print("[실패] 2018년 이후 행의 안내센터가 기준과 다릅니다:", recent_diff[:5])

    # 상태 분류
    st_snap = collections.Counter({"": "keep", "반환완료": "returned", "연락완료": "contacted"}[r["상태"]] for r in snap)
    st_item = collections.Counter(r["status"] for r in items)
    print("상태(기준):", dict(st_snap))
    print("상태(파서):", dict(st_item))
    if st_snap != st_item:
        ok = False
        print("[실패] 상태 분류가 기준과 다릅니다")

    # 이관 공지
    cutoffs = sorted(t["cutoff"] for t in transfers)
    print("이관 기준일(최근 5건):", cutoffs[-5:])
    if not cutoffs or cutoffs[-1] != "2026-10-13":
        ok = False
        print("[실패] 최신 이관 기준일이 2026-10-13 이 아닙니다")

    # 내용 기준 병합: 사본·재게시로 생긴 중복 물건이 없어야 한다
    raw_rows = []
    for f in sorted((FIX / "lost_latest").glob("*.xml")):
        raw_rows.extend(lp.parse_response(f.read_bytes())[0])
    merged, mstats = lp.merge_notices(raw_rows)
    m_items = [it for p in merged if p.kind == "items" for it in p.items]
    print(f"병합: 원본 {mstats['raw']}행 → 공고 {len(merged)}건 → 물건 {len(m_items)}행 (해시 기준 {len(items)}행)")
    per_notice = collections.Counter()
    for p in merged:
        if p.kind == "items":
            per_notice[(norm(p.items[0]["notice"]), tuple(sorted(key_item(it) for it in p.items)))] += 1
    dup_notices = [k for k, c in per_notice.items() if c > 1]
    if dup_notices or not (380 <= len(m_items) <= len(items)):
        ok = False
        print("[실패] 병합 후에도 같은 공고가 중복되거나 물건 수가 이상합니다", dup_notices[:3])
    if set(key_item(it) for it in m_items) != set(key_item(it) for it in items):
        ok = False
        print("[실패] 병합하면서 서로 다른 물건이 사라졌습니다")

    # 날짜 파싱 단위 테스트
    cases = {"2026/ 11/ 9": "2026-11-09", "2026/11/06": "2026-11-06", "2019.8.17": "2019-08-17",
             "2026-01-02": "2026-01-02", "": None}
    for src, want in cases.items():
        got = lp.parse_date(src)
        if got != want:
            ok = False
            print(f"[실패] parse_date({src!r}) = {got!r}, 기대 {want!r}")
    if lp.parse_date("11/9", 2026) != "2026-11-09":
        ok = False
        print("[실패] 연도 없는 날짜")

    print("\n결과:", "통과" if ok else "실패")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
