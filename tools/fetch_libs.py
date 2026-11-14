"""지도 라이브러리(Leaflet, Leaflet.markercluster)를 site/lib/ 에 내려받는다.

CDN 에 기대지 않도록 저장소에 함께 넣어 둔다(2028년까지 운영 대비). 버전을 올릴 때만 다시 실행하면 된다.
    python tools/fetch_libs.py

폴더 이름을 'vendor' 로 하지 않은 이유: 일부 도구가 vendor 폴더를 '외부 의존성'으로 보고 복사·배포에서 빼 버린다.
"""
from __future__ import annotations

import urllib.request
from pathlib import Path

LIB = Path(__file__).resolve().parent.parent / "site" / "lib"
FILES = {
    "leaflet.js": "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "leaflet.css": "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "leaflet.markercluster.js": "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
    "MarkerCluster.css": "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
    "LICENSE-leaflet.txt": "https://unpkg.com/leaflet@1.9.4/LICENSE",
    "LICENSE-markercluster.txt": "https://unpkg.com/leaflet.markercluster@1.5.3/MIT-LICENCE.txt",
}


def main() -> None:
    LIB.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        req = urllib.request.Request(url, headers={"User-Agent": "chajaolpak-build/1.0"})
        data = urllib.request.urlopen(req, timeout=60).read()
        (LIB / name).write_bytes(data)
        print(f"{name}: {len(data):,} bytes")


if __name__ == "__main__":
    main()
