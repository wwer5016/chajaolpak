"""올림픽공원 유실물 공고(KSClost) 파서.

API 한 건(item)은 '공고' 한 건이고, 실제 물건 목록은 description 안의 HTML <table> 에 있다.
이 모듈은 네트워크를 쓰지 않는다(오프라인 테스트 가능).
"""
from __future__ import annotations

import hashlib
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from html.parser import HTMLParser

CENTERS = ("평화의 광장", "만남의 광장")

_WS = re.compile(r"\s+")


def clean(s: str) -> str:
    return _WS.sub(" ", (s or "").replace("\xa0", " ")).strip()


def squash(s: str) -> str:
    """공백을 모두 없앤 비교용 문자열."""
    return _WS.sub("", (s or "").replace("\xa0", ""))


# ---------------------------------------------------------------- XML 응답

@dataclass
class Notice:
    title: str
    reg_date: str          # "2026-11-14 08:29:16"
    description: str       # HTML
    key: str = ""          # title+description 해시

    def __post_init__(self):
        if not self.key:
            h = hashlib.sha1((self.title + "\n" + self.description).encode("utf-8"))
            self.key = h.hexdigest()


def parse_response(xml_bytes: bytes) -> tuple[list[Notice], int, str]:
    """API 응답 XML → (공고 목록, totalCount, resultCode)."""
    root = ET.fromstring(xml_bytes)
    code = (root.findtext("./header/resultCode") or "").strip()
    total = int((root.findtext("./body/totalCount") or "0").strip() or 0)
    notices = []
    for it in root.iterfind("./body/items/item"):
        notices.append(Notice(
            title=clean(it.findtext("title") or ""),
            reg_date=clean(it.findtext("regDate") or ""),
            description=it.findtext("description") or "",
        ))
    return notices, total, code


# ---------------------------------------------------------------- HTML 표

class _TableGrabber(HTMLParser):
    """description HTML 에서 (표 앞 텍스트, 표 행들, 표 뒤 텍스트)를 순서대로 뽑는다."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.events: list[tuple[str, object]] = []   # ("text", str) | ("table", rows)
        self._in_table = 0
        self._rows: list[list[tuple[str, bool]]] = []
        self._row: list[tuple[str, bool]] | None = None
        self._cell: list[str] | None = None
        self._cell_is_th = False
        self._skip = 0          # caption/script/style 안

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "caption"):
            self._skip += 1
            return
        if tag == "table":
            self._in_table += 1
            if self._in_table == 1:
                self._rows = []
            return
        if not self._in_table:
            return
        if tag == "tr":
            self._close_cell()
            self._close_row()
            self._row = []
        elif tag in ("td", "th"):
            self._close_cell()
            if self._row is None:
                self._row = []
            self._cell = []
            self._cell_is_th = tag == "th"
        elif tag in ("p", "br", "div", "li") and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "caption"):
            self._skip = max(0, self._skip - 1)
            return
        if tag == "table" and self._in_table:
            self._close_cell()
            self._close_row()
            self._in_table -= 1
            if self._in_table == 0:
                self.events.append(("table", self._rows))
                self._rows = []
            return
        if not self._in_table:
            return
        if tag in ("td", "th"):
            self._close_cell()
        elif tag == "tr":
            self._close_cell()
            self._close_row()

    def handle_data(self, data):
        if self._skip:
            return
        if self._in_table:
            if self._cell is not None:
                self._cell.append(data)
        else:
            t = clean(data)
            if t:
                self.events.append(("text", t))

    def _close_cell(self):
        if self._cell is not None and self._row is not None:
            self._row.append((clean("".join(self._cell)), self._cell_is_th))
        self._cell = None

    def _close_row(self):
        if self._row:
            self._rows.append(self._row)
        self._row = None


_COLS = {
    "date": ("접수일자", "접수일", "습득일자", "습득일", "일자", "날짜"),
    "name": ("품명", "물품명", "습득물"),
    "qty": ("수량",),
    "place": ("습득장소", "장소"),
    "desc": ("형상", "특징", "확인"),
    "note": ("비고",),
}
_DEFAULT_ORDER = ["date", "name", "qty", "place", "desc", "note"]


def _header_map(cells: list[str]) -> dict[str, int] | None:
    m: dict[str, int] = {}
    for i, c in enumerate(cells):
        s = squash(c)
        for key, words in _COLS.items():
            if key not in m and any(s.startswith(w) or w in s for w in words):
                m[key] = i
                break
    return m if ("name" in m and "date" in m) else None


_DATE_FULL = re.compile(r"(\d{4})\s*[./\-년]\s*(\d{1,2})\s*[./\-월]\s*(\d{1,2})")
_DATE_SHORT = re.compile(r"^(\d{1,2})\s*[./\-월]\s*(\d{1,2})\s*일?$")
_DATE_2Y = re.compile(r"^(\d{2})\s*[./\-]\s*(\d{1,2})\s*[./\-]\s*(\d{1,2})$")


def parse_date(s: str, default_year: int | None = None) -> str | None:
    """'2026/ 11/ 9', '2026.11.06', '11/9' → 'YYYY-MM-DD'. 해석 불가면 None."""
    s = clean(s)
    if not s:
        return None
    m = _DATE_FULL.search(s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = _DATE_2Y.match(s)
        if m:
            y, mo, d = 2000 + int(m.group(1)), int(m.group(2)), int(m.group(3))
        else:
            m = _DATE_SHORT.match(s)
            if not (m and default_year):
                return None
            y, mo, d = default_year, int(m.group(1)), int(m.group(2))
    if not (1 <= mo <= 12 and 1 <= d <= 31 and 2000 <= y <= 2100):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


_POSTED = re.compile(r"(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*게시")
_CENTER_HEAD = re.compile(r"\(?\s*(평화의\s*광장|만남의\s*광장)\s*안내\s*센터\s*\)?\s*습득물")
_CENTER_FOOT = re.compile(r"(평화의\s*광장|만남의\s*광장)\s*습득물은")
_TITLE_YEAR = re.compile(r"(\d{4})\s*년")
_SAME = {"상동", "〃", "″", '"', "''", "위와같음", "동일"}


def status_of(note: str) -> str:
    """비고 → keep(보관 중) | contacted(연락 완료) | returned(반환 완료)."""
    s = squash(note)
    if "반환" in s or "수령완료" in s or "인계완료" in s or "찾아감" in s:
        return "returned"
    if "연락완료" in s or "연락됨" in s or "통화완료" in s:
        return "contacted"
    return "keep"


def _center_name(raw: str) -> str:
    return "평화의 광장" if "평화" in raw else "만남의 광장"


@dataclass
class ParsedNotice:
    kind: str                           # items | transfer | other
    items: list[dict] = field(default_factory=list)
    transfer: dict | None = None


def parse_notice(title: str, description: str) -> ParsedNotice:
    g = _TableGrabber()
    try:
        g.feed(description)
        g.close()
    except Exception:
        pass
    events = g.events
    has_table = any(k == "table" for k, _ in events)
    if not has_table:
        tr = parse_transfer(title, " ".join(t for k, t in events if k == "text"))
        return ParsedNotice("transfer" if tr else "other", transfer=tr)

    ty = _TITLE_YEAR.search(title)
    default_year = int(ty.group(1)) if ty else None
    items: list[dict] = []
    center = ""
    posted = ""
    for idx, (kind, payload) in enumerate(events):
        if kind == "text":
            m = _CENTER_HEAD.search(payload)
            if m:
                center = _center_name(m.group(1))
                posted = ""
            m = _POSTED.search(payload)
            if m:
                posted = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
                if default_year is None:
                    default_year = int(m.group(1))
            continue
        rows = payload
        this_center = center
        if not this_center:
            # 섹션 제목이 없는 옛 공고: 표 바로 뒤 안내문("…습득물은 (…) 02-…")으로 보완
            for k2, t2 in events[idx + 1: idx + 6]:
                if k2 == "table":
                    break
                m = _CENTER_FOOT.search(t2)
                if m:
                    this_center = _center_name(m.group(1))
                    break
        colmap = None
        prev_date = None
        prev_place = ""
        for row in rows:
            cells = [c for c, _ in row]
            if colmap is None:
                hm = _header_map(cells)
                if hm is not None:
                    colmap = hm
                    continue
                if all(is_th for _, is_th in row):
                    continue
                colmap = {k: i for i, k in enumerate(_DEFAULT_ORDER)}

            def cell(key):
                i = colmap.get(key)
                return cells[i] if i is not None and i < len(cells) else ""

            name = cell("name")
            if not squash(name):
                continue
            d = parse_date(cell("date"), default_year) or prev_date
            prev_date = d
            place = cell("place")
            if squash(place) in _SAME and prev_place:
                place = prev_place
            prev_place = place
            note = cell("note")
            items.append({
                "date": d or "",
                "name": name,
                "qty": cell("qty"),
                "place_raw": place,
                "desc": cell("desc"),
                "note": note,
                "status": status_of(note),
                "center": this_center,
                "posted": posted,
                "notice": title,
            })
    return ParsedNotice("items" if items else "other", items=items)


# ---------------------------------------------------------------- 공고 병합(중복 제거)

def merge_notices(notices: list[Notice]) -> tuple[list[ParsedNotice], dict]:
    """여러 번 수집된 공고를 '내용 기준'으로 하나씩만 남긴다.

    API 에는 같은 공고가 한 묶음 안에 두 번씩 들어 있고(공백만 다른 사본 포함),
    게시판에 같은 제목·같은 내용으로 두 번 올라온 글도 있다. 원문 해시만으로는 걸러지지 않으므로
    파싱한 결과로 비교한다.
      - 제목이 같고 물건 행(날짜·품명·장소·안내센터)이 같거나 부분집합이면 → 가장 최근에 수집된 판만 남긴다
        (비고가 '반환 완료'로 바뀐 수정본이 옛 판을 대체한다).
      - 제목이 같아도 물건 행이 다르면 서로 다른 공고로 본다.
      - 이관 공지는 기준일이 같으면 하나만 남긴다.
    """
    from collections import Counter

    order = sorted(range(len(notices)), key=lambda i: (notices[i].reg_date, i), reverse=True)
    seen_raw: set[str] = set()
    groups: dict[str, list] = {}
    stats = {"raw": len(notices), "items": 0, "transfer": 0, "other": 0}
    for i in order:                       # 최근 수집분부터
        n = notices[i]
        if n.key in seen_raw:
            continue
        seen_raw.add(n.key)
        p = parse_notice(n.title, n.description)
        tkey = squash(n.title)
        kept = groups.setdefault(tkey, [])
        if p.kind == "items":
            ident = Counter((it["date"], squash(it["name"]), squash(it["place_raw"]), it["center"])
                            for it in p.items)
            if any(k[0] == "items" and not (ident - k[1]) for k in kept):
                continue                  # 이미 남긴(더 최근) 판에 모두 들어 있다
            kept.append(("items", ident, p))
        elif p.kind == "transfer":
            if any(k[0] == "transfer" and k[1] == p.transfer["cutoff"] for k in kept):
                continue
            kept.append(("transfer", p.transfer["cutoff"], p))
        else:
            if any(k[0] == "other" for k in kept):
                continue
            kept.append(("other", None, p))
    out: list[ParsedNotice] = []
    for kept in groups.values():
        for kind, _sig, p in kept:
            stats[kind] += 1
            out.append(p)
    stats["unique_raw"] = len(seen_raw)
    return out, stats


# ---------------------------------------------------------------- 이관 공지

_MD =r"(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일"
_CUTOFF = re.compile(_MD + r"\s*(?:까지|이전)")
_MOVED = re.compile(_MD + r"\s*(?:자로|부로)")


def parse_transfer(title: str, text: str) -> dict | None:
    """'2026년 9월 9일 ~10월 13일 까지 습득물은 … 10월 14일자로 송파경찰서로 이관' → 기준일/이관일."""
    body = clean(text)
    if "이관" not in (title + body):
        return None
    year = None
    for src in (body, title):
        m = _TITLE_YEAR.search(src)
        if m:
            year = int(m.group(1))
            break
    cutoff = None
    for src in (body, title):
        m = _CUTOFF.search(src)
        if m:
            y = int(m.group(1)) if m.group(1) else year
            if y:
                cutoff = f"{y:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
                year = y
                break
    if not cutoff:
        return None
    moved = None
    m = _MOVED.search(body)
    if m:
        y = int(m.group(1)) if m.group(1) else year
        mo, d = int(m.group(2)), int(m.group(3))
        # 기준일이 12월이고 이관일이 1~2월이면 해가 넘어간 것
        if not m.group(1) and mo < int(cutoff[5:7]) - 6:
            y += 1
        moved = f"{y:04d}-{mo:02d}-{d:02d}"
    return {"cutoff": cutoff, "moved": moved, "title": title}
