const canvas = document.getElementById('radar');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const statusText = document.getElementById('statusText');
const centerInfo = document.getElementById('centerInfo');

const aircraftTableBody = document.getElementById('aircraftTableBody');

const detailModal = document.getElementById('detailModal');
const detailClose = document.getElementById('detailClose');
const detailPhotoWrap = document.getElementById('detailPhotoWrap');
const detailTitle = document.getElementById('detailTitle');
const detailSubtitle = document.getElementById('detailSubtitle');
const detailRoute = document.getElementById('detailRoute');
const detailGrid = document.getElementById('detailGrid');
const detailPhotoCredit = document.getElementById('detailPhotoCredit');

const detailLinks = document.getElementById('detailLinks');

const statsBar = document.getElementById('statsBar');
const tableFilter = document.getElementById('tableFilter');
const zoomBadge = document.getElementById('zoomBadge');

const settingsPanel = document.getElementById('settingsPanel');
const settingsBtn = document.getElementById('settingsBtn');
const closeBtn = document.getElementById('closeBtn');
const saveBtn = document.getElementById('saveBtn');
const locateBtn = document.getElementById('locateBtn');
const settingsMsg = document.getElementById('settingsMsg');
const latInput = document.getElementById('latInput');
const lonInput = document.getElementById('lonInput');
const radiusInput = document.getElementById('radiusInput');
const radiusValue = document.getElementById('radiusValue');
const radiusKm = document.getElementById('radiusKm');

let center = { lat: 0, lon: 0, radiusNm: 50 };
let aircraftList = [];
let planeShapes = []; // wyliczone pozycje na kanwie, do trafien mysza
let selectedHex = null;
let filterText = '';

const NM_TO_KM = 1.852;
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

// --- Zoom widoku (scroll = przyblizenie w ramach juz pobranych danych) ---
let viewRadiusNm = null;
let lastFetchedRadiusNm = null;

function setViewRadius(nm) {
  viewRadiusNm = Math.min(center.radiusNm, Math.max(3, nm));
  zoomBadge.textContent = `Zoom: ${Math.round(viewRadiusNm)} NM (scroll = przyblizenie, dwuklik = reset)`;
  zoomBadge.classList.toggle('hidden', Math.round(viewRadiusNm) === Math.round(center.radiusNm));
  drawRadar();
}

// --- Slady lotu (ostatnie pozycje wzgledem obserwatora) ---
const trails = new Map(); // hex -> [{dst, dir}, ...]
const TRAIL_MAX = 12;

function updateTrails(list) {
  const seen = new Set();
  for (const ac of list) {
    if (typeof ac.dst !== 'number' || typeof ac.dir !== 'number') continue;
    seen.add(ac.hex);
    const arr = trails.get(ac.hex) || [];
    arr.push({ dst: ac.dst, dir: ac.dir });
    if (arr.length > TRAIL_MAX) arr.shift();
    trails.set(ac.hex, arr);
  }
  for (const hex of [...trails.keys()]) {
    if (!seen.has(hex)) trails.delete(hex);
  }
}

// --- Statystyki sesji (licza sie od otwarcia strony) ---
const sessionStats = { seenHex: new Set(), maxAlt: 0, maxGs: 0, maxDst: 0 };

function updateSessionStats(list) {
  for (const ac of list) {
    sessionStats.seenHex.add(ac.hex);
    if (typeof ac.alt_baro === 'number') sessionStats.maxAlt = Math.max(sessionStats.maxAlt, ac.alt_baro);
    if (typeof ac.gs === 'number') sessionStats.maxGs = Math.max(sessionStats.maxGs, ac.gs);
    if (typeof ac.dst === 'number') sessionStats.maxDst = Math.max(sessionStats.maxDst, ac.dst);
  }
}

function renderStats(list) {
  const tiles = [
    ['W zasiegu teraz', list.length],
    ['Widziane w tej sesji', sessionStats.seenHex.size],
    ['Max wysokosc', `${sessionStats.maxAlt || 0} ft`],
    ['Max predkosc', `${Math.round(sessionStats.maxGs || 0)} kt`],
    ['Max zasieg', `${sessionStats.maxDst.toFixed(1) || 0} NM`],
  ];
  statsBar.innerHTML = tiles
    .map(([label, value]) => `<div class="stat-tile"><strong>${value}</strong>${label}</div>`)
    .join('');
}

function verticalTrend(ac) {
  const vr = ac.baro_rate ?? ac.geom_rate;
  if (typeof vr !== 'number') return '–';
  if (vr > 150) return `▲ ${Math.round(vr)}`;
  if (vr < -150) return `▼ ${Math.round(vr)}`;
  return '─ 0';
}

function flagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '';
  return countryCode
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

function resizeCanvasForDpr() {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function altColor(altFt) {
  if (altFt == null || altFt === 'ground') return '#6fa98a';
  if (altFt < 5000) return '#39ff8a';
  if (altFt < 20000) return '#ffcf4d';
  return '#ff6a5a';
}

// Kategorie ADS-B (DO-260B): A*=samoloty, B1=szybowiec, B2=balon, B6=dron/UAV,
// C*=pojazd naziemny, A7=smiglowiec. Rysujemy rozne ksztalty zamiast jednego trojkata.
function drawAircraftIcon(ctx2, category, heading, color) {
  ctx2.fillStyle = color;
  ctx2.strokeStyle = color;

  if (category === 'A7') {
    // smiglowiec: kadlub + wirnik
    ctx2.beginPath();
    ctx2.arc(0, 0, 4, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.lineWidth = 1.5;
    ctx2.beginPath();
    ctx2.moveTo(-9, 0);
    ctx2.lineTo(9, 0);
    ctx2.moveTo(0, -9);
    ctx2.lineTo(0, 9);
    ctx2.stroke();
    return;
  }

  if (category && category[0] === 'C') {
    // pojazd naziemny: kwadrat
    ctx2.fillRect(-5, -5, 10, 10);
    return;
  }

  if (category === 'B6') {
    // dron/UAV: romb
    ctx2.beginPath();
    ctx2.moveTo(0, -7);
    ctx2.lineTo(7, 0);
    ctx2.lineTo(0, 7);
    ctx2.lineTo(-7, 0);
    ctx2.closePath();
    ctx2.fill();
    return;
  }

  if (category === 'B2' || category === 'B1') {
    // balon / szybowiec: kolko
    ctx2.beginPath();
    ctx2.arc(0, 0, 6, 0, Math.PI * 2);
    ctx2.fill();
    return;
  }

  // domyslnie: samolot (trojkat), obrocony wg kursu
  ctx2.save();
  ctx2.rotate((heading * Math.PI) / 180);
  ctx2.beginPath();
  ctx2.moveTo(0, -7);
  ctx2.lineTo(5, 6);
  ctx2.lineTo(0, 3);
  ctx2.lineTo(-5, 6);
  ctx2.closePath();
  ctx2.fill();
  ctx2.restore();
}

// --- Mapa w tle (kafelki OpenStreetMap) ---

const TILE_SIZE = 256;
let mapLayer = null; // offscreen canvas z zbudowana mapka
let mapLayerKey = '';
let mapBuildToken = 0;

function lon2worldX(lon, zoom) {
  return ((lon + 180) / 360) * TILE_SIZE * Math.pow(2, zoom);
}
function lat2worldY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    TILE_SIZE *
    Math.pow(2, zoom)
  );
}

function loadImage(src, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (result) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = src;
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function buildMapLayer(size, R, lat, lon, radiusNm) {
  const token = ++mapBuildToken;
  const metersPerPixel = (radiusNm * 1852) / R;
  const latRad = (lat * Math.PI) / 180;
  const zoomFloat = Math.log2((156543.03392 * Math.cos(latRad)) / metersPerPixel);
  const zoom = Math.min(16, Math.max(2, Math.round(zoomFloat)));
  const metersPerPixelAtZoom = (156543.03392 * Math.cos(latRad)) / Math.pow(2, zoom);
  const pxScale = metersPerPixelAtZoom / metersPerPixel;

  const centerWx = lon2worldX(lon, zoom);
  const centerWy = lat2worldY(lat, zoom);
  const half = size / 2;

  const worldMinX = centerWx + (0 - half) / pxScale;
  const worldMaxX = centerWx + (size - half) / pxScale;
  const worldMinY = centerWy + (0 - half) / pxScale;
  const worldMaxY = centerWy + (size - half) / pxScale;

  const maxTileIndex = Math.pow(2, zoom) - 1;
  const tileMinX = Math.max(0, Math.floor(worldMinX / TILE_SIZE));
  const tileMaxX = Math.min(maxTileIndex, Math.floor(worldMaxX / TILE_SIZE));
  const tileMinY = Math.max(0, Math.floor(worldMinY / TILE_SIZE));
  const tileMaxY = Math.min(maxTileIndex, Math.floor(worldMaxY / TILE_SIZE));

  const jobs = [];
  for (let tx = tileMinX; tx <= tileMaxX; tx++) {
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
      // Esri uzywa kolejnosci z/y/x (wiersz przed kolumna)
      const baseUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${zoom}/${ty}/${tx}`;
      const refUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/${zoom}/${ty}/${tx}`;
      jobs.push(
        Promise.all([loadImage(baseUrl), loadImage(refUrl)]).then(([base, ref]) => ({
          base,
          ref,
          tx,
          ty,
        }))
      );
    }
  }

  const tiles = await Promise.all(jobs);
  if (token !== mapBuildToken) return null; // w miedzyczasie ruszyl nowszy build

  const layer = document.createElement('canvas');
  layer.width = size;
  layer.height = size;
  const lc = layer.getContext('2d');
  lc.fillStyle = '#04150d';
  lc.fillRect(0, 0, size, size);

  for (const { base, tx, ty } of tiles) {
    if (!base) continue;
    const drawX = half + (tx * TILE_SIZE - centerWx) * pxScale;
    const drawY = half + (ty * TILE_SIZE - centerWy) * pxScale;
    const drawSize = TILE_SIZE * pxScale;
    lc.drawImage(base, drawX, drawY, drawSize, drawSize);
  }
  // etykiety (nazwy miast, granice) z warstwy referencyjnej na wierzchu bazy
  for (const { ref, tx, ty } of tiles) {
    if (!ref) continue;
    const drawX = half + (tx * TILE_SIZE - centerWx) * pxScale;
    const drawY = half + (ty * TILE_SIZE - centerWy) * pxScale;
    const drawSize = TILE_SIZE * pxScale;
    lc.drawImage(ref, drawX, drawY, drawSize, drawSize);
  }

  // delikatny zielony odcien, zeby pasowalo do stylistyki radaru (mapa juz jest ciemna)
  lc.fillStyle = 'rgba(10, 40, 25, 0.25)';
  lc.fillRect(0, 0, size, size);

  return layer;
}

function ensureMapLayer() {
  const size = canvas.clientWidth;
  if (!size || !center.lat) return;
  const key = `${center.lat.toFixed(4)}:${center.lon.toFixed(4)}:${center.radiusNm}:${size}`;
  if (key === mapLayerKey) return;
  mapLayerKey = key;
  const R = size / 2 - 30;
  buildMapLayer(size, R, center.lat, center.lon, center.radiusNm).then((layer) => {
    if (layer) {
      mapLayer = layer;
      drawRadar();
    }
  });
}

function drawRadar() {
  const size = canvas.clientWidth;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 30;

  ctx.clearRect(0, 0, size, size);

  const vr = viewRadiusNm || center.radiusNm;
  const zoomFactor = center.radiusNm / vr; // >1 gdy przyblizamy scrollem

  if (mapLayer) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    const scaledSize = size * zoomFactor;
    const offset = (size - scaledSize) / 2;
    ctx.drawImage(mapLayer, 0, 0, size, size, offset, offset, scaledSize, scaledSize);
    ctx.restore();
  }

  // pierscienie
  ctx.strokeStyle = '#1f6b43';
  ctx.fillStyle = '#6fa98a';
  ctx.font = '11px monospace';
  ctx.lineWidth = 1;
  const rings = 4;
  for (let i = 1; i <= rings; i++) {
    const r = (R * i) / rings;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    const nm = Math.round((vr * i) / rings);
    ctx.fillText(`${nm}NM`, cx + 4, cy - r + 12);
  }

  // kierunki
  ctx.fillStyle = '#39ff8a';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy - R - 10);
  ctx.fillText('S', cx, cy + R + 20);
  ctx.fillText('E', cx + R + 14, cy + 4);
  ctx.fillText('W', cx - R - 14, cy + 4);

  // linie krzyza
  ctx.strokeStyle = '#123a28';
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();

  // srodek (obserwator)
  ctx.fillStyle = '#39ff8a';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  planeShapes = [];

  const toXY = (dst, dir) => {
    const r = Math.min(dst / vr, 1) * R;
    const angle = ((dir - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  };

  for (const ac of aircraftList) {
    if (typeof ac.dst !== 'number' || typeof ac.dir !== 'number') continue;
    if (ac.dst > vr) continue; // poza biezacym przyblizeniem

    const { x, y } = toXY(ac.dst, ac.dir);

    // slad - ostatnie znane pozycje tego samolotu
    const trail = trails.get(ac.hex);
    if (trail && trail.length > 1) {
      ctx.beginPath();
      trail.forEach((p, i) => {
        if (p.dst > vr) return;
        const tp = toXY(p.dst, p.dir);
        if (i === 0) ctx.moveTo(tp.x, tp.y);
        else ctx.lineTo(tp.x, tp.y);
      });
      ctx.strokeStyle = 'rgba(57, 255, 138, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const heading = ac.track ?? ac.true_heading ?? ac.mag_heading ?? 0;
    const color = altColor(ac.alt_baro);
    const isEmergency = EMERGENCY_SQUAWKS.has(ac.squawk);

    if (ac.hex === selectedHex || isEmergency) {
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = isEmergency ? '#ff6a5a' : '#39ff8a';
      ctx.lineWidth = isEmergency ? 2 : 1.5;
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(x, y);
    drawAircraftIcon(ctx, ac.category, heading, color);
    ctx.restore();

    const label = (ac.flight || ac.hex || '?').trim();
    ctx.fillStyle = color;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 8, y - 6);

    const altText = typeof ac.alt_baro === 'number' ? `FL${Math.round(ac.alt_baro / 100)}` : '';
    const infoLine = [ac.t, altText].filter(Boolean).join(' ');
    if (infoLine) {
      ctx.fillStyle = '#6fa98a';
      ctx.fillText(infoLine, x + 8, y + 6);
    }

    planeShapes.push({ x, y, ac });
  }
}

function render() {
  resizeCanvasForDpr();
  ensureMapLayer();
  drawRadar();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderTable(list) {
  if (!list.length) {
    aircraftTableBody.innerHTML = '<tr class="empty-row"><td colspan="8">brak samolotow w zasiegu</td></tr>';
    return;
  }
  const sorted = [...list].sort((a, b) => (a.dst ?? 1e9) - (b.dst ?? 1e9));
  aircraftTableBody.innerHTML = sorted
    .map((ac, i) => {
      const color = altColor(ac.alt_baro);
      const flight = escapeHtml((ac.flight || ac.hex || '?').trim());
      const type = escapeHtml(ac.t || '-');
      const alt = ac.alt_baro === 'ground' ? 'ziemia' : ac.alt_baro ?? '-';
      const vs = verticalTrend(ac);
      const gs = ac.gs != null ? Math.round(ac.gs) : '-';
      const track = ac.track != null ? `${Math.round(ac.track)}&deg;` : '-';
      const dst = ac.dst != null ? ac.dst.toFixed(1) : '-';
      const squawk = escapeHtml(ac.squawk || '-');
      const rowClass = ['selectable', EMERGENCY_SQUAWKS.has(ac.squawk) ? 'emergency' : '']
        .filter(Boolean)
        .join(' ');
      return `<tr style="color:${color}" class="${rowClass}" data-idx="${i}"><td>${flight}</td><td>${type}</td><td>${alt}</td><td>${vs}</td><td>${gs}</td><td>${track}</td><td>${dst}</td><td>${squawk}</td></tr>`;
    })
    .join('');

  aircraftTableBody.querySelectorAll('tr[data-idx]').forEach((row) => {
    row.addEventListener('click', () => openDetail(sorted[Number(row.dataset.idx)]));
  });
}

function applyFilterAndRenderTable() {
  if (!filterText) {
    renderTable(aircraftList);
    return;
  }
  const needle = filterText.toLowerCase();
  const filtered = aircraftList.filter((ac) =>
    [ac.flight, ac.t, ac.desc, ac.squawk, ac.hex]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle))
  );
  renderTable(filtered);
}

async function pollAircraft() {
  try {
    const res = await fetch('/api/aircraft');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    center = data.center;
    aircraftList = data.aircraft || [];

    if (center.radiusNm !== lastFetchedRadiusNm) {
      lastFetchedRadiusNm = center.radiusNm;
      viewRadiusNm = center.radiusNm;
      zoomBadge.classList.add('hidden');
    }

    updateTrails(aircraftList);
    updateSessionStats(aircraftList);
    renderStats(aircraftList);

    statusText.textContent = `samoloty: ${aircraftList.length} | ${new Date().toLocaleTimeString()}`;
    centerInfo.textContent = `${center.city || ''} (${center.lat.toFixed(3)}, ${center.lon.toFixed(3)}) | promien ${center.radiusNm} NM`;
    render();
    applyFilterAndRenderTable();
  } catch (err) {
    statusText.textContent = `blad polaczenia z adsb.fi (${err.message})`;
  }
}

canvas.addEventListener('mousemove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  let hit = null;
  for (const p of planeShapes) {
    if (Math.hypot(p.x - mx, p.y - my) < 10) {
      hit = p;
      break;
    }
  }
  if (hit) {
    const ac = hit.ac;
    tooltip.textContent = [
      `Lot: ${(ac.flight || ac.hex || '?').trim()}`,
      `Typ: ${ac.t || '-'} (${ac.desc || '-'})`,
      `Alt: ${ac.alt_baro ?? '-'} ft`,
      `Predkosc: ${ac.gs ?? '-'} kt`,
      `Odleglosc: ${ac.dst?.toFixed(1) ?? '-'} NM`,
      `Squawk: ${ac.squawk ?? '-'}`,
    ].join('\n');
    tooltip.style.left = `${ev.clientX}px`;
    tooltip.style.top = `${ev.clientY}px`;
    tooltip.classList.remove('hidden');
  } else {
    tooltip.classList.add('hidden');
  }
});

canvas.addEventListener('click', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  for (const p of planeShapes) {
    if (Math.hypot(p.x - mx, p.y - my) < 10) {
      openDetail(p.ac);
      return;
    }
  }
});

canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const base = viewRadiusNm || center.radiusNm;
    const factor = ev.deltaY < 0 ? 0.85 : 1 / 0.85;
    setViewRadius(base * factor);
  },
  { passive: false }
);

canvas.addEventListener('dblclick', () => setViewRadius(center.radiusNm));

tableFilter.addEventListener('input', () => {
  filterText = tableFilter.value.trim();
  applyFilterAndRenderTable();
});

window.addEventListener('resize', render);

// --- Panel szczegolow samolotu (trasa, rejestracja, zdjecie) ---

function detailRow(label, value) {
  return `<div><span class="k">${label}</span><span>${value}</span></div>`;
}

function sourceLabel(ac) {
  if (ac.type === 'mlat' || (ac.mlat && ac.mlat.length)) return 'MLAT (multilateracja)';
  if (ac.type && ac.type.startsWith('tisb')) return 'TIS-B';
  if (ac.type && ac.type.startsWith('adsb')) return 'ADS-B (bezposrednio)';
  return ac.type || '-';
}

function fillBasicDetail(ac) {
  detailTitle.textContent = (ac.flight || ac.hex || '?').trim();
  detailSubtitle.textContent = [ac.t, ac.desc].filter(Boolean).join(' · ') || 'ladowanie danych samolotu...';
  detailRoute.textContent = 'trasa: sprawdzanie...';

  const rows = [
    detailRow('Wysokosc', ac.alt_baro === 'ground' ? 'ziemia' : `${ac.alt_baro ?? '-'} ft`),
    detailRow('Pion. predkosc', verticalTrend(ac)),
    detailRow('Predkosc', `${ac.gs ?? '-'} kt`),
    detailRow('Kurs', ac.track != null ? `${Math.round(ac.track)}&deg;` : '-'),
    detailRow('Odleglosc', ac.dst != null ? `${ac.dst.toFixed(1)} NM` : '-'),
    detailRow('Squawk', ac.squawk || '-'),
  ];
  if (typeof ac.ws === 'number') {
    rows.push(detailRow('Wiatr na wys.', `${Math.round(ac.wd ?? 0)}&deg; / ${Math.round(ac.ws)} kt`));
  }
  if (typeof ac.oat === 'number') {
    rows.push(detailRow('Temp. zewn.', `${Math.round(ac.oat)}&deg;C`));
  }
  if (typeof ac.mach === 'number') {
    rows.push(detailRow('Mach', ac.mach.toFixed(2)));
  }
  rows.push(
    detailRow('Zrodlo danych', sourceLabel(ac)),
    detailRow('Sygnal (RSSI)', typeof ac.rssi === 'number' ? `${ac.rssi} dBFS` : '-'),
    detailRow('Hex', ac.hex || '-'),
    detailRow('Pozycja', `${ac.lat?.toFixed(3) ?? '-'}, ${ac.lon?.toFixed(3) ?? '-'}`)
  );
  detailGrid.innerHTML = rows.join('');

  const flightTrim = (ac.flight || '').trim();
  const links = [`<a href="https://globe.adsbexchange.com/?icao=${ac.hex}" target="_blank" rel="noopener">ADS-B Exchange</a>`];
  if (flightTrim) {
    links.push(
      `<a href="https://flightaware.com/live/flight/${encodeURIComponent(flightTrim)}" target="_blank" rel="noopener">FlightAware</a>`
    );
  }
  detailLinks.innerHTML = links.join('');

  detailPhotoWrap.innerHTML = '';
  detailPhotoCredit.innerHTML = '';
}

function fillRouteAndExtras(ac, d) {
  const reg = d.reg;
  const dep = d.dep;
  const arr = d.arr;
  const photo = d.photo;

  const subtitleParts = [];
  if (reg && reg.Registration) subtitleParts.push(reg.Registration);
  if (reg && (reg.RegisteredOwners || ac.r)) subtitleParts.push(reg.RegisteredOwners || ac.r);
  subtitleParts.push((reg && reg.Type) || ac.desc || ac.t);
  detailSubtitle.textContent = subtitleParts.filter(Boolean).join(' · ');

  if (dep && arr) {
    detailRoute.innerHTML = `${flagEmoji(dep.country_code)} <strong>${escapeHtml(dep.iata || dep.icao)}</strong> ${escapeHtml(dep.airport)} &rarr; ${flagEmoji(arr.country_code)} <strong>${escapeHtml(arr.iata || arr.icao)}</strong> ${escapeHtml(arr.airport)}`;
  } else {
    detailRoute.textContent = 'trasa nieznana (brak w bazie)';
  }

  if (photo) {
    const img = new Image();
    img.src = photo.thumbnail_large?.src || photo.thumbnail?.src;
    img.alt = 'Zdjecie samolotu';
    detailPhotoWrap.innerHTML = '';
    detailPhotoWrap.appendChild(img);
    detailPhotoCredit.innerHTML = `fot. ${escapeHtml(photo.photographer || '-')} &middot; <a href="${photo.link}" target="_blank" rel="noopener">planespotters.net</a>`;
  }
}

async function openDetail(ac) {
  selectedHex = ac.hex;
  detailModal.classList.remove('hidden');
  fillBasicDetail(ac);
  drawRadar();
  try {
    const res = await fetch(
      `/api/details?hex=${encodeURIComponent(ac.hex)}&flight=${encodeURIComponent((ac.flight || '').trim())}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    fillRouteAndExtras(ac, d);
  } catch (err) {
    detailRoute.textContent = `nie udalo sie pobrac dodatkowych danych (${err.message})`;
  }
}

function closeDetail() {
  detailModal.classList.add('hidden');
  selectedHex = null;
  drawRadar();
}

detailClose.addEventListener('click', closeDetail);
detailModal.addEventListener('click', (ev) => {
  if (ev.target === detailModal) closeDetail();
});

// --- Ustawienia ---

async function loadSettingsIntoForm() {
  const res = await fetch('/api/settings');
  const cfg = await res.json();
  latInput.value = cfg.lat;
  lonInput.value = cfg.lon;
  radiusInput.value = cfg.radiusNm;
  radiusValue.textContent = cfg.radiusNm;
  radiusKm.textContent = Math.round(cfg.radiusNm * NM_TO_KM);
}

radiusInput.addEventListener('input', () => {
  radiusValue.textContent = radiusInput.value;
  radiusKm.textContent = Math.round(radiusInput.value * NM_TO_KM);
});

settingsBtn.addEventListener('click', async () => {
  await loadSettingsIntoForm();
  settingsPanel.classList.remove('hidden');
});
closeBtn.addEventListener('click', () => settingsPanel.classList.add('hidden'));

locateBtn.addEventListener('click', async () => {
  settingsMsg.textContent = 'wykrywanie lokalizacji...';
  try {
    const res = await fetch('/api/locate', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const loc = await res.json();
    latInput.value = loc.lat;
    lonInput.value = loc.lon;
    settingsMsg.textContent = `wykryto: ${loc.city || ''} (${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)})`;
  } catch (err) {
    settingsMsg.textContent = `blad wykrywania: ${err.message}`;
  }
});

saveBtn.addEventListener('click', async () => {
  const body = {
    lat: parseFloat(latInput.value),
    lon: parseFloat(lonInput.value),
    radiusNm: parseFloat(radiusInput.value),
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    settingsMsg.textContent = 'zapisano.';
    settingsPanel.classList.add('hidden');
    pollAircraft();
  } catch (err) {
    settingsMsg.textContent = `blad zapisu: ${err.message}`;
  }
});

render();
pollAircraft();
setInterval(pollAircraft, 4000);
