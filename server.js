const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function fetchJson(url, headers = {}) {
  const mod = url.startsWith('http://') ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} z ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Prosty cache, zeby respektowac limit adsb.fi (1 req/s) niezaleznie od tego,
// jak czesto odpytuje frontend.
let aircraftCache = { key: '', data: null, ts: 0 };
const AIRCRAFT_TTL_MS = 3000;

async function getAircraft(lat, lon, radiusNm) {
  const key = `${lat}:${lon}:${radiusNm}`;
  const now = Date.now();
  if (aircraftCache.key === key && now - aircraftCache.ts < AIRCRAFT_TTL_MS) {
    return aircraftCache.data;
  }
  const url = `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radiusNm}`;
  const json = await fetchJson(url);
  aircraftCache = { key, data: json, ts: now };
  return json;
}

// Dane o trasie/samolocie/zdjeciu zmieniaja sie rzadko -> cachujemy per-hex na dluzej.
const detailsCache = new Map();
const DETAILS_TTL_MS = 10 * 60 * 1000;

async function fetchAirport(icao) {
  if (!icao) return null;
  try {
    return await fetchJson(`https://hexdb.io/api/v1/airport/icao/${encodeURIComponent(icao)}`);
  } catch {
    return null;
  }
}

async function getDetails(hex, flight) {
  const cached = detailsCache.get(hex);
  if (cached && Date.now() - cached.ts < DETAILS_TTL_MS) {
    return cached.data;
  }

  let dep = null;
  let arr = null;
  const flightTrim = (flight || '').trim();
  if (flightTrim) {
    try {
      const route = await fetchJson(
        `https://hexdb.io/api/v1/route/icao/${encodeURIComponent(flightTrim)}`
      );
      if (route && route.route) {
        const [depIcao, arrIcao] = route.route.split('-');
        [dep, arr] = await Promise.all([fetchAirport(depIcao), fetchAirport(arrIcao)]);
      }
    } catch {
      // brak trasy w bazie - trudno, lecimy bez niej
    }
  }

  let reg = null;
  try {
    reg = await fetchJson(`https://hexdb.io/api/v1/aircraft/${encodeURIComponent(hex)}`);
  } catch {
    reg = null;
  }

  let photo = null;
  try {
    const ps = await fetchJson(`https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex)}`, {
      'User-Agent': 'ADSB-Radar-Sim/1.0 (local hobby project; contact: tomasz.wojcik@sqn.pl)',
    });
    photo = (ps.photos && ps.photos[0]) || null;
  } catch {
    photo = null;
  }

  const data = { dep, arr, reg, photo };
  detailsCache.set(hex, { ts: Date.now(), data });
  return data;
}

async function locateByIp() {
  // Wykrywanie polozenia po publicznym IP serwera (czyli uzytkownika, gdy dziala lokalnie).
  const json = await fetchJson('http://ip-api.com/json/');
  if (!json || json.status !== 'success') {
    throw new Error('Nie udalo sie wykryc lokalizacji po IP');
  }
  return {
    lat: json.lat,
    lon: json.lon,
    city: [json.city, json.country].filter(Boolean).join(', '),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, 'http://internal');

    if (parsedUrl.pathname === '/api/details' && req.method === 'GET') {
      const hex = parsedUrl.searchParams.get('hex');
      const flight = parsedUrl.searchParams.get('flight') || '';
      if (!hex) {
        sendJson(res, 400, { error: 'brak hex' });
        return;
      }
      const details = await getDetails(hex, flight);
      sendJson(res, 200, details);
      return;
    }

    if (req.url === '/api/settings' && req.method === 'GET') {
      sendJson(res, 200, readConfig());
      return;
    }

    if (req.url === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const cfg = readConfig();
      if (typeof body.lat === 'number') cfg.lat = body.lat;
      if (typeof body.lon === 'number') cfg.lon = body.lon;
      if (typeof body.radiusNm === 'number') {
        cfg.radiusNm = Math.min(250, Math.max(1, body.radiusNm));
      }
      if (typeof body.city === 'string') cfg.city = body.city;
      writeConfig(cfg);
      sendJson(res, 200, cfg);
      return;
    }

    if (req.url === '/api/locate' && req.method === 'POST') {
      const loc = await locateByIp();
      sendJson(res, 200, loc);
      return;
    }

    if (req.url === '/api/aircraft' && req.method === 'GET') {
      const cfg = readConfig();
      const json = await getAircraft(cfg.lat, cfg.lon, cfg.radiusNm);
      sendJson(res, 200, {
        now: json.now,
        center: { lat: cfg.lat, lon: cfg.lon, radiusNm: cfg.radiusNm, city: cfg.city },
        aircraft: json.aircraft || [],
      });
      return;
    }

    if (req.url.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    serveStatic(req, res);
  } catch (err) {
    sendJson(res, 502, { error: err.message || 'blad serwera' });
  }
});

server.listen(PORT, () => {
  console.log(`ADSB radar sim: http://localhost:${PORT}`);
});
