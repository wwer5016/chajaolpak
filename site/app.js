/* 찾아올팍 — 올림픽공원 유실물 지도 (정적 사이트, 서버·회원 없음)
 * 데이터는 site/data/*.json 만 읽는다. 공공 API 는 브라우저에서 직접 부르지 않는다. */
(() => {
  'use strict';

  const REPO_URL = 'https://github.com/wwer5016/chajaolpak';   // 소스 저장소 주소(안내 창에 링크로 나온다)
  const PARK_BOUNDS = [[37.5122, 127.1108], [37.5268, 127.1322]];
  const STATUS = { keep: '보관 중', contacted: '연락 완료', transferred: '경찰서 이관', returned: '반환 완료' };
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
      // '전체 보관 중': 이관·반환된 물건은 최근 1년 것만
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
      L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'lbl', html: `<i>${esc(p.name)}</i>`, iconSize: [0, 0] }), interactive: false, keyboard: false })
        .addTo(labelLayer);
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
    });
  }

  const badge = it => `<span class="badge ${it.status === 'keep' ? '' : it.status}">${STATUS[it.status]}</span>`;
  function lostRow(it) {
    const c = IDX.cat[it.cat] || { icon: '📦' };
    const p = it.place ? IDX.place[it.place] : null;
    // 원문에 표준 지점 이름이 그대로 들어 있으면 원문만, 아니면 "표준 지점 · 원문"
    const sq = s => String(s || '').replace(/\s+/g, '');
    const where = p ? (sq(it.place_raw).includes(sq(p.name)) ? it.place_raw : `${p.name} · ${it.place_raw}`) : (it.place_raw || '공원 내');
    return `<li><button class="item" type="button" data-id="${it.id}">
      <span class="ic">${c.icon}</span>
      <span class="tx"><span class="t1">${esc(it.name)}${it.qty && it.qty !== '1' ? ` <small>×${esc(it.qty)}</small>` : ''}</span>
        <span class="t2">${esc(where)}</span></span>
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
      html = cur.located.map(lostRow).join('') ||
        `<li class="empty">${vn ? '이 공연장 주변에서 그날 이후 접수된 습득물이 없습니다.<br>‘위치 불명’과 ‘가까운 역’ 탭도 확인해 보세요.' : '조건에 맞는 습득물이 없습니다.<br>기간을 넓히거나 ‘경찰서 이관 보기’를 켜 보세요.'}</li>`;
    } else if (state.tab === 'unknown') {
      desc = '“공원 내”처럼 지점이 적히지 않아 지도에 표시할 수 없는 물건입니다. 공원 어디서든 잃어버렸다면 함께 확인하세요.';
      html = cur.unknown.map(lostRow).join('') || '<li class="empty">위치 불명으로 접수된 습득물이 없습니다.</li>';
    } else {
      const s = state.station ? IDX.station[state.station] : null;
      desc = (s ? `<b>${esc(s.name)}</b>(${esc(s.lines)})에 보관 중인 습득물입니다. <a href="#" data-act="allStations">모든 역 보기</a>`
        : '공원 주변 지하철역에 보관 중인 습득물입니다(경찰청 습득물 정보). 주운 곳이 아니라 <b>보관 중인 역</b> 기준입니다.') +
        ' 이름 등 개인정보는 가렸습니다.';
      html = stItems.map(policeRow).join('') ||
        `<li class="empty">${!vn && !state.showStations ? '‘주변 역 습득물’을 켜면 표시됩니다.' : '조건에 맞는 역 보관 습득물이 없습니다.'}</li>`;
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
    const dow = new Date(ts(TODAY)).getUTCDay();
    const quick = [['오늘', 0], ['어제', 1], ['지난 토요일', ((dow + 1) % 7) || 7], ['지난 일요일', dow || 7], ['1주 전', 7], ['2주 전', 14], ['한 달 전', 30]];
    $('#quickDates').innerHTML = quick.map(([t, n]) => `<button class="chip" type="button" data-d="${addDays(TODAY, -n)}">${t}</button>`).join('');
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
    const shows = (D.shows.shows || []).filter(s => IDX.venue[s.venue]);
    const box = $('#showChips');
    box.hidden = !shows.length;
    if (!shows.length) return;
    box.innerHTML = '<span class="tg" style="flex:none;font-weight:700">최근 공연</span>' + shows.slice(0, 30).map((s, i) =>
      `<button class="chip" type="button" data-i="${i}" title="${esc(s.name)}">${esc(s.name.length > 18 ? s.name.slice(0, 17) + '…' : s.name)} <span class="n">${s.from.slice(5).replace('-', '.')}${s.to !== s.from ? '~' + s.to.slice(5).replace('-', '.') : ''}</span></button>`).join('');
    box.onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      const s = shows[+b.dataset.i];
      state.venueDate = s.from > TODAY ? TODAY : s.from; $('#venueDate').value = state.venueDate; markQuick();
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
  function showDlg(id, html) {
    const dlg = $(id);
    $(id === '#dlgItem' ? '#itemBody' : '#infoBody').innerHTML = `<div class="dlg-body">${html}</div>`;
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
      const overdue = TODAY > due;
      guide = `<div class="box go"><b>찾으러 가는 방법</b>
        <ol><li>먼저 ${center ? esc(center.name) : '안내센터'}에 전화해 물건이 맞는지 확인하세요.</li>
        <li><b>신분증</b>을 가지고 안내센터를 방문하세요. 본인 확인 뒤 돌려드립니다.</li>
        <li>운영 시간 09:00~19:00 (휴게 12:00~13:00)</li></ol></div>
        <div class="box${overdue ? ' warn' : ''}">습득일로부터 <b>1개월 보관</b> 후 관할 경찰서(송파경찰서)로 이관됩니다.<br>
        ${overdue ? `<b>보관 기간(${fmtDate(due)}까지)이 지났습니다.</b> 이미 이관됐을 수 있으니 방문 전에 꼭 전화로 확인하세요.`
          : `이 물건은 <b>${fmtDate(due)}</b> 무렵 이관될 수 있습니다(${dayDiff(due, TODAY)}일 남음).`}
        ${it.status === 'contacted' ? '<br>안내센터가 주인과 이미 연락한 물건입니다.' : ''}</div>`;
    }
    const tel = center && it.status !== 'returned' && it.status !== 'transferred'
      ? `<a class="btn" href="tel:${center.tel}">📞 ${esc(center.name)} ${esc(center.tel_text)}</a>` : '';
    const mapBtn = p ? `<button class="btn line" type="button" id="btnGo">지도에서 위치 보기</button>` : '';
    showDlg('#dlgItem', `
      <h2><span class="ic">${c.icon}</span>${esc(it.name)}</h2>
      <div class="meta">${badge(it)}<span class="badge returned">${esc(c.label)}</span><span style="font-size:13px;color:var(--ink-3)">${ago(it.date)} 습득</span></div>
      <dl class="kv">
        <dt>습득일</dt><dd>${fmtDate(it.date, true)}</dd>
        <dt>수량</dt><dd>${esc(it.qty || '1')}</dd>
        <dt>습득 장소</dt><dd>${esc(it.place_raw || '공원 내')}
          <small>${p ? `지도 지점: ${esc(p.name)} (${esc(p.zone)})${p.conf === 'high' ? '' : ' · 위치는 추정값'}` : '지점이 적히지 않아 지도에 표시할 수 없습니다(공원 전체).'}</small></dd>
        <dt>확인 방법</dt><dd>${esc(it.desc || '안내센터 문의')}<small>본인 확인에 쓰는 항목입니다.</small></dd>
        ${it.note ? `<dt>비고</dt><dd>${esc(it.note)}</dd>` : ''}
        <dt>보관</dt><dd>${center ? `${esc(center.name)}<small>${esc(center.tel_text)}</small>` : '올림픽공원 안내센터'}</dd>
      </dl>
      ${guide}${tel}${mapBtn}
      <p class="src">출처: 올림픽공원 유실물 정보(한국체육산업개발㈜, 문화공공데이터광장)${it.posted ? ` · ${it.posted} 게시` : ''}<br>
      사진은 제공되지 않습니다. 실제 보관 여부는 안내센터에 확인하세요.</p>`);
    const go = $('#btnGo');
    if (go) go.onclick = () => {
      $('#dlgItem').close();
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
      <p class="src">출처: 경찰청 포털기관 습득물정보(공공데이터포털). 품명에 들어 있는 이름·전화번호 등 개인정보는 가렸습니다.<br>
      역에서 일정 기간이 지나면 유실물센터나 경찰서로 옮겨질 수 있습니다.</p>`);
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
        <tr><th>지도</th><td>© OpenStreetMap 기여자 (ODbL)</td></tr>
      </table>
      <p>데이터는 하루 3번 자동으로 갱신됩니다. 실제 보관 여부는 반드시 안내센터에 전화로 확인하세요.</p>
      <h3>장소 사전 내려받기</h3>
      <p>습득 장소 표기를 표준 지점과 좌표로 정리한 사전을 공개합니다. 자유롭게 쓰셔도 됩니다.</p>
      <a class="btn line" href="data/places.csv" download="chajaolpak_places.csv">장소 사전(places.csv) 내려받기</a>
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
  function renderStats() {
    const all = D.lost.items.filter(it => it.date);
    const from = state.statsRange === 'year' ? addDays(TODAY, -365) : (state.statsRange === '2025' ? '2025-01-01' : '0000');
    const items = all.filter(it => it.date >= from);
    const n = items.length || 1;
    const held = all.filter(it => it.status === 'keep' || it.status === 'contacted').length;
    const done = items.filter(it => it.status === 'returned' || it.note.includes('연락')).length;
    const located = items.filter(it => it.place);
    const venueSet = new Set(D.base.venues.filter(v => v.id !== 'v_peace').flatMap(v => v.near));
    const nearVenue = located.filter(it => venueSet.has(it.place)).length;
    const byPlace = top(tally(located, it => IDX.place[it.place]?.name), 12);
    const byCat = top(tally(items, it => IDX.cat[it.cat]?.label), 12);
    const byZone = top(tally(located, it => IDX.place[it.place]?.zone), 8);
    const byCenter = top(tally(items, it => IDX.center[it.center]?.name), 2);
    const wd = tally(items, it => new Date(ts(it.date)).getUTCDay());
    const months = [];
    for (let i = 23; i >= 0; i--) { const d = new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1 - i, 1)); months.push(d.toISOString().slice(0, 7)); }
    const byMonth = tally(all, it => it.date.slice(0, 7));
    const mMax = Math.max(1, ...months.map(m => byMonth[m] || 0));
    const first = all.length ? all[all.length - 1].date.slice(0, 7) : '';
    $('#stats').innerHTML = `
      <div class="card"><h2>습득물 현황 요약</h2>
        <p class="sub">공원 운영 담당자를 위한 요약입니다. 올림픽공원 유실물 정보 ${first} ~ ${TODAY.slice(0, 7)} 습득물 ${all.length}건 기준.</p>
        <div class="seg small" role="group" aria-label="집계 기간">
          <button type="button" data-r="all" class="${state.statsRange === 'all' ? 'on' : ''}">전체 기간</button>
          <button type="button" data-r="2025" class="${state.statsRange === '2025' ? 'on' : ''}">2025년 이후</button>
          <button type="button" data-r="year" class="${state.statsRange === 'year' ? 'on' : ''}">최근 1년</button>
        </div></div>
      <div class="kpis">
        <div class="kpi"><b>${items.length}</b><span>습득물(선택 기간)</span></div>
        <div class="kpi"><b>${held}</b><span>지금 안내센터 보관 중</span></div>
        <div class="kpi"><b>${Math.round(done / n * 100)}%</b><span>반환·연락 완료 비율</span></div>
        <div class="kpi"><b>${Math.round(located.length / n * 100)}%</b><span>습득 지점이 기록된 비율</span></div>
      </div>
      <div class="card"><h2>습득이 많은 지점</h2><p class="sub">순찰·안내 표지 우선순위를 정할 때 참고할 수 있습니다.</p>${bars(byPlace) || '<p class="sub">자료 없음</p>'}</div>
      <div class="card"><h2>공연장 주변과 그 밖</h2><p class="sub">공연장(KSPO DOME, 핸드볼경기장, 올림픽홀, 우리금융아트홀, 88잔디마당 등) 반경 약 300m 안 지점 기준.</p>
        ${bars([['공연장 주변 지점', nearVenue], ['그 밖의 지점', located.length - nearVenue], ['위치 불명', items.length - located.length]], 'b2')}</div>
      <div class="card"><h2>품목</h2>${bars(byCat)}</div>
      <div class="card"><h2>월별 습득 건수 (최근 24개월)</h2>
        <div class="cols">${months.map(m => `<div class="c${(byMonth[m] || 0) === mMax ? ' hi' : ''}" style="height:${((byMonth[m] || 0) / mMax * 100).toFixed(1)}%" title="${m}: ${byMonth[m] || 0}건"></div>`).join('')}</div>
        <div class="cols-x"><span>${months[0]}</span><span>가장 많은 달 ${mMax}건</span><span>${months[23]}</span></div></div>
      <div class="card"><h2>요일</h2>${bars([1, 2, 3, 4, 5, 6, 0].map(d => [WD[d] + '요일', wd[d] || 0]), 'b3')}</div>
      <div class="card"><h2>구역 · 접수 안내센터</h2>${bars(byZone)}<div style="height:10px"></div>${bars(byCenter, 'b2')}</div>
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
    initMap(); initSheet(); initFilters();
    $('#btnInfo').addEventListener('click', openInfo);
    $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
    window.addEventListener('resize', () => { layoutPanel(); map.invalidateSize(); });
    render();
    map.whenReady(() => { placeAttribution(); });
  }
  start();
})();
