/* 찾아올팍 — 올림픽공원 유실물 지도 (정적 사이트, 서버·회원 없음)
 * 데이터는 site/data/*.json 만 읽는다. 공공 API 는 브라우저에서 직접 부르지 않는다. */
(() => {
  'use strict';

  const REPO_URL = 'https://github.com/wwer5016/chajaolpak';   // 소스 저장소 주소(안내 창에 링크로 나온다)
  const PARK_BOUNDS = [[37.5122, 127.1108], [37.5268, 127.1322]];
  const STATUS = { keep: '보관 중', contacted: '연락 완료', transferred: '경찰서 이관', returned: '반환 완료' };
  // 공원 안내도의 구역 이름(올림픽존 등)은 처음 온 사람에게 낯설어, 위치를 알 수 있는 말을 함께 쓴다
  const ZONE_LABEL = {
    '올림픽존': '평화의 광장 쪽(서쪽)', '문화역사존': '미술관·박물관 쪽(남쪽)', '익사이팅존': '경기장·공연장 쪽(동쪽)',
    '자연생태존': '88호수·나홀로나무 쪽(북쪽)', '출입구': '출입구', '주차장': '주차장',
  };
  const zoneLabel = z => (z && ZONE_LABEL[z]) || z || null;
  // 경찰청 유실물 포털(LOST112)은 2026년부터 '경찰민원24'로 통합됐다. 습득물 검색 화면 주소.
  const POLICE_SEARCH_URL = 'https://minwon24.police.go.kr/cvlcpt/cvlcptAply.do?cvlcptId=MW-201';
  const DAY = 86400000;
  const WD = ['일', '월', '화', '수', '목', '금', '토'];

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    mode: 'map', period: 'all', cats: new Set(), showReturned: false, showTransferred: false, showStations: true,
    showHot: true, tab: 'located', venue: null, venueDate: '', station: null, statsRange: 'all',
  };
  const HALF = 0.44;     // 목록 시트 '반' 높이 (style.css 의 .app[data-sheet="half"] .sheet 와 같아야 한다)
  const D = { base: null, lost: { items: [] }, police: { items: [] }, meta: {}, shows: { shows: [] } };
  const IDX = { place: {}, cat: {}, center: {}, station: {}, venue: {} };
  let map, cluster, stationLayer, overlayLayer, labelLayer, hotLayer;
  let TODAY = '';

  /* ───────── 날짜 ───────── */
  const todayKST = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
  const ts = d => Date.parse(d + 'T00:00:00Z');
  const dayDiff = (a, b) => Math.round((ts(a) - ts(b)) / DAY);
  const addDays = (d, n) => new Date(ts(d) + n * DAY).toISOString().slice(0, 10);
  function fmtDate(d, withYear) {
    if (!d) return '날짜 미상';
    const [y, m, dd] = d.split('-').map(Number);
    const wd = WD[new Date(ts(d)).getUTCDay()];
    const yr = (withYear || String(y) !== TODAY.slice(0, 4)) ? `${y}년 ` : '';
    return `${yr}${m}월 ${dd}일(${wd})`;
  }
  function ago(d) {
    if (!d) return '';
    const n = dayDiff(TODAY, d);
    if (n <= 0) return '오늘';
    if (n === 1) return '어제';
    if (n < 31) return `${n}일 전`;
    if (n < 365) return `${Math.floor(n / 30)}개월 전`;
    return `${Math.floor(n / 365)}년 전`;
  }
  const fmtStamp = s => s ? s.slice(5, 16).replace('-', '.').replace('T', ' ') : '-';

  /* ───────── 데이터 ───────── */
  async function load() {
    const v = Math.floor(Date.now() / 600000);      // 10분 단위 캐시 무효화
    const get = f => fetch(`data/${f}?v=${v}`).then(r => { if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); });
    const [base, lost, police, meta, shows] = await Promise.all([
      get('base.json'), get('lost.json'),
      get('police.json').catch(() => ({ items: [] })),
      get('meta.json').catch(() => ({})),
      get('shows.json').catch(() => ({ shows: [] })),
    ]);
    Object.assign(D, { base, lost, police, meta, shows });
    base.places.forEach(p => IDX.place[p.id] = p);
    base.categories.forEach(c => IDX.cat[c.id] = c);
    base.centers.forEach(c => IDX.center[c.id] = c);
    base.stations.forEach(s => IDX.station[s.id] = s);
    base.venues.forEach(vn => IDX.venue[vn.id] = vn);
  }

  /* ───────── 걸러내기 ───────── */
  const catOk = it => !state.cats.size || state.cats.has(it.cat);

  function lostPool(ignoreCat) {
    return D.lost.items.filter(it => {
      if (!ignoreCat && !catOk(it)) return false;
      if (!it.date) return false;
      const age = dayDiff(TODAY, it.date);
      if (state.mode === 'venue') {
        if (!state.venue || !state.venueDate) return false;
        return it.date >= state.venueDate && it.status !== 'returned';
      }
      if (it.status === 'returned' && !state.showReturned) return false;
      if (it.status === 'transferred' && !state.showTransferred) return false;
      if (state.period !== 'all') return age <= +state.period;
      // '전체': 보관 중·연락 완료는 기간 제한 없이, 이관·반환된 물건(켰을 때)은 최근 1년 것만
      return (it.status === 'keep' || it.status === 'contacted') || age <= 365;
    });
  }
  function policePool() {
    return D.police.items.filter(it => {
      if (!catOk(it)) return false;
      if (state.mode === 'venue') {
        if (!state.venue || !state.venueDate) return false;
        return it.date >= state.venueDate && IDX.venue[state.venue].stations.includes(it.station);
      }
      if (!state.showStations) return false;
      if (state.period !== 'all' && dayDiff(TODAY, it.date) > +state.period) return false;
      return true;
    });
  }
  function current() {
    const pool = lostPool();
    const near = state.mode === 'venue' && state.venue ? new Set(IDX.venue[state.venue].near) : null;
    const located = pool.filter(it => it.place && (!near || near.has(it.place)));
    const unknown = pool.filter(it => !it.place);
    return { located, unknown, police: policePool() };
  }

  /* ───────── 지도 ───────── */
  function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 13, maxZoom: 19, zoomSnap: 0.25 });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 기여자',
    }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    cluster = L.markerClusterGroup({
      maxClusterRadius: 46, showCoverageOnHover: false, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 18,
      iconCreateFunction: c => {
        const kids = c.getAllChildMarkers();
        const muted = kids.every(m => m.options.st === 'transferred' || m.options.st === 'returned');
        return L.divIcon({ className: 'cl' + (muted ? ' muted' : ''), html: `<i>${kids.length}</i>`, iconSize: [40, 40], iconAnchor: [20, 20] });
      },
    }).addTo(map);
    map.createPane('hot').style.zIndex = 350;        // 타일 위, 핀 아래
    hotLayer = L.layerGroup().addTo(map);
    overlayLayer = L.layerGroup().addTo(map);
    labelLayer = L.layerGroup().addTo(map);
    stationLayer = L.layerGroup().addTo(map);
    const onZoom = () => {
      const z = map.getZoom(), el = $('#map');
      el.classList.toggle('z-far', z < 15);
      el.classList.toggle('z-mid', z < 16);
    };
    map.on('zoomend', onZoom);
    fitPark(false);
    onZoom();
  }
  const isWide = () => window.matchMedia('(min-width: 900px)').matches;
  function sheetPad() {
    if (isWide()) return 0;
    const st = $('#app').dataset.sheet;
    const h = $('.stage').clientHeight;
    return st === 'peek' ? 112 : Math.round(h * HALF);
  }
  function fitTo(bounds, animate = true) {
    map.fitBounds(bounds, { paddingTopLeft: [24, 24], paddingBottomRight: [24, sheetPad() + 16], animate });
  }
  const fitPark = animate => fitTo(PARK_BOUNDS, animate);

  // 같은 지점의 물건이 겹치지 않게 해바라기 모양으로 조금씩 벌린다(약 9m 간격). '부근'이라는 뜻이기도 하다.
  function spread(lat, lng, i) {
    if (!i) return [lat, lng];
    const r = 9 * Math.sqrt(i), a = i * 2.39996;
    return [lat + (r * Math.cos(a)) / 111320, lng + (r * Math.sin(a)) / (111320 * Math.cos(lat * Math.PI / 180))];
  }
  function pinIcon(it, sel) {
    const c = IDX.cat[it.cat] || { icon: '📦' };
    return L.divIcon({
      className: `pin ${it.status}${sel ? ' sel' : ''}`, html: `<i><span>${c.icon}</span></i>`,
      iconSize: [34, 34], iconAnchor: [5, 39],
    });
  }
  function renderMap(cur) {
    cluster.clearLayers(); stationLayer.clearLayers(); overlayLayer.clearLayers(); labelLayer.clearLayers(); hotLayer.clearLayers();

    // 자주 줍는 곳: 최근 1년 동안 지점별 습득 건수(상태와 무관)를 옅은 원으로 깔아 준다
    if (state.mode === 'map' && state.showHot) {
      const since = addDays(TODAY, -365), cnt = {};
      D.lost.items.forEach(it => { if (it.place && it.date >= since && catOk(it)) cnt[it.place] = (cnt[it.place] || 0) + 1; });
      Object.entries(cnt).forEach(([pid, n]) => {
        const p = IDX.place[pid];
        if (p) L.circleMarker([p.lat, p.lng], { pane: 'hot', className: 'hot', radius: 9 + 5 * Math.sqrt(n), stroke: true, color: '#f59e0b', weight: 1, opacity: 0.55, fillColor: '#f59e0b', fillOpacity: 0.2, interactive: false }).addTo(hotLayer);
      });
    }

    const byPlace = {};
    cur.located.forEach(it => (byPlace[it.place] ||= []).push(it));
    const ms = [];
    for (const [pid, arr] of Object.entries(byPlace)) {
      const p = IDX.place[pid];
      if (!p) continue;
      arr.forEach((it, i) => {
        const m = L.marker(spread(p.lat, p.lng, i), { icon: pinIcon(it), st: it.status, title: `${it.name} · ${p.name}`, alt: `${it.name} (${p.name})` });
        m.on('click', () => openLost(it));
        ms.push(m);
      });
      // 공연장 모드에서는 공연장 이름표가 따로 있어 지점 이름표가 겹친다 → 지도 모드에서만 표시
      if (state.mode === 'map') {
        L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'lbl', html: `<i>${esc(p.name)}</i>`, iconSize: [0, 0] }), interactive: false, keyboard: false })
          .addTo(labelLayer);
      }
    }
    cluster.addLayers(ms);

    // 주변 역(경찰청 습득물)
    const stIds = state.mode === 'venue'
      ? (state.venue ? IDX.venue[state.venue].stations : [])
      : (state.showStations ? D.base.stations.map(s => s.id) : []);
    stIds.forEach(sid => {
      const s = IDX.station[sid];
      const n = cur.police.filter(it => it.station === sid).length;
      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'stn' + (n ? '' : ' none'), html: `<i>🚉<span class="nm"> ${esc(s.name)}</span> <b>${n}</b></i>`, iconSize: [0, 0] }),
        title: `${s.name} 보관 습득물 ${n}건`, zIndexOffset: 500,
      });
      m.on('click', () => { state.station = sid; state.tab = 'station'; if (!isWide()) setSheet('half'); renderList(current()); });
      m.addTo(stationLayer);
    });

    // 공연장
    if (state.mode === 'venue') {
      D.base.venues.forEach(vn => {
        const on = vn.id === state.venue;
        if (state.venue && !on) return;          // 고른 뒤에는 그 공연장만 표시
        if (on) {
          L.circle([vn.lat, vn.lng], { radius: vn.radius, color: '#0f766e', weight: 2, dashArray: '6 6', fillColor: '#0f766e', fillOpacity: 0.07, interactive: false })
            .addTo(overlayLayer);
        }
        const m = L.marker([vn.lat, vn.lng], {
          icon: L.divIcon({ className: 'vn', html: `<i style="${on ? '' : 'background:#fff;color:#17212b;border:1px solid #cfd6de'}">${esc(shortVenue(vn.name))}</i>`, iconSize: [0, 0] }),
          zIndexOffset: on ? 900 : 100, title: vn.name,
        });
        m.on('click', () => selectVenue(vn.id));
        m.addTo(overlayLayer);
      });
    }
  }
  const shortVenue = n => n.replace(/\(.*?\)/, '').trim();

  /* ───────── 목록 시트 ───────── */
  function setSheet(st) {
    const app = $('#app');
    if (app.dataset.sheet === st) return;
    app.dataset.sheet = st;
    $('#sheet').style.height = '';
    document.documentElement.style.setProperty('--sheet-h', st);
    placeAttribution();
  }
  function placeAttribution() {
    const pad = sheetPad();
    $$('.leaflet-bottom').forEach(el => el.style.bottom = pad + 'px');
  }
  function initSheet() {
    const sheet = $('#sheet'), handle = $('#sheetHandle');
    let startY = 0, startH = 0, moved = false, dragging = false;
    const snaps = () => { const h = $('.stage').clientHeight; return { peek: 112, half: Math.round(h * HALF), full: h - 8 }; };
    handle.addEventListener('pointerdown', e => {
      if (isWide()) return;
      dragging = true; moved = false; startY = e.clientY; startH = sheet.offsetHeight;
      handle.setPointerCapture(e.pointerId); sheet.style.transition = 'none';
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      if (Math.abs(dy) > 6) moved = true;
      if (moved) {
        const s = snaps();
        sheet.style.height = Math.max(s.peek, Math.min(s.full, startH + dy)) + 'px';
        $('#app').dataset.sheet = 'drag';
      }
    });
    const end = () => {
      if (!dragging) return;
      dragging = false; sheet.style.transition = '';
      const s = snaps();
      if (!moved) {
        const curSt = sheet.offsetHeight <= s.peek + 4 ? 'peek' : (sheet.offsetHeight >= s.full - 4 ? 'full' : 'half');
        $('#app').dataset.sheet = 'x'; setSheet(curSt === 'peek' ? 'half' : 'peek');
        return;
      }
      const h = sheet.offsetHeight;
      const best = Object.entries(s).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0];
      $('#app').dataset.sheet = 'x'; setSheet(best);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    $$('.sheet-tabs button').forEach(b => b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      if (b.dataset.tab !== 'station') state.station = null;
      if ($('#app').dataset.sheet === 'peek') setSheet('half');
      renderList(current());
    }));
    $('#list').addEventListener('click', e => {
      const b = e.target.closest('.item');
      if (!b) return;
      if (b.dataset.kind === 'police') openPolice(D.police.items.find(x => x.id === b.dataset.id));
      else openLost(D.lost.items.find(x => x.id === b.dataset.id));
    });
    $('#sheetDesc').addEventListener('click', e => {
      if (e.target.dataset.act === 'allStations') { e.preventDefault(); state.station = null; renderList(current()); }
      if (e.target.dataset.act === 'find') { e.preventDefault(); openFind(); }
    });
  }

  /* 보관 중인 물건이 적을 때(공원은 1개월 뒤 경찰서로 이관) 첫 화면이 비지 않게:
   * 최근 이관 물건도 회색 핀으로 함께 보여 주고, 기간은 최근 30일(그래도 적으면 전체)로 시작한다. */
  const QUIET_BELOW = 5;
  function applyQuietDefault() {
    const active = D.lost.items.filter(it => it.status === 'keep' || it.status === 'contacted').length;
    if (active >= QUIET_BELOW) return;
    const recent = D.lost.items.filter(it => it.date && it.status !== 'returned' && dayDiff(TODAY, it.date) <= 30).length;
    state.quiet = { active };
    state.showTransferred = true;
    state.period = recent >= QUIET_BELOW ? '30' : 'all';
    $('#tgTransferred').checked = true;
    $$('.seg [data-period]').forEach(b => b.classList.toggle('on', b.dataset.period === state.period));
  }

  const badge = it => `<span class="badge ${it.status === 'keep' ? '' : it.status}">${STATUS[it.status]}</span>`;
  function lostRow(it, extra = '') {
    const c = IDX.cat[it.cat] || { icon: '📦' };
    const p = it.place ? IDX.place[it.place] : null;
    // 원문에 표준 지점 이름이 그대로 들어 있으면 원문만, 아니면 "표준 지점 · 원문"
    const sq = s => String(s || '').replace(/\s+/g, '');
    const where = p ? (sq(it.place_raw).includes(sq(p.name)) ? it.place_raw : `${p.name} · ${it.place_raw}`) : (it.place_raw || '공원 내');
    // 보관 중인데 1개월(보관 기한)이 지났으면 이미 경찰서로 넘어갔을 수 있다
    if ((it.status === 'keep' || it.status === 'contacted') && dayDiff(TODAY, it.date) > 30) {
      extra = `<em class="tag unk" title="보관 기한(1개월)이 지나 경찰서로 넘어갔을 수 있습니다">기한 지남</em>` + extra;
    }
    // 이관됐더라도 안내센터가 주인과 연락한 기록이 있으면 알려 준다
    if (it.status === 'transferred' && contactedNote(it)) {
      extra = `<em class="tag" title="이관 전에 안내센터가 주인과 연락했습니다">주인과 연락됨</em>` + extra;
    }
    return `<li><button class="item" type="button" data-id="${it.id}">
      <span class="ic">${c.icon}</span>
      <span class="tx"><span class="t1">${esc(it.name)}${it.qty && it.qty !== '1' ? ` <small>×${esc(it.qty)}</small>` : ''}</span>
        <span class="t2">${extra}${esc(where)}</span></span>
      <span class="rt">${badge(it)}<span class="ago">${fmtDate(it.date).replace(/\(.\)/, '')} · ${ago(it.date)}</span></span>
    </button></li>`;
  }
  function policeRow(it) {
    const c = IDX.cat[it.cat] || { icon: '📦' };
    return `<li><button class="item police" type="button" data-kind="police" data-id="${it.id}">
      <span class="ic">${c.icon}</span>
      <span class="tx"><span class="t1">${esc(it.name)}</span><span class="t2">${esc(it.dep)} 보관 · ${esc(it.color || '')}</span></span>
      <span class="rt"><span class="badge police">역 보관</span><span class="ago">${fmtDate(it.date).replace(/\(.\)/, '')} · ${ago(it.date)}</span></span>
    </button></li>`;
  }
  function renderList(cur) {
    const vn = state.mode === 'venue' && state.venue ? IDX.venue[state.venue] : null;
    const stItems = state.station ? cur.police.filter(it => it.station === state.station) : cur.police;
    $('#cntLocated').textContent = cur.located.length;
    $('#cntUnknown').textContent = cur.unknown.length;
    $('#cntStation').textContent = cur.police.length;
    const tabs = $$('.sheet-tabs button');
    tabs[0].firstChild.textContent = vn ? '공연장 주변 ' : '지도 위 물건 ';
    tabs[2].firstChild.textContent = vn ? '가까운 역 ' : '주변 역 ';
    tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));

    let html = '', desc = '';
    if (state.mode === 'venue' && !vn) {
      desc = '';
      html = '<li class="empty">위에서 <b>공연장</b>을 골라 주세요.<br>지도에서 공연장 이름을 눌러도 됩니다.</li>';
    } else if (state.tab === 'located') {
      desc = vn
        ? `${esc(vn.name)} 반경 ${vn.radius}m 안 지점(${vn.near.slice(0, 5).map(id => esc(IDX.place[id].name)).join(', ')}${vn.near.length > 5 ? ' 등' : ''})에서 <b>${fmtDate(state.venueDate)} 이후</b> 습득된 물건입니다.`
        : '습득 장소가 적힌 물건입니다. 핀은 “○○ 부근”을 뜻하는 대략적인 위치입니다.';
      html = cur.located.map(it => lostRow(it)).join('') ||
        `<li class="empty">${vn ? '이 공연장 주변에서 그날 이후 접수된 습득물이 없습니다.<br>‘위치 불명’과 ‘가까운 역’ 탭도 확인해 보세요.' : '조건에 맞는 습득물이 없습니다.<br>기간을 넓히거나 ‘경찰서 이관 보기’를 켜 보세요.'}</li>`;
    } else if (state.tab === 'unknown') {
      desc = '“공원 내”처럼 지점이 적히지 않아 지도에 표시할 수 없는 물건입니다. 공원 어디서든 잃어버렸다면 함께 확인하세요.';
      html = cur.unknown.map(it => lostRow(it)).join('') || '<li class="empty">위치 불명으로 접수된 습득물이 없습니다.</li>';
    } else {
      const s = state.station ? IDX.station[state.station] : null;
      desc = (s ? `<b>${esc(s.name)}</b>(${esc(s.lines)})에 보관 중인 습득물입니다. <a href="#" data-act="allStations">모든 역 보기</a>`
        : '공원 주변 지하철역에 보관 중인 습득물입니다(경찰청 습득물 정보). 주운 곳이 아니라 <b>보관 중인 역</b> 기준입니다.') +
        ' 이름 등 개인정보는 가렸습니다.';
      html = stItems.map(policeRow).join('') ||
        `<li class="empty">${!vn && !state.showStations ? '‘주변 역 습득물’을 켜면 표시됩니다.' : '조건에 맞는 역 보관 습득물이 없습니다.'}</li>`;
    }
    // 보관 중인 물건이 적어 최근 이관 물건까지 함께 보여 주는 중이면, 그 이유를 맨 위에 한 줄로
    if (state.quiet && state.mode === 'map' && state.tab !== 'station' && state.showTransferred) {
      desc = `<span class="quiet">지금 공원 안내센터에 보관 중인 물건은 <b>${state.quiet.active}건</b>입니다. ` +
        `<b>회색 핀</b>은 1개월 보관 뒤 <b>경찰서로 넘어간</b> 물건이에요. 눌러서 찾는 법을 보거나 ` +
        `<a href="#" data-act="find">내 물건 찾기</a>로 한 번에 확인하세요.</span>` + desc;
    }
    // 데이터 기준일: 공원 공고가 언제까지 반영됐는지 늘 보여 준다(실시간이 아니라는 점을 분명히)
    const last = lastNoticeDate();
    if (last && state.tab !== 'station') {
      desc = `<span class="fresh">📅 공원 공고 <b>${fmtDate(last).replace(/\(.\)/, '')}</b>까지 반영${D.lost.updated ? ` · ${fmtStamp(D.lost.updated)} 확인` : ''}</span>` + desc;
    }
    $('#sheetDesc').innerHTML = desc;
    $('#sheetDesc').hidden = !desc;
    $('#list').innerHTML = html;
    $('#list').scrollTop = 0;
  }

  /* ───────── 필터 UI ───────── */
  function renderChips() {
    const pool = lostPool(true);
    const counts = {};
    pool.forEach(it => counts[it.cat] = (counts[it.cat] || 0) + 1);
    const cats = D.base.categories.filter(c => counts[c.id] || state.cats.has(c.id));
    $('#catChips').innerHTML =
      `<button class="chip${state.cats.size ? '' : ' on'}" type="button" data-cat="">전체 <span class="n">${pool.length}</span></button>` +
      cats.map(c => `<button class="chip${state.cats.has(c.id) ? ' on' : ''}" type="button" data-cat="${c.id}">${c.icon} ${esc(c.label)} <span class="n">${counts[c.id] || 0}</span></button>`).join('');
  }
  function initFilters() {
    $$('.seg [data-period]').forEach(b => b.addEventListener('click', () => {
      state.period = b.dataset.period;
      $$('.seg [data-period]').forEach(x => x.classList.toggle('on', x === b));
      render();
    }));
    $('#catChips').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      const id = b.dataset.cat;
      if (!id) state.cats.clear(); else if (state.cats.has(id)) state.cats.delete(id); else state.cats.add(id);
      render();
    });
    const bind = (id, key) => $(id).addEventListener('change', e => {
      state[key] = e.target.checked;
      e.target.closest('label').classList.toggle('on', e.target.checked);
      if (key === 'showStations' && !e.target.checked) state.station = null;
      render();
    });
    bind('#tgReturned', 'showReturned'); bind('#tgTransferred', 'showTransferred'); bind('#tgStations', 'showStations'); bind('#tgHot', 'showHot');
    $$('.tgc input').forEach(i => i.closest('label').classList.toggle('on', i.checked));

    $$('.modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // 공연장·날짜
    $('#venueChips').innerHTML = D.base.venues.map(vn => `<button class="chip" type="button" data-venue="${vn.id}">${esc(vn.name)}</button>`).join('');
    $('#venueChips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) selectVenue(b.dataset.venue); });
    const inp = $('#venueDate');
    inp.max = TODAY; inp.min = addDays(TODAY, -365);
    state.venueDate = addDays(TODAY, -7); inp.value = state.venueDate;
    inp.addEventListener('change', () => { if (inp.value) { state.venueDate = inp.value; markQuick(); render(); } });
    $('#quickDates').innerHTML = quickDays().map(([t, n]) => `<button class="chip" type="button" data-d="${addDays(TODAY, -n)}">${t}</button>`).join('');
    $('#quickDates').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      state.venueDate = b.dataset.d; inp.value = b.dataset.d; markQuick(); render();
    });
    markQuick();
    renderShows();
  }
  const markQuick = () => $$('#quickDates .chip').forEach(b => b.classList.toggle('on', b.dataset.d === state.venueDate));

  function selectVenue(id) {
    state.venue = state.venue === id ? null : id;
    state.station = null; state.tab = 'located';
    $$('#venueChips .chip').forEach(b => b.classList.toggle('on', b.dataset.venue === state.venue));
    const on = $('#venueChips .chip.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    if (state.venue && !isWide() && $('#app').dataset.sheet === 'peek') setSheet('half');
    render();
    if (state.venue) {
      const vn = IDX.venue[state.venue];
      const pts = [[vn.lat, vn.lng], ...vn.stations.slice(0, 1).map(s => [IDX.station[s].lat, IDX.station[s].lng])];
      const b = L.latLng(vn.lat, vn.lng).toBounds(vn.radius * 2.3);
      pts.forEach(p => b.extend(p));
      fitTo(b);
    } else fitPark(true);
  }

  // KOPIS 공연 목록(선택 기능): shows.json 에 공연이 있을 때만 보인다
  function renderShows() {
    // 이미 시작한 공연만(앞으로 열릴 공연은 아직 잃어버릴 일이 없다), 최근 것부터
    const shows = (D.shows.shows || []).filter(s => IDX.venue[s.venue] && s.from <= TODAY)
      .sort((a, b) => (b.to < TODAY ? b.to : TODAY).localeCompare(a.to < TODAY ? a.to : TODAY) || b.from.localeCompare(a.from));
    const box = $('#showChips');
    box.hidden = !shows.length;
    const src = $('#kopisSrc');
    if (src) src.hidden = !shows.length;
    if (!shows.length) return;
    const md = d => d.slice(5).replace('-', '.').replace(/^0/, '').replace('.0', '.');
    box.innerHTML = '<span class="tg-label">최근 공연</span>' + shows.slice(0, 30).map((s, i) => {
      const v = shortVenue(IDX.venue[s.venue].name).replace('·뮤즈라이브', '');
      const nm = s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name;
      return `<button class="chip" type="button" data-i="${i}" title="${esc(s.name)} · ${esc(IDX.venue[s.venue].name)}"><b class="sv">${esc(v)}</b> ${esc(nm)} <span class="n">${md(s.from)}${s.to !== s.from ? '~' + md(s.to) : ''}</span></button>`;
    }).join('');
    if (!src) box.insertAdjacentHTML('afterend',
      '<p class="hint kopis-src" id="kopisSrc">공연 목록 출처: (재)예술경영지원센터 공연예술통합전산망(<a href="https://www.kopis.or.kr" target="_blank" rel="noopener">www.kopis.or.kr</a>)</p>');
    box.onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      const s = shows[+b.dataset.i];
      // 공연 첫날부터(오래 하는 공연은 최근 2주만)
      // 공연 첫날부터 본다. 다만 2주 넘게 이어지는 장기 공연(뮤지컬 등)은 최근 2주만 본다.
      const longRun = dayDiff(s.to, s.from) > 14;
      const d = longRun && s.from < addDays(TODAY, -14) ? addDays(TODAY, -14) : s.from;
      state.venueDate = d > TODAY ? TODAY : d; $('#venueDate').value = state.venueDate; markQuick();
      $$('#showChips .chip').forEach(x => x.classList.toggle('on', x === b));
      if (state.venue !== s.venue) selectVenue(s.venue); else render();
    };
  }

  function setMode(mode) {
    state.mode = mode;
    $('#app').dataset.mode = mode;
    $$('.modes button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    $('#filtersMap').hidden = mode !== 'map';
    $('#filtersVenue').hidden = mode !== 'venue';
    $('#stats').hidden = mode !== 'stats';
    $('#sheet').hidden = mode === 'stats';
    state.station = null; state.tab = 'located';
    if (mode === 'stats') { renderStats(); return; }
    requestAnimationFrame(() => {
      layoutPanel(); map.invalidateSize();
      render();
      if (mode === 'venue' && state.venue) { const id = state.venue; state.venue = null; selectVenue(id); } else fitPark(true);
    });
  }
  function layoutPanel() {
    // 넓은 화면: 목록 패널을 필터 아래에 붙인다
    const f = state.mode === 'venue' ? $('#filtersVenue') : $('#filtersMap');
    const top = f.hidden ? $('.modes').getBoundingClientRect().bottom : f.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty('--panel-top', Math.round(top) + 'px');
    placeAttribution();
  }

  function render() {
    if (state.mode === 'stats') return;
    const cur = current();
    if (state.mode === 'map') renderChips();
    renderMap(cur);
    // 지금 탭이 비어 있고 다른 탭에 결과가 있으면 그쪽을 보여 준다
    if (state.tab === 'located' && !cur.located.length && cur.unknown.length && state.mode === 'map') state.tab = 'unknown';
    renderList(cur);
    const note = $('#mapNote');
    const txt = state.mode === 'venue' && !state.venue ? '공연장을 골라 주세요'
      : (!cur.located.length && (cur.unknown.length || cur.police.length) ? '지도에 표시할 물건이 없어요 · 아래 목록을 확인하세요' : '');
    note.textContent = txt; note.hidden = !txt;
    layoutPanel();
  }

  /* ───────── 물품 상세 ───────── */
  const DLG_BODY = { '#dlgItem': '#itemBody', '#dlgInfo': '#infoBody', '#dlgFind': '#findBody' };
  function showDlg(id, html) {
    const dlg = $(id);
    $(DLG_BODY[id]).innerHTML = `<div class="dlg-body">${html}</div>`;
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
  }
  function openLost(it) {
    if (!it) return;
    const c = IDX.cat[it.cat] || { icon: '📦', label: '기타' };
    const p = it.place ? IDX.place[it.place] : null;
    const center = IDX.center[it.center];
    const age = dayDiff(TODAY, it.date);
    const due = addDays(it.date, 30);
    const tr = it.status === 'transferred' ? D.lost.transfers.filter(t => t.cutoff >= it.date).pop() : null;
    let guide = '';
    if (it.status === 'returned') {
      guide = `<div class="box"><b>주인에게 돌려준 물건입니다.</b><br>참고용으로만 표시합니다.</div>`;
    } else if (it.status === 'transferred') {
      guide = `<div class="box warn"><b>경찰서로 이관된 물건입니다.</b><br>
        ${tr && tr.moved ? `${fmtDate(tr.moved, true)}에 ` : ''}관할 경찰서(송파경찰서)로 넘어갔습니다. 공원 안내센터에는 없습니다.
        <ul><li><a href="${POLICE_SEARCH_URL}" target="_blank" rel="noopener">경찰민원24(옛 LOST112) 습득물 검색</a>에서 찾아보세요.</li>
        <li>전화 문의: 경찰민원콜센터 <a href="tel:182">182</a></li></ul>
        ${age > 180 ? '<small>습득 후 6개월이 지나 보관 기간이 끝났을 수 있습니다.</small>' : ''}</div>`;
    } else {
      // 실제 이관은 습득일마다 따로가 아니라 '한 달에 한 번쯤 모아서' 일괄로 한다(이관 공지 기준).
      // 그래서 남은 날짜를 세어 보여 주지 않고, 최근 이관 시점과 '방문 전 전화'를 안내한다.
      const overdue = TODAY > due;
      const lastTr = (D.lost.transfers || [])[0];
      guide = `<div class="box go"><b>찾으러 가는 방법</b>
        <ol><li>먼저 ${center ? esc(center.name) : '안내센터'}에 전화해 물건이 아직 있는지 확인하세요.</li>
        <li><b>신분증</b>을 가지고 안내센터를 방문하세요. 본인 확인 뒤 돌려드립니다.</li>
        <li>운영 시간 09:00~19:00 (휴게 12:00~13:00)</li></ol></div>
        <div class="box warn">공원은 습득물을 <b>1개월쯤 보관한 뒤, 보통 한 달에 한 번 모아서</b> 관할 경찰서(송파경찰서)로 넘깁니다.
        ${lastTr && lastTr.moved ? `최근에는 ${fmtDate(lastTr.moved, true)}에 ${fmtDate(lastTr.cutoff)}까지 주운 물건을 넘겼습니다.` : ''}<br>
        ${overdue ? `<b>습득 후 1개월이 지났습니다.</b> 이미 넘어갔을 수 있습니다.` : '다음 이관 날짜는 미리 알 수 없습니다.'}
        <b>방문 전에 꼭 전화로 확인하세요.</b>
        ${it.status === 'contacted' || contactedNote(it) ? '<br>안내센터가 주인과 이미 연락한 물건입니다.' : ''}</div>`;
    }
    if (it.status === 'transferred' && contactedNote(it)) {
      guide += '<p class="hint2">이 물건은 이관 전에 안내센터가 주인과 연락한 기록(비고)이 있습니다.</p>';
    }
    const tel = center && it.status !== 'returned' && it.status !== 'transferred'
      ? `<a class="btn" href="tel:${center.tel}">📞 ${esc(center.name)} ${esc(center.tel_text)}</a>` : '';
    const mapBtn = (p ? `<button class="btn line" type="button" id="btnGo">지도에서 위치 보기</button>` : '') + shareBtn();
    showDlg('#dlgItem', `
      <h2><span class="ic">${c.icon}</span>${esc(it.name)}</h2>
      <div class="meta">${badge(it)}<span class="badge returned">${esc(c.label)}</span><span style="font-size:13px;color:var(--ink-3)">${ago(it.date)} 습득</span></div>
      <dl class="kv">
        <dt>습득일</dt><dd>${fmtDate(it.date, true)}</dd>
        <dt>수량</dt><dd>${esc(it.qty || '1')}</dd>
        <dt>습득 장소</dt><dd>${esc(it.place_raw || '공원 내')}
          <small>${p ? `지도 지점: ${esc(p.name)} (${esc(zoneLabel(p.zone))})${p.conf === 'high' ? '' : ' · 위치는 추정값'}` : '지점이 적히지 않아 지도에 표시할 수 없습니다(공원 전체).'}</small></dd>
        <dt>확인 방법</dt><dd>${esc(it.desc || '안내센터 문의')}<small>본인 확인에 쓰는 항목입니다.</small></dd>
        ${it.note ? `<dt>비고</dt><dd>${esc(it.note)}</dd>` : ''}
        <dt>보관</dt><dd>${center ? `${esc(center.name)}<small>${esc(center.tel_text)}</small>` : '올림픽공원 안내센터'}</dd>
      </dl>
      ${guide}${tel}${mapBtn}
      <p class="src">출처: 올림픽공원 유실물 정보(한국체육산업개발㈜, 문화공공데이터광장)${it.posted ? ` · ${it.posted} 게시` : ''}<br>
      사진은 제공되지 않습니다. 실제 보관 여부는 안내센터에 확인하세요.</p>`);
    bindShare('item', it.id, `${it.name} · ${it.place_raw || '올림픽공원'} (${fmtDate(it.date)} 습득)`);
    const go = $('#btnGo');
    if (go) go.onclick = () => {
      $('#dlgItem').close();
      if ($('#dlgFind').open) $('#dlgFind').close();
      if (state.mode === 'stats') setMode('map');
      if (!isWide()) setSheet('peek');
      setTimeout(() => {
        map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 18), { duration: 0.6 });
        const ring = L.circleMarker([p.lat, p.lng], { radius: 26, color: '#0f766e', weight: 3, fillOpacity: 0.08, interactive: false }).addTo(map);
        setTimeout(() => map.removeLayer(ring), 2600);
      }, 60);
    };
  }
  function openPolice(it) {
    if (!it) return;
    const c = IDX.cat[it.cat] || { icon: '📦', label: '기타' };
    const s = IDX.station[it.station];
    const atc = it.id.slice(0, it.id.lastIndexOf('-'));
    showDlg('#dlgItem', `
      <h2><span class="ic">${c.icon}</span>${esc(it.name)}</h2>
      <div class="meta"><span class="badge police">역 보관</span><span style="font-size:13px;color:var(--ink-3)">${ago(it.date)} 습득</span></div>
      <dl class="kv">
        <dt>습득일</dt><dd>${fmtDate(it.date, true)}</dd>
        <dt>분류</dt><dd>${esc(it.cls || c.label)}</dd>
        ${it.color ? `<dt>색상</dt><dd>${esc(it.color)}</dd>` : ''}
        <dt>보관 장소</dt><dd>${esc(it.dep)}<small>${s ? `${esc(s.name)} ${esc(s.lines)}` : ''} · 주운 곳이 아니라 보관 중인 곳입니다.</small></dd>
        <dt>관리번호</dt><dd>${esc(atc)}<small>${it.img ? '경찰청 사이트에 사진이 있습니다.' : '등록된 사진 없음'}</small></dd>
      </dl>
      <div class="box go"><b>찾으러 가는 방법</b>
        <ol><li>아래 버튼으로 경찰민원24(옛 LOST112) 습득물 검색을 열고, 보관 장소 <b>${esc(it.dep)}</b>와 습득일로 찾아 사진과 연락처를 확인하세요.</li>
        <li>보관 기관(역 고객안전실·유실물센터)에 전화한 뒤 <b>신분증</b>을 가지고 방문하세요.</li></ol></div>
      <a class="btn blue" href="${POLICE_SEARCH_URL}" target="_blank" rel="noopener">경찰민원24 습득물 검색 열기</a>
      ${shareBtn()}
      <p class="src">출처: 경찰청 포털기관 습득물정보(공공데이터포털). 품명에 들어 있는 이름·전화번호 등 개인정보는 가렸습니다.<br>
      역에서 일정 기간이 지나면 유실물센터나 경찰서로 옮겨질 수 있습니다.</p>`);
    bindShare('p', it.id, `${it.name} · ${it.dep} 보관 (${fmtDate(it.date)} 습득)`);
  }

  /* ───────── 공유 링크 ─────────
   * 물건마다 주소가 있다: …/chajaolpak/#item=<id> (공원), #p=<id> (주변 역). 링크를 열면 그 물건 상세가 바로 뜬다. */
  const shareBtn = () => `<button class="btn line" type="button" id="btnShare">🔗 이 물건 링크 공유</button><p class="share-msg" id="shareMsg" hidden></p>`;
  function shareUrl(kind, id) {
    return location.origin + location.pathname + '#' + kind + '=' + encodeURIComponent(id);
  }
  function bindShare(kind, id, text) {
    const b = $('#btnShare'); if (!b) return;
    b.onclick = async () => {
      const url = shareUrl(kind, id), msg = $('#shareMsg');
      const say = t => { msg.textContent = t; msg.hidden = false; };
      if (navigator.share) {
        try { await navigator.share({ title: '찾아올팍 — 올림픽공원 습득물', text, url }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
      }
      try { await navigator.clipboard.writeText(url); say('링크를 복사했습니다. 문자나 메신저에 붙여 넣으세요.'); }
      catch (e) { say(url); }     // 복사가 막힌 브라우저: 주소를 그대로 보여 준다
    };
  }
  function openFromHash() {
    const m = location.hash.match(/^#(item|p)=([^&]+)/);
    if (!m) return;
    const id = decodeURIComponent(m[2]);
    const it = (m[1] === 'item' ? D.lost.items : D.police.items).find(x => x.id === id);
    if (it) { (m[1] === 'item' ? openLost : openPolice)(it); return; }
    showDlg('#dlgItem', `<h2>물건 정보를 찾을 수 없어요</h2>
      <p>공유받은 물건이 목록에서 빠졌습니다. 주인에게 돌아갔거나, 보관 기간이 끝나 목록에서 내려갔을 수 있습니다.</p>
      <div class="box go">평화의 광장 안내센터 <a href="tel:02-2180-3564">02-2180-3564~5</a><br>만남의 광장 안내센터 <a href="tel:02-2180-3566">02-2180-3566</a></div>`);
  }

  /* ───────── 내 물건 찾기(도우미) ─────────
   * 품목·잃어버린 날·대략의 장소를 받아 '공원 안내센터 / 경찰서로 이관 / 근처 역' 세 갈래로 후보를 보여 준다. */
  const FIND_WINDOW = 7;      // 잃어버린 날부터 며칠 안에 주운 물건까지 볼지
  const NEAR_M = 450;         // 고른 장소에서 이 거리 안이면 '가까운 곳'
  const LOST_REPORT_URL = 'https://minwon24.police.go.kr/cvlcpt/cvlcptGdInfo.do?cvlcptId=MW-001';
  const find = { cats: new Set(), date: '', where: '' };

  function quickDays() {
    const dow = new Date(ts(TODAY)).getUTCDay();
    return [['오늘', 0], ['어제', 1], ['지난 토요일', ((dow + 1) % 7) || 7], ['지난 일요일', dow || 7], ['1주 전', 7], ['2주 전', 14], ['한 달 전', 30]];
  }
  function distM(a, b) {
    const dy = (a.lat - b.lat) * 111320, dx = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dx, dy);
  }
  function lastNoticeDate() {
    let m = '';
    D.lost.items.forEach(it => { const d = it.posted || it.date; if (d > m) m = d; });
    return m;
  }

  function openFind() {
    if (!find.date) find.date = addDays(TODAY, -1);
    const zones = {};
    D.base.places.forEach(p => (zones[p.zone] ||= []).push(p));
    const opt = (v, t) => `<option value="${v}"${find.where === v ? ' selected' : ''}>${esc(t)}</option>`;
    // 공연장도 지점 목록 안에 있으므로 따로 묶지 않는다(같은 이름이 두 번 나오지 않게)
    const whereOpts = opt('', '잘 모르겠어요 (공원 전체)') +
      Object.entries(zones).map(([z, ps]) => `<optgroup label="${esc(zoneLabel(z))}">${ps.map(p => opt('p:' + p.id, p.name)).join('')}</optgroup>`).join('');
    showDlg('#dlgFind', `
      <h2><span class="ic">🔍</span>내 물건 찾기</h2>
      <p>잃어버린 물건과 날짜를 알려 주시면 <b>공원 안내센터 · 경찰서 · 근처 역</b> 가운데 어디에 있을 수 있는지 한 번에 찾아 드립니다.</p>
      <h3>1. 무엇을 잃어버렸나요? <small>여러 개 골라도 돼요</small></h3>
      <div class="chips wrap" id="fCats">${D.base.categories.map(c =>
        `<button type="button" class="chip${find.cats.has(c.id) ? ' on' : ''}" data-cat="${c.id}">${c.icon} ${esc(c.label)}</button>`).join('')}</div>
      <h3>2. 언제 잃어버렸나요?</h3>
      <input type="date" id="fDate" class="inp" value="${find.date}" max="${TODAY}" min="2016-01-01" aria-label="잃어버린 날">
      <div class="chips wrap" id="fQuick">${quickDays().map(([t, n]) => {
        const d = addDays(TODAY, -n);
        return `<button type="button" class="chip${d === find.date ? ' on' : ''}" data-d="${d}">${t}</button>`;
      }).join('')}</div>
      <h3>3. 어디쯤이었나요? <small>모르면 그대로 두세요</small></h3>
      <select id="fWhere" class="inp" aria-label="잃어버린 장소">${whereOpts}</select>
      <button class="btn" type="button" id="fGo">찾아보기</button>`);
    const di = $('#fDate');
    const markQ = () => $$('#fQuick .chip').forEach(x => x.classList.toggle('on', x.dataset.d === find.date));
    $('#fCats').onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      const id = b.dataset.cat;
      if (find.cats.has(id)) find.cats.delete(id); else find.cats.add(id);
      b.classList.toggle('on', find.cats.has(id));
    };
    di.onchange = () => { if (di.value) { find.date = di.value; markQ(); } };
    $('#fQuick').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; find.date = b.dataset.d; di.value = find.date; markQ(); };
    $('#fGo').onclick = () => { find.where = $('#fWhere').value; if (di.value) find.date = di.value; showFindResult(); };
  }

  function showFindResult() {
    const from = find.date, to = addDays(find.date, FIND_WINDOW);
    const inWin = d => d && d >= from && d <= to;
    const want = it => !find.cats.size || find.cats.has(it.cat);
    let anchor = null, anchorName = '';
    if (find.where.startsWith('v:')) { anchor = IDX.venue[find.where.slice(2)]; anchorName = anchor && anchor.name; }
    else if (find.where.startsWith('p:')) { anchor = IDX.place[find.where.slice(2)]; anchorName = anchor && anchor.name; }

    const tagOf = it => {
      if (!it.place) return ['unk', '위치 불명'];
      if (!anchor) return ['', ''];
      return distM(anchor, IDX.place[it.place]) <= NEAR_M ? ['near', '가까운 곳'] : ['far', '다른 구역'];
    };
    const rank = it => ({ near: 0, '': 0, unk: 1, far: 2 })[tagOf(it)[0]];
    const byRank = (a, b) => rank(a) - rank(b) || a.date.localeCompare(b.date);
    const park = D.lost.items.filter(it => inWin(it.date) && want(it));
    const held = park.filter(it => it.status === 'keep' || it.status === 'contacted').sort(byRank);
    const moved = park.filter(it => it.status === 'transferred').sort(byRank);
    const returned = park.filter(it => it.status === 'returned').length;
    const st = D.police.items.filter(it => inWin(it.date) && want(it)).sort((a, b) => a.date.localeCompare(b.date));
    const row = it => { const [cls, txt] = tagOf(it); return lostRow(it, txt ? `<em class="tag ${cls}">${txt}</em>` : ''); };

    const last = lastNoticeDate();
    const pending = to > last;          // 아직 공고가 안 올라왔을 수 있는 날이 남아 있다
    const catTxt = find.cats.size ? [...find.cats].map(id => IDX.cat[id].label).join(', ') : '모든 품목';
    const tr = moved.length ? D.lost.transfers.filter(t => t.cutoff >= moved[0].date).pop() : null;
    const sec = (icon, title, n, body) => `<section class="find-sec"><h3>${icon} ${title} <b>${n}건</b></h3>${body}</section>`;
    showDlg('#dlgFind', `
      <h2><span class="ic">🔍</span>찾아본 결과</h2>
      <p class="find-q">${esc(catTxt)} · ${fmtDate(from, true)} 분실${anchor ? ` · ${esc(anchorName)} 부근` : ''}
        <small>잃어버린 날부터 ${FIND_WINDOW}일 안에 주운 물건을 찾았습니다.</small></p>
      ${pending ? `<div class="box warn"><b>공원 공고는 ${fmtDate(last, true)}까지 올라와 있어요.</b><br>
        그 뒤에 주운 물건은 아직 공고 전이라 여기 없을 수 있습니다. 안내센터에 바로 전화해 보세요.</div>` : ''}
      ${sec('🏢', '공원 안내센터에 있을 수 있어요', held.length, held.length
        ? `<ul class="list in-dlg">${held.map(row).join('')}</ul><p class="hint2">물건을 누르면 확인 방법과 전화번호가 나옵니다. 찾으러 갈 때는 신분증을 챙기세요.</p>`
        : '<p class="hint2">조건에 맞는, 지금 보관 중인 물건은 없습니다.</p>')}
      ${sec('🚓', '경찰서로 넘어갔을 수 있어요', moved.length, moved.length
        ? `<ul class="list in-dlg">${moved.map(row).join('')}</ul>
          <div class="box">공원은 습득물을 1개월 보관한 뒤 송파경찰서로 넘깁니다${tr && tr.moved ? `(이 무렵 물건은 ${fmtDate(tr.moved, true)} 이관)` : ''}.<br>
          <a href="${POLICE_SEARCH_URL}" target="_blank" rel="noopener">경찰민원24 습득물 검색</a>에서 찾거나 경찰민원콜센터 <a href="tel:182">182</a>에 문의하세요.</div>`
        : '<p class="hint2">그 기간에 경찰서로 넘어간 비슷한 물건은 없습니다.</p>')}
      ${sec('🚉', '근처 역에 맡겨졌을 수 있어요', st.length, st.length
        ? `<ul class="list in-dlg">${st.map(policeRow).join('')}</ul><p class="hint2">공원 밖(지하철·역 주변)에서 잃어버렸다면 확인하세요. 주운 곳이 아니라 보관 중인 역입니다.</p>`
        : `<p class="hint2">공원 주변 역에 보관된 비슷한 물건은 없습니다${dayDiff(TODAY, from) > 180 ? '(역 보관 정보는 최근 6개월만 있습니다)' : ''}.</p>`)}
      ${returned ? `<p class="hint2">같은 조건의 물건 ${returned}건은 이미 주인에게 돌아갔습니다.</p>` : ''}
      <div class="box go"><b>여기 없어도 포기하지 마세요</b>
        <ul><li>평화의 광장 안내센터 <a href="tel:02-2180-3564">02-2180-3564~5</a></li>
        <li>만남의 광장 안내센터 <a href="tel:02-2180-3566">02-2180-3566</a></li>
        <li><a href="${LOST_REPORT_URL}" target="_blank" rel="noopener">경찰민원24에 분실 신고</a>를 해 두면 비슷한 습득물이 등록될 때 알기 쉽습니다.</li></ul></div>
      <button class="btn line" type="button" id="fBack">조건 바꿔서 다시 찾기</button>`);
    $('#fBack').onclick = openFind;
  }

  /* ───────── 안내 ───────── */
  function openInfo() {
    const m = D.meta || {};
    const row = (name, x, extra) => `<tr><th>${name}</th><td><span class="dot ${x && x.ok === false ? 'bad' : 'ok'}"></span>${x && x.updated ? fmtStamp(x.updated) + ' 갱신' : '아직 없음'}
      ${x && x.ok === false ? '<br><small>최근 수집 실패 — 직전 데이터를 보여 주고 있습니다.</small>' : ''}${extra ? `<br><small>${extra}</small>` : ''}</td></tr>`;
    const lost = m.lost || {}, pol = m.police || {};
    const unmatched = Object.keys(lost.unmatched || {});
    showDlg('#dlgInfo', `
      <h2>찾아올팍 안내</h2>
      <p>올림픽공원에서 주운 물건을 <b>어디서 주웠는지</b> 기준으로 지도에 보여 주는 서비스입니다. 회원가입이나 앱 설치 없이 쓸 수 있습니다.</p>
      <h3>지도 읽는 법</h3>
      <div class="legend"><span>보관 중</span><span class="contacted">연락 완료</span><span class="transferred">경찰서 이관</span><span class="returned">반환 완료</span><span class="police">주변 역 보관</span><span class="hotl">자주 줍는 곳(최근 1년)</span></div>
      <p>핀은 공원 안내센터가 적어 둔 습득 장소(예: “나홀로나무 부근”)를 표준 지점 ${D.base.places.length}곳으로 묶어 표시한 것입니다. 정확한 좌표가 아니라 <b>대략적인 위치</b>입니다.
      “공원 내”처럼 지점이 없는 물건은 ‘위치 불명’ 목록에 따로 모았습니다.</p>
      <h3>물건을 찾으려면</h3>
      <div class="box go">
        <b>평화의 광장 안내센터</b> <a href="tel:02-2180-3564">02-2180-3564~5</a><br>
        <b>만남의 광장 안내센터</b> <a href="tel:02-2180-3566">02-2180-3566</a><br>
        운영 09:00~19:00 (휴게 12:00~13:00) · 신분증 지참 · 본인 확인 후 수령<br>
        습득일로부터 1개월 보관 후 관할 경찰서(송파경찰서)로 이관됩니다.
      </div>
      <h3>데이터와 갱신 상태</h3>
      <table class="tbl">
        ${row('올림픽공원 유실물', lost, `한국체육산업개발㈜ · 문화공공데이터광장 / 물건 ${D.lost.items.length}건${D.lost.transfer_cutoff ? ` · ${D.lost.transfer_cutoff}까지 습득분은 경찰서 이관` : ''}`)}
        ${row('주변 역 습득물', pol, `경찰청 포털기관 습득물정보 · 공공데이터포털 / ${D.police.items.length}건`)}
        <tr><th>공연장 이름</th><td>올림픽공원 공연정보(한국체육산업개발㈜)의 공연장 표기를 표준 이름으로 정리해 사용</td></tr>
        ${(D.shows.shows || []).length ? `<tr><th>최근 공연</th><td>출처: (재)예술경영지원센터 공연예술통합전산망(<a href="https://www.kopis.or.kr" target="_blank" rel="noopener">www.kopis.or.kr</a>)<br><small>${fmtStamp(D.shows.updated)} 갱신 · 올림픽공원 공연 ${D.shows.shows.length}건</small></td></tr>` : ''}
        <tr><th>지도</th><td>© OpenStreetMap 기여자 (ODbL)</td></tr>
      </table>
      <p>데이터는 하루 6번 자동으로 갱신됩니다(원본 기관이 공고를 올려야 반영됩니다). 실제 보관 여부는 반드시 안내센터에 전화로 확인하세요.</p>
      <h3>장소 사전 내려받기</h3>
      <p>습득 장소 표기를 표준 지점과 좌표로 정리한 사전을 공개합니다. 좌표 일부가 OpenStreetMap에서 왔기 때문에
      <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">ODbL 1.0</a> 조건(출처 표시, 고친 사전도 같은 조건으로 공개)으로 쓰실 수 있습니다.
      서비스 소스 코드는 MIT 라이선스입니다.</p>
      <a class="btn line" href="data/places.csv" download="chajaolpak_places.csv">장소 사전(places.csv) 내려받기</a>
      <h3>현장 안내용 QR 포스터</h3>
      <p>안내센터·매표소에 붙일 수 있는 A4 포스터입니다. QR을 찍으면 이 서비스가 열립니다.</p>
      <a class="btn line" href="poster.html" target="_blank" rel="noopener">QR 포스터 열기·인쇄</a>
      ${unmatched.length ? `<p class="src">아직 사전에 없는 표기: ${unmatched.map(esc).join(', ')}</p>` : ''}
      <h3>개인정보</h3>
      <p>이 서비스는 이용자 정보를 수집하지 않습니다. 경찰청 습득물 품명에 들어 있는 이름은 “홍○○”처럼 가리고, 전화번호·카드번호 형태의 숫자도 가립니다.</p>
      <p class="src">한국체육산업개발㈜ 「2026년도 공공데이터 활용 경진대회」 출품작 프로토타입입니다. 공식 서비스가 아니며, 최종 확인은 올림픽공원 안내센터에서 해 주세요.
      ${REPO_URL ? `<br><a href="${REPO_URL}" target="_blank" rel="noopener">소스 코드 보기</a>` : ''}</p>`);
  }

  /* ───────── 현황(기관용 요약) ───────── */
  function bars(rows, cls) {
    const max = Math.max(1, ...rows.map(r => r[1]));
    return rows.map(r => `<div class="bar"><span class="nm" title="${esc(r[0])}">${esc(r[0])}</span><span class="tr"><span class="fl ${cls || ''}" style="width:${(r[1] / max * 100).toFixed(1)}%"></span></span><span class="vl">${r[1]}${r[2] || ''}</span></div>`).join('');
  }
  const tally = (arr, fn) => { const o = {}; arr.forEach(x => { const k = fn(x); if (k != null) o[k] = (o[k] || 0) + 1; }); return o; };
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  // 안내센터가 있는 지점: 습득장소가 '주운 곳'이 아니라 '맡긴 곳'으로 적혔을 수 있어 분석에서 따로 다룬다
  const CENTER_PLACES = new Set(['peace_plaza', 'meeting_plaza']);
  // 각 지점을 반경 안에서 가장 가까운 공연장 '한 곳'에만 배정한다(두 공연장에 겹쳐 세지 않도록)
  let VENUE_OF = null;
  function venueOf(pid) {
    if (!VENUE_OF) {
      VENUE_OF = {};
      const vs = D.base.venues.filter(v => v.id !== 'v_peace');
      D.base.places.forEach(p => {
        let best = null, bd = Infinity;
        vs.forEach(v => { const d = distM(p, v); if (d <= v.radius && d < bd) { bd = d; best = v.id; } });
        VENUE_OF[p.id] = best;
      });
    }
    return VENUE_OF[pid] || null;
  }
  const contactedNote = it => it.status !== 'returned' && /연락/.test(it.note || '');

  function renderStats() {
    const all = D.lost.items.filter(it => it.date);
    const from = state.statsRange === 'year' ? addDays(TODAY, -365) : (state.statsRange === '2025' ? '2025-01-01' : '0000');
    const items = all.filter(it => it.date >= from);
    const n = items.length || 1;
    const held = all.filter(it => it.status === 'keep' || it.status === 'contacted').length;
    const returned = items.filter(it => it.status === 'returned').length;
    const contacted = items.filter(contactedNote).length;
    const located = items.filter(it => it.place);
    const field = located.filter(it => !CENTER_PLACES.has(it.place));          // 안내센터 지점을 뺀 나머지
    const atCenter = located.length - field.length;
    const nearVenue = field.filter(it => venueOf(it.place)).length;
    const byPlace = top(tally(located, it => IDX.place[it.place] ? IDX.place[it.place].name + (CENTER_PLACES.has(it.place) ? ' (안내센터)' : '') : null), 12);
    const byCat = top(tally(items, it => IDX.cat[it.cat]?.label), 12);
    const byZone = top(tally(located, it => zoneLabel(IDX.place[it.place]?.zone)), 8);
    const byCenter = top(tally(items, it => IDX.center[it.center]?.name), 2);
    const wd = tally(items, it => new Date(ts(it.date)).getUTCDay());
    const months = [];
    for (let i = 23; i >= 0; i--) { const d = new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1 - i, 1)); months.push(d.toISOString().slice(0, 7)); }
    const byMonth = tally(all, it => it.date.slice(0, 7));
    const mMax = Math.max(1, ...months.map(m => byMonth[m] || 0));
    const first = all.length ? all[all.length - 1].date.slice(0, 7) : '';
    // 공연장별: 과거 공연 건수(공연정보 API, 2024년까지)와 주변 지점 습득물 건수를 나란히
    const vrows = D.base.venues.filter(v => v.perf && v.id !== 'v_peace').sort((a, b) => b.perf - a.perf).map(v => (
      { name: shortVenue(v.name), perf: v.perf, lost: field.filter(it => venueOf(it.place) === v.id).length }));
    const pMax = Math.max(1, ...vrows.map(r => r.perf)), lMax = Math.max(1, ...vrows.map(r => r.lost));
    // 주말(토·일) 하루 평균 vs 평일 하루 평균
    const wkend = ((wd[6] || 0) + (wd[0] || 0)) / 2, wkday = [1, 2, 3, 4, 5].reduce((s, d) => s + (wd[d] || 0), 0) / 5;
    const wkRatio = wkday ? (wkend / wkday) : 0;
    const pct = x => `${(x / n * 100).toFixed(1)}%`;
    $('#stats').innerHTML = `
      <div class="card"><h2>습득물 현황 요약</h2>
        <p class="sub">공원 운영 담당자를 위한 요약입니다. 올림픽공원 유실물 정보 ${first} ~ ${TODAY.slice(0, 7)} 습득물 ${all.length}건,
        <b>${fmtDate(TODAY, true).replace(/\(.\)/, '')} 기준</b>(공원 공고 ${fmtDate(lastNoticeDate(), true).replace(/\(.\)/, '')}까지 반영)이며 매일 자동으로 바뀝니다.</p>
        <div class="seg small" role="group" aria-label="집계 기간">
          <button type="button" data-r="all" class="${state.statsRange === 'all' ? 'on' : ''}">전체 기간</button>
          <button type="button" data-r="2025" class="${state.statsRange === '2025' ? 'on' : ''}">2025년 이후</button>
          <button type="button" data-r="year" class="${state.statsRange === 'year' ? 'on' : ''}">최근 1년</button>
        </div></div>
      <div class="kpis">
        <div class="kpi"><b>${items.length}</b><span>습득물(선택 기간)</span></div>
        <div class="kpi"><b>${held}</b><span>지금 안내센터 보관 중</span></div>
        <div class="kpi"><b>${pct(returned)}</b><span>반환 완료 (${returned}건)</span></div>
        <div class="kpi"><b>${pct(contacted)}</b><span>주인과 연락 완료 (${contacted}건)</span></div>
      </div>
      <div class="card"><h2>습득이 많은 지점</h2>
        <p class="sub">습득물의 ${pct(located.length)}에 지점이 적혀 있습니다. ‘(안내센터)’ 표시 지점은 안내센터가 있는 곳이라, 주운 곳이 아니라 <b>맡긴 곳</b>으로 적혔을 수 있습니다. 순찰·안내 우선순위는 그 밖의 지점을 함께 보세요.</p>
        ${bars(byPlace) || '<p class="sub">자료 없음</p>'}</div>
      <div class="card"><h2>공연장 주변과 그 밖</h2><p class="sub">각 지점을 반경 약 300m 안에서 가장 가까운 공연장 <b>한 곳</b>에만 셉니다. 안내센터 지점은 맡긴 곳일 수 있어 따로 나눴습니다.</p>
        ${bars([['공연장 주변 지점', nearVenue], ['그 밖의 지점', field.length - nearVenue], ['안내센터 지점', atCenter], ['위치 불명', items.length - located.length]], 'b2')}</div>
      <div class="card"><h2>품목</h2>${bars(byCat)}</div>
      <div class="card"><h2>월별 습득 건수 (최근 24개월)</h2>
        <div class="cols">${months.map(m => `<div class="c${(byMonth[m] || 0) === mMax ? ' hi' : ''}" style="height:${((byMonth[m] || 0) / mMax * 100).toFixed(1)}%" title="${m}: ${byMonth[m] || 0}건"></div>`).join('')}</div>
        <div class="cols-x"><span>${months[0]}</span><span>가장 많은 달 ${mMax}건</span><span>${months[23]}</span></div></div>
      <div class="card"><h2>요일</h2>
        ${wkRatio >= 1.2 ? `<p class="sub"><b>공연·행사가 몰리는 주말</b>에는 습득물이 평일의 <b>${wkRatio.toFixed(1)}배</b>입니다.
          (토·일 요일당 평균 ${wkend.toFixed(1)}건 ÷ 월~금 요일당 평균 ${wkday.toFixed(1)}건)</p>` : ''}
        ${bars([1, 2, 3, 4, 5, 6, 0].map(d => [WD[d] + '요일', wd[d] || 0]), 'b3')}</div>
      ${vrows.length ? `<div class="card"><h2>공연장별 공연 건수와 주변 습득물</h2>
        <p class="sub">공연 건수는 올림픽공원 공연정보(한국체육산업개발㈜, 2024년까지 ${vrows.reduce((s, r) => s + r.perf, 0).toLocaleString()}건)를 공연장 이름별로 정리한 것이고,
        습득물은 가장 가까운 공연장 한 곳에만 센 주변 지점 기준(안내센터 지점 제외, 선택 기간)입니다. 공연정보에 날짜가 거의 없어 날짜별 비교는 하지 않았습니다.</p>
        <div class="vs-head"><span></span><span>공연</span><span>주변 습득물</span></div>
        ${vrows.map(r => `<div class="vs"><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span>
          <span class="tr"><span class="fl" style="width:${(r.perf / pMax * 100).toFixed(1)}%"></span><em>${r.perf}</em></span>
          <span class="tr"><span class="fl b2" style="width:${(r.lost / lMax * 100).toFixed(1)}%"></span><em>${r.lost}</em></span></div>`).join('')}</div>` : ''}
      <div class="card"><h2>공원 구역 · 접수 안내센터</h2>${bars(byZone)}<div style="height:10px"></div>${bars(byCenter, 'b2')}</div>
      <div class="card"><p class="sub" style="margin:0">지점 좌표와 별칭은 ‘안내 → 장소 사전 내려받기’에서 CSV로 받을 수 있습니다.</p></div>`;
    $$('#stats [data-r]').forEach(b => b.onclick = () => { state.statsRange = b.dataset.r; renderStats(); });
  }

  /* ───────── 시작 ───────── */
  async function start() {
    TODAY = todayKST();
    try { await load(); } catch (e) {
      $('#list').innerHTML = `<li class="empty">데이터를 불러오지 못했습니다.<br>잠시 뒤 새로고침해 주세요.</li>`;
      $('#app').dataset.sheet = 'half';
      console.error(e); return;
    }
    applyQuietDefault();
    initMap(); initSheet(); initFilters();
    $('#btnInfo').addEventListener('click', openInfo);
    $('#btnFind').addEventListener('click', openFind);
    $('#findBody').addEventListener('click', e => {
      const b = e.target.closest('.item'); if (!b) return;
      if (b.dataset.kind === 'police') openPolice(D.police.items.find(x => x.id === b.dataset.id));
      else openLost(D.lost.items.find(x => x.id === b.dataset.id));
    });
    $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
    window.addEventListener('resize', () => { layoutPanel(); map.invalidateSize(); });
    render();
    map.whenReady(() => { placeAttribution(); });
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
  }
  start();
})();
