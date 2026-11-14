"""품명 → 품목 분류(지도 아이콘·필터용).

위에서부터 순서대로 검사하므로 더 구체적인 분류를 앞에 둔다.
"""
from __future__ import annotations

import re

# (id, 이름, 아이콘, 품명에 들어 있으면 해당하는 낱말)
CATEGORIES = [
    ("wallet", "지갑·카드", "👛", ["지갑", "머니클립", "카드케이스", "카드", "통장", "여권", "신분증", "면허증",
                                 "주민등록", "학생증", "증명서", "상품권", "현금", "수표"]),
    ("earphone", "이어폰", "🎧", ["이어폰", "에어팟", "버즈", "헤드셋", "헤드폰", "이어버드"]),
    ("watch", "시계·워치", "⌚", ["워치", "시계"]),
    ("key", "열쇠·차 키", "🔑", ["key", "키", "열쇠", "리모컨"]),
    ("phone", "휴대폰", "📱", ["휴대폰", "핸드폰", "스마트폰", "아이폰", "갤럭시", "폴더폰", "휴대전화"]),
    ("device", "전자기기", "📷", ["카메라", "노트북", "태블릿", "아이패드", "패드", "드론", "스피커", "mp3", "충전기",
                               "배터리", "선풍기", "보청기", "체성분", "의료기", "전자", "컴퓨터", "게임기", "마우스"]),
    ("bag", "가방", "🎒", ["가방", "파우치", "쇼핑백", "백팩", "핸드백", "캐리어", "에코백", "배낭", "방수팩",
                          "크로스백", "종이백"]),
    ("glasses", "안경·선글라스", "🕶️", ["안경", "선글라스", "썬글라스"]),
    ("clothes", "의류·잡화", "🧢", ["점퍼", "모자", "의류", "옷", "자켓", "재킷", "코트", "신발", "우산", "양산",
                                 "장갑", "목도리", "스카프", "머플러", "벨트", "조끼", "패딩", "티셔츠", "바지"]),
    ("jewelry", "귀금속", "💍", ["반지", "목걸이", "팔찌", "귀걸이", "귀금속", "브로치"]),
    ("kids", "유아·레저", "🧸", ["유모차", "킥보드", "인라인", "인형", "라켓", "캐치볼", "텐트", "자전거", "장난감",
                              "돗자리", "악기", "셀카봉"]),
]
ETC = ("etc", "기타", "📦")

_SQUASH = re.compile(r"\s+")


def categorize(name: str) -> str:
    s = _SQUASH.sub("", name or "").lower()
    for cid, _label, _icon, words in CATEGORIES:
        for w in words:
            if w in s:
                return cid
    return ETC[0]


# 경찰청 분류(prdtClNm 의 상위 분류) → 같은 품목 id
_POLICE_TOP = {
    "지갑": "wallet", "카드": "wallet", "증명서": "wallet", "현금": "wallet", "유가증권": "wallet", "서류": "wallet",
    "휴대폰": "phone",
    "전자기기": "device", "컴퓨터": "device", "카메라": "device", "가전제품": "device",
    "가방": "bag", "쇼핑백": "bag",
    "의류": "clothes", "신발": "clothes", "우산": "clothes",
    "귀금속": "jewelry",
    "스포츠용품": "kids", "악기": "kids", "유아용품": "kids", "자동차": "key",
}


def categorize_police(cls: str, name: str) -> str:
    """경찰청 분류명("지갑 > 여성용 지갑")과 품명으로 품목 id 를 정한다."""
    parts = [p.strip() for p in (cls or "").split(">")]
    sub = parts[1] if len(parts) > 1 else ""
    for probe in (sub, name):
        c = categorize(probe)
        if c in ("earphone", "watch", "glasses", "key"):
            return c
    top = parts[0] if parts else ""
    if top in _POLICE_TOP:
        return _POLICE_TOP[top]
    c = categorize(name)
    return c


def category_table() -> list[dict]:
    rows = [{"id": cid, "label": label, "icon": icon} for cid, label, icon, _ in CATEGORIES]
    rows.append({"id": ETC[0], "label": ETC[1], "icon": ETC[2]})
    return rows
