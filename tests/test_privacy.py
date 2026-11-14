"""개인정보 가리기·장소 매칭·품목 분류 검증.   실행:  python tests/test_privacy.py"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "collector"))

from categories import categorize  # noqa: E402
from places import PlaceMatcher  # noqa: E402
from privacy import mask_text  # noqa: E402

# (입력, 기대값, 카드·증명서·지갑 분류 여부)  — 이름은 모두 지어낸 것
MASK = [
    ("홍길동 지갑", "홍○○ 지갑", True),
    ("홍길동 주민등록증", "홍○○ 주민등록증", True),
    ("신한카드(홍길동)", "신한카드(홍○○)", True),
    ("홍길동님 체크카드", "홍○○님 체크카드", True),
    ("명의자 김철수 통장", "명의자 김○○ 통장", True),
    ("학생증 이영희", "학생증 이○○", True),
    ("남궁민수 여권", "남○○○ 여권", True),
    ("박지 운전면허증", "박○ 운전면허증", True),
    ("홍길동", "홍○○", True),
    # 가리면 안 되는 것
    ("구찌지갑", "구찌지갑", True),
    ("벤츠 카드지갑", "벤츠 카드지갑", True),
    ("우리카드", "우리카드", True),
    ("토스뱅크 카드", "토스뱅크 카드", True),
    ("여성용 가방", "여성용 가방", False),
    ("여행용 허리가방, 핸드폰배터리, 학생증", "여행용 허리가방, 핸드폰배터리, 학생증", False),
    ("털장갑(오른쪽)", "털장갑(오른쪽)", False),
    ("라디오", "라디오", False),
    ("노란색 꽃다발(플로리아)", "노란색 꽃다발(플로리아)", False),
    ("검정색 카파 카드지갑", "검정색 카파 카드지갑", True),
    ("남성빈폴반지갑", "남성빈폴반지갑", True),
    ("소니 헤드셋", "소니 헤드셋", False),
    # 숫자
    ("연락처 010-1234-5678", "연락처 ●●●-●●●●-●●●●", False),
    ("카드 1234-5678-9012-3456", "카드 ●●●●-●●●●-●●●●-●●●●", True),
    ("주민번호 900101-1234567", "주민번호 ●●●●●●-●●●●●●●", True),
    ("현금 9,000원", "현금 9,000원", True),
]

PLACE = [
    ("나홀로나무 부근", "lone_tree"), ("나홀로 나무 근처", "lone_tree"), ("곰말다리부근", "gommal"),
    ("평화의 광장 내 SKL전시체험관 뒤 놀이터", "peace_plaza"), ("세븐일레븐 (평화의광장 내)", "peace_plaza"),
    ("펑화의 광장", "peace_plaza"), ("KSPO DOME과 수영장 사이", "kspo_dome"), ("KSPO돔 1-1 근처", "kspo_dome"),
    ("체조경기장 2-2문", "kspo_dome"), ("핸드볼 경기장 부근", "handball"), ("우리 금융 아트홀 계단", "woori_hall"),
    ("88 마당", "lawn88"), ("88호수 초소 부근", "lake88"), ("몽촌해자 수변무대 주변 벤치", "moat_stage"),
    ("몽촌토성 산책로 주변", "fortress"), ("남 4문 놀이터", "gate_s4"), ("동 1문 부근", "gate_e1"),
    ("한얼 다리 부근", "hanul_bridge"), ("제일제면소 뒤편 화장실", "meeting_plaza"), ("P2 구역", "parking_p2"),
    ("테니스 주차장", "tennis"), ("회관 근처 벤치", "kspo_hq"), ("지구촌공원 화장실부근", "global_park"),
    ("공원 내", None), ("공원내", None), ("", None),
]

CAT = [("카드지갑", "wallet"), ("차 key", "key"), ("스마트 워치", "watch"), ("키즈용 스마트 워치", "watch"),
       ("블루투스 이어폰", "earphone"), ("무선이어폰 케이스", "earphone"), ("휴대폰", "phone"), ("여행용가방", "bag"),
       ("선글라스", "glasses"), ("유아용 킥보드", "kids"), ("디지털 카메라", "device"), ("도장", "etc")]


def main() -> int:
    bad = 0
    for src, want, id_like in MASK:
        got = mask_text(src, names=True, id_like=id_like)
        if got != want:
            bad += 1
            print(f"[실패] 가리기: {src!r} → {got!r} (기대 {want!r})")
    pm = PlaceMatcher()
    for src, want in PLACE:
        got = pm.match(src)
        if got != want:
            bad += 1
            print(f"[실패] 장소: {src!r} → {got!r} (기대 {want!r})")
    for src, want in CAT:
        got = categorize(src)
        if got != want:
            bad += 1
            print(f"[실패] 품목: {src!r} → {got!r} (기대 {want!r})")
    print(f"가리기 {len(MASK)}건, 장소 {len(PLACE)}건, 품목 {len(CAT)}건 검사 — " + ("통과" if not bad else f"{bad}건 실패"))
    return 1 if bad else 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
