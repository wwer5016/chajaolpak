"""개인정보 가리기.

경찰청 습득물 품명에는 "홍길동 지갑", "신한카드(홍길동)"처럼 실명이 들어 있다.
화면에 내보내기 전에 이름은 "홍○○"으로, 전화번호·카드번호·주민번호 형태 숫자는 ●로 가린다.

방침: 애매하면 가린다(물건 이름 일부가 가려지는 쪽이 실명이 노출되는 쪽보다 낫다).
"""
from __future__ import annotations

import re

# 자주 쓰이는 성씨(한 글자) + 두 글자 성씨
_SURNAME_CHARS = (
    "김이박최정강조윤장임한오서신권황안송류유전홍고문양손배백허남심노하곽성차주우구민진지엄채원천방공"
    "현함변염여추도소석선설마길연위표명기반라왕금옥육인맹제모탁국어은편용"
)
_DOUBLE_SURNAMES = ("남궁", "황보", "제갈", "선우", "독고", "사공", "서문", "동방")

# 이름처럼 보이지만 이름이 아닌 낱말(성씨 글자로 시작하는 2~4자). 필요하면 계속 추가한다.
_NOT_NAMES = set("""
남성용 여성용 유아용 아동용 학생용 휴대용 차량용 개인용 업무용 가정용 성인용 어린이 장애인 임산부 유공자
이마트 우체국 하나로 신세계 지하철 기프트 모바일 도서관 사무실 오피스 고시원 기숙사 도어락 주차장 유치원
어학원 한의원 편의점 백화점 문구점 이디야 배스킨 도요타 고야드 지방시 라이언 어피치 고양이 강아지 하츄핑
이어폰 노트북 지팡이 유모차 장난감 손가방 손수건 주머니 정기권 이용권 주차권 진단서 안경집 안경테 양우산
장우산 장지갑 반지갑 명함집 금반지 은반지 금팔찌 은팔찌 성경책 문제집 소설책 방수팩 마스크 마우스 모니터
지퍼백 주전자 도시락 유산균 홍삼정 공진단 신용 신한 국민 하나 우리 기업 현대 신협 전북 경남 제주 부산
구찌 구글 기아 지프 반스 은행 한약 안경 우산 양산 장갑 모자 반지 지갑 가방 여권 통장 도장 수첩 서류
현금 지폐 동전 신발 정장 조끼 한복 이불 인형 우비 우의 선물 홍삼 한우 고기 소주 양주 인삼 지갑류 가방류
신분증 주민증 여권류 주민등록 운전면허 주황 노랑 노란 하늘 연두 하양 하얀 남색 금색 은색 민트 연분홍
진분홍 연보라 진보라 진회색 연회색 연갈색 진갈색 국방색 금장 은장 유광 무광 검정 가죽 천 면 기타
명품 고급 신형 구형 소형 중형 대형 여성 남성 여자 남자 유아 아동 성인 노인 학생 선불 전자 전동 무선 유선
교통 문화 지역 주유 주차 고속 공항 공용 공동 현관 전용 기념 기부 선물용 상품권 회원권 회원 직원 사원
임직원 방문 방문증 방문자 출입 출입증 보안 인식 인식표 명찰 명패 명함 이름표 군번줄 하이패스 신용카드
체크카드 교통카드 복지카드 기후동행 국민행복 문화누리 서울사랑 지역화폐 온누리 나라사랑 아이행복 모바일
현대카드 삼성카드 롯데카드 신한카드 국민카드 하나카드 우리카드 농협카드 비씨카드 씨티카드 카카오 토스
라디오 오디오 마이크 오른쪽 오른손 한켤레 공기계 유심칩 여행용 등산용 운동용 사무용 주방용 의료용 포장용
보관용 방수용 방한용 일반용 군용 전용 겸용 공용 선풍기 손난로 손거울 손전등 주사기 진통제 한약재 고데기
기저귀 노리개 변압기 서류철 소화기 안전모 원피스 유니폼 유리병 윤활유 은수저 지우개 정수기 전자책 전기
여성지갑 남성지갑 여성가방 남성가방 여성의류 남성의류 여성화 남성화 유아복 아동복 여아 남아 노인용
""".split())

# 이름의 둘째·셋째 글자로는 거의 쓰이지 않는 글자 → 이런 글자가 있으면 물건 이름으로 본다
_NON_NAME_SYL = set("쪽품색갑폰북팩책통줄끈띠짝벌개켤류물약옷발증판틀캡컵칩핀링락찌뭉꾸껑뚜팡깡쇠끼꽃빵떡술밥쌀폼템킷셋튜텀")

# 이 낱말 앞(또는 뒤)에 오는 2~4자 한글 낱말은 이름일 가능성이 높다
_ID_WORDS = (
    "주민등록증", "주민증", "운전면허증", "면허증", "신분증", "학생증", "사원증", "청소년증", "여권", "통장",
    "명의", "자격증", "수험표", "출입증", "복지카드", "명찰", "이름표", "명패", "군번줄", "인식표", "처방전",
    "약봉투", "진료카드", "진찰권", "등록증", "증명서", "수첩", "택배", "우편물", "서류", "명함",
)
_OWN_WORDS = ("카드", "지갑", "가방", "휴대폰", "핸드폰", "폰", "도장", "다이어리", "파우치", "백팩", "이어폰")
_LABELS = ("이름", "성명", "성함", "명의자", "명의", "소유자", "주인", "분실자", "수취인", "예금주")

_HAN = "가-힣"
_TOKEN = re.compile(rf"(?<![{_HAN}])([{_HAN}]{{2,4}})(?![{_HAN}])")
_PHONE = re.compile(r"(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)")
_RRN = re.compile(r"(?<!\d)\d{6}\s?-\s?[1-8]\d{6}(?!\d)")
_CARD = re.compile(r"(?<!\d)(?:\d{4}[-\s]?){3}\d{3,4}(?!\d)")
_LONGNUM = re.compile(r"(?<!\d)\d{9,}(?!\d)")
_LATIN_NAME = re.compile(r"\b([A-Z][A-Z]+)((?:[ ,]+[A-Z][A-Z]+){1,3})\b")


def _mask_digits(m: re.Match) -> str:
    return re.sub(r"\d", "●", m.group(0))


def _is_name_like(tok: str) -> bool:
    if tok in _NOT_NAMES or tok in _LABELS or tok in _ID_WORDS or any(ch in _NON_NAME_SYL for ch in tok[1:]):
        return False
    if len(tok) == 4:
        return tok[:2] in _DOUBLE_SURNAMES
    return tok[0] in _SURNAME_CHARS


def _mask_name(tok: str) -> str:
    return tok[0] + "○" * (len(tok) - 1)


def mask_names(text: str, id_like: bool = False) -> str:
    """문맥으로 이름일 가능성이 높은 한글 낱말을 가린다.

    id_like=True: 카드·증명서·지갑처럼 이름이 적혀 있기 쉬운 분류(품명이 이름 석 자뿐인 경우도 가린다).
    """
    if not text:
        return text
    spans: list[tuple[int, int]] = []

    def add(s, e):
        spans.append((s, e))

    for m in _TOKEN.finditer(text):
        tok = m.group(1)
        s, e = m.span(1)
        before = text[max(0, s - 8):s]
        after = text[e:e + 14]
        after_strip = after.lstrip(" ,·/:-([")
        before_strip = before.rstrip(" ,·/:-([")

        # 호칭: 홍길동님, 홍길동 씨, 홍길동의 지갑
        hon = re.match(rf"^([{_HAN}]{{2,3}})(님|씨)$", tok)
        if hon and _is_name_like(hon.group(1)):
            add(s, s + len(hon.group(1)))
            continue
        pos = re.match(rf"^([{_HAN}]{{2,3}})의$", tok)
        if pos and len(tok) >= 3 and _is_name_like(pos.group(1)) and after_strip[:1] and pos.group(1) not in _NOT_NAMES:
            if any(w in after for w in _ID_WORDS + _OWN_WORDS):
                add(s, s + len(pos.group(1)))
                continue
        if not _is_name_like(tok):
            continue
        if re.match(r"^\s?(님|씨)(?![가-힣])", after):
            add(s, e)
            continue
        # 꼬리표: "이름: 홍길동", "명의자 홍길동"
        if any(before_strip.endswith(lb) for lb in _LABELS):
            add(s, e)
            continue
        # 괄호 안에 혼자: "(홍길동)", "[홍길동]" — 세 글자이거나, 이름이 적히기 쉬운 분류일 때
        if before[-1:] and before[-1:] in "([{<" and after[:1] and after[:1] in ")]}>" and (len(tok) >= 3 or id_like):
            add(s, e)
            continue
        strict_after = any(after_strip.startswith(w) for w in _ID_WORDS)
        strict_before = any(before_strip.endswith(w) for w in _ID_WORDS)
        if strict_after or strict_before:
            add(s, e)
            continue
        # 일반 소지품 낱말 앞: 세 글자(가장 흔한 이름 길이)일 때만
        if len(tok) == 3 or (len(tok) == 4 and tok[:2] in _DOUBLE_SURNAMES):
            near = text[e:e + 12]
            if any(w in near for w in _OWN_WORDS + _ID_WORDS):
                add(s, e)
                continue
            # 품명이 세 글자 이름뿐인 경우("홍길동") — 카드·증명서·지갑 분류에서만
            if id_like and s == 0 and not after.strip():
                add(s, e)
                continue
    if not spans:
        return text
    out = []
    last = 0
    for s, e in sorted(set(spans)):
        if s < last:
            continue
        out.append(text[last:s])
        out.append(_mask_name(text[s:e]))
        last = e
    out.append(text[last:])
    return "".join(out)


def _mask_latin(m: re.Match) -> str:
    words = re.split(r"([ ,]+)", m.group(0))
    return "".join(w if not w.strip(" ,") else w[0] + "*" * (len(w) - 1) for w in words)


def mask_text(text: str, names: bool = False, id_like: bool = False) -> str:
    """전화번호·주민번호·카드번호(및 긴 숫자열)를 가리고, names=True 이면 이름도 가린다."""
    if not text:
        return text
    t = _RRN.sub(_mask_digits, text)
    t = _CARD.sub(_mask_digits, t)
    t = _PHONE.sub(_mask_digits, t)
    t = _LONGNUM.sub(_mask_digits, t)
    if names:
        t = mask_names(t, id_like)
        # 여권·신분증에 적힌 영문 대문자 성명 (예: HONG GILDONG)
        if re.search(r"여권|PASSPORT|신분증|면허증|등록증", t, re.I):
            t = _LATIN_NAME.sub(_mask_latin, t)
    return t
