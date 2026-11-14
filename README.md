# 찾아올팍 — 올림픽공원 유실물 지도

올림픽공원에서 주운 물건을 **어디서 주웠는지** 기준으로 지도에 보여 주는 웹 서비스입니다.
한국체육산업개발㈜ 「2026년도 공공데이터 활용 경진대회」 출품작 프로토타입입니다.

**서비스 주소: https://wwer5016.github.io/chajaolpak/**

- 회원가입·서버·데이터베이스가 없습니다. 정적 파일(HTML/CSS/JS)과 JSON 데이터만으로 동작합니다.
- 공공 API 는 브라우저가 아니라 **수집 스크립트**가 부릅니다. 인증키는 저장소에 없고 GitHub Secrets 에만 있습니다.
- GitHub Actions 가 하루 3번 데이터를 새로 받아 GitHub Pages 에 배포합니다. 운영자가 할 일은 거의 없습니다.

## 기능

| 구분 | 내용 |
|---|---|
| 지도로 찾기 | 습득 장소를 표준 지점 50곳으로 묶어 핀·묶음으로 표시, 품목 아이콘·품목 필터, 기간 필터(7일/30일/전체 보관 중) |
| 상태 | 보관 중 / 연락 완료(배지) / 반환 완료(기본 숨김) / 경찰서 이관(기본 숨김, 이관 공지의 기준일로 판정) |
| 위치 불명 | "공원 내"처럼 지점이 없는 물건은 지도 대신 '위치 불명' 목록으로 |
| 물품 상세 | 품명·수량·습득일·습득 장소·확인 방법·보관 안내센터와 전화, 수령 방법, 1개월 뒤 이관 안내(이관 예정일 계산) |
| 주변 역 습득물 | 경찰청 습득물 정보(경찰민원24, 옛 LOST112)에서 공원 주변 5개 역에 보관 중인 습득물(최근 180일), 실명 가림 |
| 공연장·날짜로 찾기 | 공연장과 관람 날짜를 고르면 그날 이후 공연장 주변 지점·가까운 역의 습득물만 표시 |
| 자주 줍는 곳 | 최근 1년 지점별 습득 건수를 옅은 원으로 표시 |
| 현황 | 지점·품목·월·요일별 집계, 공연장 주변과 그 밖 비교(기관 담당자용) |
| 장소 사전 | `places.csv`(지점 이름·별칭·좌표·구역·신뢰도)를 사이트에서 내려받기 |

## 폴더 구조

```
collector/        데이터 수집·정제(Python 표준 라이브러리만 사용, 설치할 것 없음)
  collect.py        실행 진입점 → site/data/*.json
  lost_fetch.py     올림픽공원 유실물 API: 맨 끝에서 거꾸로 읽기, 504 재시도
  lost_parser.py    공고 HTML 표 파싱, 중복·수정본 병합, 이관 공지 해석
  police.py         경찰청 습득물(보관장소명 검색)
  privacy.py        이름·전화번호·카드번호 가리기
  places.py         습득 장소 → 표준 지점 매칭
  categories.py     품명 → 품목
  venues.py         공연장 이름 정규화 / kopis.py (선택) 최근 공연 목록
reference/        사람이 관리하는 기준 자료
  places.csv        장소 사전(지점 50곳)      ← tools/build_places.py 가 생성
  stations.csv      주변 역 5곳
  venues.csv        공연장 9곳과 별칭
  venue_names_raw.csv  올림픽공원 공연정보 API 의 공연장 표기 95종(별칭 정리의 근거)
site/             배포되는 정적 사이트 (index.html, app.js, style.css, lib/, data/)
tests/            파서·가리기 검증(저장해 둔 실제 API 응답 사용, 네트워크 불필요)
tools/            보조 도구(장소 사전 생성, 지도 라이브러리 받기, 인증키 유출 검사 등)
.github/workflows/update.yml   예약 수집 + 배포
```

## 사용 데이터

| 데이터 | 제공 | 쓰임 |
|---|---|---|
| 올림픽공원 유실물 정보 | 한국체육산업개발㈜ · 문화공공데이터광장(KSClost) | 핵심 데이터 |
| 올림픽공원 공연정보 | 한국체육산업개발㈜ · 문화공공데이터광장(KSCperf) | 공연장 표기 95종 → 표준 공연장 이름 사전(2024년 이후 갱신이 없어 공연 목록으로는 쓰지 않음) |
| 포털기관 습득물정보 | 경찰청 · 공공데이터포털 | 주변 역 보관 습득물 |
| 지도 | © OpenStreetMap 기여자(ODbL), Leaflet | 배경 지도, 일부 지점 좌표 |

## 내 컴퓨터에서 실행하기

Python 3.10 이상만 있으면 됩니다. 추가 설치는 없습니다.

```
# 1) 인증키 넣기: .env.example 을 .env 로 복사한 뒤 키를 붙여 넣는다
# 2) 데이터 수집 (1분쯤 걸림)
python collector/collect.py
# 3) 사이트 보기 → 브라우저에서 http://localhost:8765
python -m http.server 8765 --directory site
```

키 없이 화면만 보려면 저장소에 들어 있는 `site/data/` 를 그대로 쓰거나, 저장해 둔 응답으로 만들 수 있습니다.

```
python collector/collect.py --offline tests/fixtures/lost_latest
```

검증:

```
python tests/test_parser.py      # 파서: 실제 응답 483행 → 공고 293건 → 물건 427행
python tests/test_privacy.py     # 이름 가리기·장소 매칭·품목 분류
python tools/check_no_secrets.py # 인증키가 파일에 섞이지 않았는지
```

## 배포하기 (GitHub Pages)

처음 한 번만 하면 됩니다. 개발 도구가 없어도 웹 화면에서 할 수 있습니다.

1. **저장소 만들기** — github.com 에 로그인 → 오른쪽 위 `+` → `New repository` → 이름 `chajaolpak` → **Public** 선택 → `Create repository`.
2. **Pages 켜기** — 저장소의 `Settings` → 왼쪽 `Pages` → `Build and deployment` 의 `Source` 를 **GitHub Actions** 로 바꿉니다.
3. **인증키 등록** — `Settings` → `Secrets and variables` → `Actions` → `New repository secret`. 아래 두 개를 각각 만듭니다(이름은 정확히 같아야 합니다).
   - `KCISA_LOST_KEY` : 문화공공데이터광장의 올림픽공원 유실물 정보 인증키
   - `DATA_GO_KR_KEY` : 공공데이터포털의 경찰청 습득물 인증키(Decoding)
   - (선택) `KOPIS_KEY` : 있으면 '최근 공연' 고르기가 켜집니다
4. **파일 올리기** — 저장소 첫 화면의 `uploading an existing file` 을 누르고, 이 폴더 **안의 내용 전부**(`collector`, `reference`, `site`, `tests`, `tools`, `README.md` 등)를 끌어다 놓은 뒤 `Commit changes`.
   `.env` 파일은 올리지 마세요.
5. **배포 설정 파일 만들기** — 웹 업로드는 점(.)으로 시작하는 `.github` 폴더를 빼고 올립니다. 그래서 이 파일은 따로 만들어야 합니다.
   저장소 첫 화면 `Add file` → `Create new file` → 이름 칸에 `.github/workflows/update.yml` 입력 →
   이 폴더의 `.github/workflows/update.yml` 내용을 메모장으로 열어 전부 복사해 붙여 넣기 → `Commit changes`.
6. **확인** — `Actions` 탭에서 "데이터 갱신과 배포"가 초록색 체크로 끝나면 `https://<아이디>.github.io/chajaolpak/` 에서 열립니다.

## 데이터 갱신

- **자동:** 매일 한국 시간 10:10, 14:10, 19:10 무렵(GitHub 사정에 따라 몇 분~수십 분 늦을 수 있음).
- **수동:** `Actions` 탭 → `데이터 갱신과 배포` → `Run workflow`.
- **실패했을 때:** 소스(유실물/경찰청)별로 따로 처리합니다. 실패한 소스는 **직전 정상 데이터를 그대로 둡니다.**
  새 데이터가 이상하면(물건 수가 20% 넘게 줄어드는 등) 덮어쓰지 않습니다. 같은 상태가 3일 넘게 이어지면 원본이 실제로 바뀐 것으로 보고 받아들입니다.
  모든 소스가 실패하면 Actions 실행이 빨간색으로 표시되고 GitHub 가 메일을 보냅니다(사이트는 그대로 열립니다).
- 사이트의 `안내` 창에서 소스별 마지막 갱신 시각과 실패 여부를 볼 수 있습니다.

## 운영하면서 손볼 곳

- **새 습득 장소 표기가 나왔을 때** — 수집 로그와 사이트 `안내` 창의 "아직 사전에 없는 표기"에 나옵니다.
  `tools/build_places.py` 의 해당 지점 별칭에 추가하고 `python tools/build_places.py` 를 실행합니다(또는 `reference/places.csv` 의 `aliases` 칸을 직접 고칩니다).
- **안내센터 전화번호·운영 시간이 바뀌었을 때** — `collector/collect.py` 의 `CENTERS`, `site/app.js` 의 안내 문구.
- **역을 더하거나 뺄 때** — `reference/stations.csv`. `keyword` 는 경찰청 보관장소명 검색어이고 "방이역"처럼 '역'까지 넣어야 다른 시설이 섞이지 않습니다.
- **이름 가리기** — 물건 이름이 잘못 가려지면 `collector/privacy.py` 의 `_NOT_NAMES` 에 낱말을 추가합니다.

## 알아 둘 점(한계)

- 지도 핀은 안내센터가 적은 "○○ 부근"을 지점 대표 좌표로 옮긴 것입니다. `confidence` 가 `high` 인 지점은 OpenStreetMap 좌표, `medium` 은 공원 안내도 위치를 보정한 추정값(오차 약 50~100m), `low` 는 넓은 구역이거나 추정입니다.
- 유실물 API 는 같은 공고가 수집될 때마다 계속 쌓이는 구조입니다(5만 행 이상, 실제 공고 약 300건). 그래서 맨 끝에서 거꾸로 읽고, 같은 공고의 사본·재게시·수정본을 내용 기준으로 하나만 남깁니다.
- '경찰서 이관' 여부는 이관 공지의 기준일로 판정합니다. 공지가 늦게 올라오면 며칠 동안 '보관 중'으로 보일 수 있어, 상세 화면에서 보관 기한이 지난 물건은 전화 확인을 안내합니다.
- 경찰청 데이터에는 습득 위치가 없어 보관 장소(역) 위치에 표시합니다.
- 미사경정공원은 현재 데이터에 나오지 않아 화면에서 뺐습니다. 데이터에 나오면 `places.csv` 에 지점을 추가하면 됩니다.
- KOPIS 최근 공연(`collector/kopis.py`): 공연목록에는 공연시설이 "올림픽공원"까지만 나와서, 공연마다 공연상세를 한 번 더 불러 공연장(KSPO DOME, 올림픽홀 등)을 확인합니다.
  KOPIS 인증키는 **발급일로부터 1년** 유효하고(연장: kopis@gokams.or.kr), 사이트에 KOPIS 출처를 꼭 표시해야 합니다(표시해 두었음).
