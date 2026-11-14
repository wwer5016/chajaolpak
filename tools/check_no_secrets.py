"""저장소·빌드 결과물에 인증키가 섞여 있지 않은지 검사한다.

환경변수 또는 로컬 .env 의 키 값을 읽어, 프로젝트 안의 모든 파일(.env 제외)에서 그 값이 나오는지 찾는다.
키 값은 출력하지 않는다.   실행:  python tools/check_no_secrets.py
"""
from __future__ import annotations

import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "collector"))

from common import get_key  # noqa: E402

NAMES = ["KCISA_LOST_KEY", "KCISA_PERF_KEY", "KCISA_OPER_KEY", "DATA_GO_KR_KEY", "KOPIS_KEY"]
SKIP_DIRS = {".git", "__pycache__", "node_modules"}


def main() -> int:
    needles: list[tuple[str, bytes]] = []
    for name in NAMES:
        v = get_key(name)
        if v and len(v) >= 8:
            needles.append((name, v.encode()))
            enc = urllib.parse.quote(v, safe="")
            if enc != v:
                needles.append((name + "(URL 인코딩)", enc.encode()))
    if not needles:
        print("검사할 인증키가 없습니다(환경변수·.env 없음). 건너뜁니다.")
        return 0
    hits = []
    n = 0
    for p in ROOT.rglob("*"):
        if not p.is_file() or p.name == ".env" or SKIP_DIRS & set(p.relative_to(ROOT).parts):
            continue
        n += 1
        data = p.read_bytes()
        for name, needle in needles:
            if needle in data:
                hits.append((name, p.relative_to(ROOT)))
    if hits:
        for name, path in hits:
            print(f"[위험] {name} 값이 {path} 안에 들어 있습니다")
        return 1
    print(f"파일 {n}개 검사 — 인증키 없음")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
