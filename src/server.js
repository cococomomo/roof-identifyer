/**
 * server.js
 *
 * Express web server for the Trafo capacity dashboard.
 * Serves the map dashboard, exposes JSON API endpoints, and runs an automatic
 * 90-day cron scan with email notification when new green trafos appear.
 *
 * Usage: npm start   or   node src/server.js
 */

require('./load-env');
const { ensureDataDir, migrateFromAppDataIfNeeded } = require('./resolve-data-dir');
const express      = require('express');
const fs           = require('fs');
const path         = require('path');
const cron         = require('node-cron');
const nodemailer   = require('nodemailer');
const { google }   = require('googleapis');
const { execSync, execFileSync, spawn } = require('child_process');

const turf         = require('@turf/turf');
const { scanTrafos }  = require('./trafo-scanner');
const { compareScans } = require('./compare-scans');
const crm = require('./crm-core');
const { registerCrmRoutes } = require('./crm-routes');
const {
  formatAddressFromOsmTags,
  isMissingOrPlaceholderAddress,
  reverseGeocodeLatLng,
} = require('./nominatim-helpers');

// ─── Spatial helpers ──────────────────────────────────────────────────────────
function inBbox(lat, lng, north, south, east, west) {
  return lat <= north && lat >= south && lng <= east && lng >= west;
}
function distM(a, b) {
  const R = 6371000, dLat = (b.lat-a.lat)*Math.PI/180, dLng = (b.lng-a.lng)*Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function nearestCentroid(lat, lng, centroids) {
  let best = centroids[0], bestD = Infinity;
  for (const c of centroids) {
    const d = distM({lat,lng}, {lat:c.lat,lng:c.lng});
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT          = process.env.PORT || 3007;
const DATA_DIR      = ensureDataDir();
process.env.DATA_DIR = DATA_DIR;
migrateFromAppDataIfNeeded();
const SCANS_DIR     = path.join(DATA_DIR, 'scans');
const LATEST        = path.join(DATA_DIR, 'trafos-latest.json');

// Background Trafo full-scan (started from admin UI; avoids nginx/proxy timeouts)
let _trafoScanJob = {
  running: false, startedAt: null, finishedAt: null, exitCode: null, pid: null, logTail: '', error: null,
};
const OPP_FILE      = path.join(DATA_DIR, 'opportunities.json');
const BEZIRKE_FILE  = path.join(DATA_DIR, 'bezirke-noe.json');
const PUBLIC        = path.join(__dirname, '..', 'public');

// Pre-load Bezirk centroids
const BEZIRKE = fs.existsSync(BEZIRKE_FILE) ? JSON.parse(fs.readFileSync(BEZIRKE_FILE)) : [];

const GEMEINDEN_FILE = path.join(DATA_DIR, 'gemeinden-noe.json');
let _gemData = null; // { fc, centroids } | false

function loadGemeindeIndex() {
  if (_gemData !== null) return _gemData;
  if (!fs.existsSync(GEMEINDEN_FILE)) { _gemData = false; return _gemData; }
  const fc = JSON.parse(fs.readFileSync(GEMEINDEN_FILE, 'utf8'));
  const centroids = (fc.features || []).map(f => ({
    g_id:   f.properties.g_id,
    g_name: f.properties.g_name,
    c:      turf.centroid(f),
    f,
  }));
  _gemData = { fc, centroids };
  return _gemData;
}

function findGemeindeWithFeature(lat, lng) {
  const g = loadGemeindeIndex();
  if (!g) return null;
  const pt = turf.point([lng, lat]);
  for (const f of g.fc.features) {
    try {
      if (turf.booleanPointInPolygon(pt, f)) {
        return { g_id: f.properties.g_id, g_name: f.properties.g_name, feature: f };
      }
    } catch (e) { /* invalid geom */ }
  }
  let bestC = null, bestD = Infinity;
  for (const c of g.centroids) {
    const d = turf.distance(pt, c.c, { units: 'kilometers' });
    if (d < bestD) { bestD = d; bestC = c; }
  }
  if (!bestC) return null;
  return { g_id: bestC.g_id, g_name: bestC.g_name, feature: bestC.f };
}

function nearestTrafoTo(lat, lng) {
  if (!fs.existsSync(LATEST)) return null;
  const { trafos } = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
  if (!trafos || !trafos.length) return null;
  let best = null, bestD = Infinity;
  for (const t of trafos) {
    if (t.lat == null || t.lng == null) continue;
    const d = distM({ lat, lng }, { lat: t.lat, lng: t.lng });
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

function trafoTstLabel(t) {
  if (!t) return 'TST-?';
  if (t.name && String(t.name).includes('TST')) return t.name;
  if (t.tst_id != null) return 'TST-' + t.tst_id;
  return 'TST-?';
}

function buildNewProjectFields(lat, lng, leads) {
  const gem = findGemeindeWithFeature(lat, lng);
  const gName = gem && gem.g_name ? gem.g_name : 'unbekannt';
  const gId   = gem && gem.g_id ? gem.g_id : '?';
  const trafo = nearestTrafoTo(lat, lng);
  const tid   = trafo && trafo.tst_id != null ? String(trafo.tst_id) : '0';
  const tstL  = trafoTstLabel(trafo);
  const namingKey = gId + '|' + tid;
  let maxL = 0;
  for (const l of leads) {
    if (l.naming_key === namingKey && (l.local_seq || 0) > maxL) maxL = l.local_seq;
  }
  const localSeq  = maxL + 1;
  const name        = gName + '_' + tstL + '_' + String(localSeq).padStart(3, '0');
  const projectNr  = leads.reduce((m, l) => Math.max(m, l.project_nr || 0), 0) + 1;
  return {
    name,
    project_nr:  projectNr,
    local_seq:   localSeq,
    naming_key:  namingKey,
    g_id:        gId,
    g_name:      gName,
    trafo_tst:   tstL,
    nearest_trafo_id: trafo && trafo.id != null ? trafo.id : null,
  };
}

// ─── Google / Sheets / Drive config ──────────────────────────────────────────

const GOOGLE_CREDS_PATH = process.env.GOOGLE_CREDS_PATH ||
  path.join(__dirname, '..', '..', 'pv-lead-manager', 'auth', 'google-credentials.json');
const GOOGLE_TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH ||
  path.join(__dirname, '..', 'auth', 'google-token.json');
const PVM_TOKEN_PATH = path.join(__dirname, '..', '..', 'pv-lead-manager', 'auth', 'google-token.json');

const CONTRACTING_SHEET_ID = '17c_Upf_LUg84rvY41zIHIzkvOxN1vfrcUnil3PbYkoY';
const CONTRACTING_TAB      = 'Contracting-Leads';
const DRIVE_FOLDER_NAME    = 'Trafo-Finder Screenshots';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

let _googleAuth = null;

function _getOAuthClient(port) {
  if (!fs.existsSync(GOOGLE_CREDS_PATH)) return null;
  const creds = JSON.parse(fs.readFileSync(GOOGLE_CREDS_PATH));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const p = port || process.env.PORT || 3007;
  return new google.auth.OAuth2(client_id, client_secret, `http://localhost:${p}/api/auth/callback`);
}

function _loadGoogleAuth() {
  const auth = _getOAuthClient();
  if (!auth) return null;
  let tokenPath = GOOGLE_TOKEN_PATH;
  if (!fs.existsSync(tokenPath)) {
    if (fs.existsSync(PVM_TOKEN_PATH)) tokenPath = PVM_TOKEN_PATH;
    else return null;
  }
  const token = JSON.parse(fs.readFileSync(tokenPath));
  auth.setCredentials(token);
  auth.on('tokens', (tokens) => {
    Object.assign(token, tokens);
    try { fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2)); } catch {}
  });
  return auth;
}

function getGoogleAuth() {
  if (!_googleAuth) _googleAuth = _loadGoogleAuth();
  return _googleAuth;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '20mb' }));
// Muss VOR static stehen, sonst 404/„Cannot GET /crm“ wenn alte Deploy-Order oder Cache
app.get('/crm', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});
app.use(express.static(PUBLIC));

// ── API: Google OAuth re-authorization (adds drive.file scope) ────────────────
app.get('/api/auth/google', (req, res) => {
  const auth = _getOAuthClient(PORT);
  if (!auth) return res.status(500).send('Google credentials not found at ' + GOOGLE_CREDS_PATH);
  const url = auth.generateAuthUrl({ access_type: 'offline', scope: GOOGLE_SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/api/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No auth code received');
  try {
    const auth = _getOAuthClient(PORT);
    const { tokens } = await auth.getToken(code);
    const authDir = path.join(__dirname, '..', 'auth');
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify(tokens, null, 2));
    _googleAuth = null;
    console.log('[auth] Google Drive token saved to', GOOGLE_TOKEN_PATH);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#1a1d26;color:#c8d6f0">
      <h2 style="color:#22c55e">✅ Google Drive Zugriff aktiviert!</h2>
      <p>Screenshots können jetzt auf Google Drive hochgeladen werden.</p>
      <a href="/" style="color:#7ecfff">← Zurück zum Dashboard</a>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Auth error: ' + err.message);
  }
});

app.get('/api/auth/status', (req, res) => {
  const auth = getGoogleAuth();
  if (!auth) return res.json({ sheets: false, drive: false, auth_url: '/api/auth/google' });
  const scope = auth.credentials?.scope || '';
  res.json({
    sheets: true,
    drive:  scope.includes('drive'),
    auth_url: '/api/auth/google',
  });
});

// ── Benutzerverwaltung (Admin) ────────────────────────────────────────────────
const HTPASSWD_FILE = '/etc/nginx/.htpasswd';
const ADMIN_USER    = 'cosimo';
// Nur alphanumerisch + Bindestrich/Unterstrich erlaubt (kein Shell-Injection)
const VALID_USERNAME = /^[a-zA-Z0-9_\-]{2,32}$/;

function getAuthUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const colon   = decoded.indexOf(':');
    return colon === -1 ? null : decoded.slice(0, colon);
  } catch { return null; }
}

function isAdminUser(req) {
  const u = getAuthUser(req);
  return u && getRole(u) === 'admin';
}
function requireAdmin(req, res) {
  if (!getAuthUser(req)) {
    res.status(401).json({ error: 'Anmeldung erforderlich' });
    return false;
  }
  if (!isAdminUser(req)) {
    res.status(403).json({ error: 'Nur Benutzer mit Rolle Admin haben Zugriff.' });
    return false;
  }
  return true;
}

// ── CRM-Rollen (data/user-roles.json) + Audit ──────────────────────────────
const USER_ROLES_FILE = path.join(DATA_DIR, 'user-roles.json');
const ACCOUNTS_FILE   = path.join(DATA_DIR, 'accounts.json');
const AUDIT_FILE      = path.join(DATA_DIR, 'audit.json');
const AUDIT_MAX       = 8000;

function readUserRoles() {
  if (!fs.existsSync(USER_ROLES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USER_ROLES_FILE, 'utf8')); } catch { return {} }
}
function getRole(user) {
  if (!user) return null;
  const r = readUserRoles();
  if (r[user]) return r[user];
  if (user === ADMIN_USER) return 'admin';
  return 'assistenz';
}
function requireUser(req, res) {
  const u = getAuthUser(req);
  if (!u) { res.status(401).json({ error: 'Anmeldung erforderlich' }); return null; }
  return u;
}
function requireCrmWrite(req, res) {
  const u = requireUser(req, res);
  if (!u) return null;
  const role = getRole(u);
  if (role !== 'vertrieb' && role !== 'admin' && role !== 'assistenz') {
    res.status(403).json({ error: 'Keine CRM-Berechtigung' });
    return null;
  }
  return u;
}
/** Löschen, Firmen anlegen, riskante Ops: nur Vertrieb + Admin */
function requireVertriebOrAdmin(req, res) {
  const u = requireUser(req, res);
  if (!u) return null;
  const role = getRole(u);
  if (role !== 'vertrieb' && role !== 'admin') {
    res.status(403).json({ error: 'Nur Vertrieb/Admin' });
    return null;
  }
  return u;
}
function appendAudit(row) {
  let arr = [];
  if (fs.existsSync(AUDIT_FILE)) {
    try { arr = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) arr = [];
  arr.push({ ts: new Date().toISOString(), ...row });
  if (arr.length > AUDIT_MAX) arr = arr.slice(-AUDIT_MAX);
  try { fs.writeFileSync(AUDIT_FILE, JSON.stringify(arr, null, 2)); } catch (e) { console.error('[audit]', e); }
}

// Wer bin ich?
app.get('/api/me', (req, res) => {
  const u = getAuthUser(req) || null;
  res.json({ username: u, role: u ? getRole(u) : null });
});

// Alle User auflisten (inkl. CRM-Rolle)
app.get('/api/admin/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const content = fs.existsSync(HTPASSWD_FILE)
      ? fs.readFileSync(HTPASSWD_FILE, 'utf8') : '';
    const users = content.trim().split('\n')
      .map(l => l.trim()).filter(l => l && l.includes(':'))
      .map(l => {
        const username = l.split(':')[0];
        return { username, role: getRole(username) };
      });
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// User anlegen / Passwort ändern
app.post('/api/admin/users', express.json(), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username und password erforderlich' });
  if (!VALID_USERNAME.test(username))
    return res.status(400).json({ error: 'Ungültiger Benutzername (nur a-z, 0-9, _ -)' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  try {
    // execFileSync avoids shell – arguments are passed as array, no injection possible
    execFileSync('htpasswd', ['-bB', HTPASSWD_FILE, username, password], { stdio: 'pipe' });
    execFileSync('systemctl', ['reload', 'nginx'], { stdio: 'pipe' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.stderr?.toString() || err.message }); }
});

// User löschen
app.delete('/api/admin/users/:username', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { username } = req.params;
  if (username === ADMIN_USER)
    return res.status(400).json({ error: 'Der Admin-Account kann nicht gelöscht werden.' });
  if (!VALID_USERNAME.test(username))
    return res.status(400).json({ error: 'Ungültiger Benutzername' });
  try {
    execFileSync('htpasswd', ['-D', HTPASSWD_FILE, username], { stdio: 'pipe' });
    execFileSync('systemctl', ['reload', 'nginx'], { stdio: 'pipe' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.stderr?.toString() || err.message }); }
});

// ── API: list available scans ────────────────────────────────────────────────
app.get('/api/scans', (req, res) => {
  if (!fs.existsSync(SCANS_DIR)) return res.json([]);
  const files = fs.readdirSync(SCANS_DIR)
    .filter(f => f.match(/^trafos-\d{4}-\d{2}-\d{2}\.json$/))
    .sort()
    .reverse(); // newest first
  const scans = files.map(f => {
    const date = f.replace('trafos-', '').replace('.json', '');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SCANS_DIR, f)));
      return { date, file: f, count: data.count, counts: data.counts, scanned_at: data.scanned_at };
    } catch {
      return { date, file: f };
    }
  });
  res.json(scans);
});

// ── API: get a specific scan ─────────────────────────────────────────────────
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.get('/api/scans/:date', (req, res) => {
  if (!ISO_DATE_RE.test(req.params.date))
    return res.status(400).json({ error: 'Invalid date format' });
  const file = path.join(SCANS_DIR, `trafos-${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Scan not found' });
  res.sendFile(file);
});

// ── API: latest scan ─────────────────────────────────────────────────────────
app.get('/api/latest', (req, res) => {
  if (!fs.existsSync(LATEST)) return res.status(404).json({ error: 'No scan yet' });
  res.sendFile(LATEST);
});

// ── API: compare two scans ───────────────────────────────────────────────────
app.get('/api/compare', (req, res) => {
  const { a, b } = req.query;
  if (!ISO_DATE_RE.test(a) || !ISO_DATE_RE.test(b))
    return res.status(400).json({ error: 'Invalid date format' });
  const changesFile = path.join(DATA_DIR, `changes-${a}-vs-${b}.json`);

  // Return cached result if it exists
  if (changesFile && fs.existsSync(changesFile)) {
    return res.sendFile(changesFile);
  }

  // Compute on demand
  try {
    const scan1 = JSON.parse(fs.readFileSync(path.join(SCANS_DIR, `trafos-${a}.json`)));
    const scan2 = JSON.parse(fs.readFileSync(path.join(SCANS_DIR, `trafos-${b}.json`)));
    const changes = compareScans(scan1, scan2);
    const output = {
      generated_at: new Date().toISOString(),
      scan_a: { date: a, count: scan1.count },
      scan_b: { date: b, count: scan2.count },
      summary: {
        total_changes: changes.length,
        improved: changes.filter(c => c.direction === 'improved').length,
        worsened: changes.filter(c => c.direction === 'worsened').length,
      },
      changes,
    };
    fs.writeFileSync(changesFile, JSON.stringify(output, null, 2));
    res.json(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: trafos with bbox + zoom filtering ───────────────────────────────────
app.get('/api/trafos', (req, res) => {
  if (!fs.existsSync(LATEST)) return res.status(404).json({ error: 'No scan yet' });
  const { north, south, east, west, zoom } = req.query;
  // Math.floor keeps client and server thresholds in sync (client also sends floored zoom)
  const z = Math.floor(Number(zoom)) || 10;
  const data = JSON.parse(fs.readFileSync(LATEST));

  // Zoom < 9: return Bezirk-level aggregation
  if (z < 9) {
    const agg = {};
    BEZIRKE.forEach(b => { agg[b.id] = { ...b, counts: {free:0,partial:0,regional:0,local:0,full:0}, total:0 }; });
    data.trafos.forEach(t => {
      const b = nearestCentroid(t.lat, t.lng, BEZIRKE);
      if (!agg[b.id]) return;
      agg[b.id].counts[t.status] = (agg[b.id].counts[t.status] || 0) + 1;
      agg[b.id].total++;
    });
    return res.json({
      mode: 'bezirk',
      bezirke: Object.values(agg),
      scanned_at: data.scanned_at || null,
      scan_date:  data.date || null,
    });
  }

  // Bbox filter
  let trafos = data.trafos;
  if (north && south && east && west) {
    const n=+north, s=+south, e=+east, w=+west;
    trafos = trafos.filter(t => inBbox(t.lat, t.lng, n, s, e, w));
  }

  const scanMeta = { scanned_at: data.scanned_at || null, scan_date: data.date || null };

  // Zoom 9–11: max 500, step-sampled for geographic + status diversity
  if (z < 12) {
    if (trafos.length > 500) {
      const step = Math.ceil(trafos.length / 500);
      trafos = trafos.filter((_, i) => i % step === 0);
    }
    return res.json({ mode: 'cluster', trafos, ...scanMeta });
  }

  return res.json({ mode: 'individual', trafos, ...scanMeta });
});

// ── API: opportunities with bbox + filters ───────────────────────────────────
app.get('/api/opportunities', (req, res) => {
  if (!fs.existsSync(OPP_FILE)) return res.json({ opportunities: [], count: 0 });
  const { north, south, east, west, zoom, min_score, min_kwp, max_dist, status_filter } = req.query;
  const data = JSON.parse(fs.readFileSync(OPP_FILE));
  let opps = data.opportunities || [];

  // Filters
  if (min_score) opps = opps.filter(o => o.score >= +min_score);
  if (min_kwp)   opps = opps.filter(o => o.kwp >= +min_kwp);
  if (max_dist)  opps = opps.filter(o => o.distance_to_trafo_m <= +max_dist);
  if (status_filter === 'free') opps = opps.filter(o => o.nearest_trafo_status === 'free');

  // Bbox filter
  if (north && south && east && west) {
    const n=+north, s=+south, e=+east, w=+west;
    opps = opps.filter(o => inBbox(o.lat, o.lng, n, s, e, w));
  }

  const z = Number(zoom) || 10;
  if (z < 12) opps = opps.slice(0, 200);

  res.json({
    count:          opps.length,
    total_kwp:      Math.round(opps.reduce((s,o)=>s+o.kwp,0)),
    total_kwh_year: Math.round(opps.reduce((s,o)=>s+o.kwh_year,0)),
    total_co2_tons: Math.round(opps.reduce((s,o)=>s+o.co2_tons_year,0)),
    opportunities:  opps,
    stats_all: {
      count:   data.count,
      kwp:     data.total_kwp,
      kwh:     data.total_kwh_year,
      co2:     data.total_co2_tons,
    },
  });
});

// ── API: simple building polygons ────────────────────────────────────────────
const BLD_SIMPLE_FILE = path.join(DATA_DIR, 'opportunities-simple.json');
// /api/buildings-simple kept for CLI pipeline compatibility but not used by the dashboard UI
app.get('/api/buildings-simple', (req, res) => {
  if (!fs.existsSync(BLD_SIMPLE_FILE)) return res.json({ buildings: [], count: 0 });
  res.sendFile(BLD_SIMPLE_FILE);
});

// ── Overpass (öffentliche Spiegel – Hauptinstanz liefert oft 429/503) ─────────
const OVERPASS_ENDPOINTS = String(process.env.OVERPASS_URL || '')
  .split(/[\s,]+/)
  .map(s => s.trim())
  .filter(Boolean)
  .concat([
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ])
  .filter((u, i, arr) => arr.indexOf(u) === i);

/**
 * POST an Overpass interpreter; bei Überlastung / Fehler nächsten Spiegel versuchen.
 */
async function overpassInterpreter(query, timeoutMs) {
  const fetch = require('node-fetch');
  const body = 'data=' + encodeURIComponent(query);
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent':   'Roof-Identifizierer/1.0 (NÖ Trafo-Dashboard)',
  };
  const retryStatus = new Set([408, 429, 500, 502, 503, 504]);
  let lastMsg = 'Overpass: alle Endpunkte fehlgeschlagen';
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', headers, body, timeout: timeoutMs });
      if (r.ok) return r;
      const snippet = (await r.text()).slice(0, 400);
      lastMsg = `Overpass HTTP ${r.status} (${url}): ${snippet}`;
      console.warn('[overpass]', lastMsg);
      if (!retryStatus.has(r.status)) break;
    } catch (err) {
      lastMsg = `${url}: ${err.message}`;
      console.warn('[overpass]', lastMsg);
    }
  }
  throw new Error(lastMsg);
}

// ── API: on-demand building polygons (viewport, Overpass) ────────────────────

const _bldCache  = new Map(); // cacheKey → { ts, buildings[] }
const BLD_TTL    = 10 * 60 * 1000; // 10 min
const DEG2R      = Math.PI / 180;

function _polyArea(nodes) {
  if (nodes.length < 3) return 0;
  const cosLat = Math.cos(nodes[0].lat * DEG2R);
  const pts = nodes.map(n => ({
    x: (n.lng - nodes[0].lng) * DEG2R * 6371000 * cosLat,
    y: (n.lat - nodes[0].lat) * DEG2R * 6371000,
  }));
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

function _calcKwp(area) {
  const usable  = Math.round(area * 0.75);
  const modules = Math.floor(usable / 2.613);
  const kwp     = Math.round(modules * 0.46 * 10) / 10;
  return { usable_area: usable, modules, kwp, kwh_year: Math.round(kwp * 1050) };
}

app.get('/api/buildings', async (req, res) => {
  const { north, south, east, west } = req.query;
  const min_area = Math.max(100, parseFloat(req.query.min_area) || 100);
  const max_dist = parseFloat(req.query.max_dist) || 200;

  if (!north || !south || !east || !west)
    return res.status(400).json({ error: 'bbox required' });

  const n = +north, s = +south, e = +east, w = +west;
  // Snap to 0.1° grid (same grid as client) for maximum cache sharing
  const SNAP = 0.1;
  const sn = {
    s: Math.floor(s / SNAP) * SNAP, w: Math.floor(w / SNAP) * SNAP,
    n: Math.ceil(n  / SNAP) * SNAP, e: Math.ceil(e  / SNAP) * SNAP,
  };
  const cacheKey = [sn.n, sn.s, sn.e, sn.w].map(v => v.toFixed(3)).join(',');

  let rawBuildings;
  const hit = _bldCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < BLD_TTL) {
    rawBuildings = hit.buildings;
  } else {
    // Query with snapped (padded) bbox so cached tiles align across requests
    const bb    = `${sn.s.toFixed(5)},${sn.w.toFixed(5)},${sn.n.toFixed(5)},${sn.e.toFixed(5)}`;
    const query = `[out:json][timeout:60];\nway["building"](${bb});\nout body;\n>;\nout skel qt;`;
    try {
      const r = await overpassInterpreter(query, 65000);
      const data = await r.json();

      const nodeMap = new Map();
      for (const el of data.elements)
        if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lng: el.lon });

      rawBuildings = [];
      for (const el of data.elements) {
        if (el.type !== 'way' || !el.tags?.building) continue;
        const nodes = (el.nodes || []).map(id => nodeMap.get(id)).filter(Boolean);
        if (nodes.length < 3) continue;
        const area = _polyArea(nodes);
        if (area < 100) continue;
        const lat = nodes.reduce((sum, nd) => sum + nd.lat, 0) / nodes.length;
        const lng = nodes.reduce((sum, nd) => sum + nd.lng, 0) / nodes.length;
        rawBuildings.push({
          osm_id:        el.id,
          lat:           parseFloat(lat.toFixed(6)),
          lng:           parseFloat(lng.toFixed(6)),
          roof_area_m2:  Math.round(area),
          polygon:       nodes.map(nd => [nd.lat, nd.lng]),
          building_type: el.tags.building !== 'yes' ? el.tags.building : null,
          address:       formatAddressFromOsmTags(el.tags) || null,
          atlas_url:     `https://atlas.noe.gv.at/atlas/portal/noe-atlas/map/Planung%20und%20Kataster/Grundst%C3%BCcke?center=${lng.toFixed(6)},${lat.toFixed(6)}&level=18`,
          ..._calcKwp(area),
        });
      }
      _bldCache.set(cacheKey, { ts: Date.now(), buildings: rawBuildings });
    } catch (err) {
      console.error('[/api/buildings]', err.message);
      return res.status(503).json({ error: err.message });
    }
  }

  // Load trafos and find nearest for each building
  if (!fs.existsSync(LATEST)) return res.status(503).json({ error: 'no trafo data' });
  const trafos = JSON.parse(fs.readFileSync(LATEST)).trafos || [];

  // Pre-filter trafos to bbox + 300 m buffer for speed
  const buf = 300 / 111000;
  const localTrafos = trafos.filter(t =>
    t.lat >= s - buf && t.lat <= n + buf &&
    t.lng >= w - buf && t.lng <= e + buf
  );

  const buildings = [];
  for (const b of rawBuildings) {
    if (b.roof_area_m2 < min_area) continue;
    let nearestTrafo = null, nearestDist = Infinity;
    for (const t of localTrafos) {
      const d = distM({ lat: b.lat, lng: b.lng }, { lat: t.lat, lng: t.lng });
      if (d < nearestDist) { nearestDist = d; nearestTrafo = t; }
    }
    if (!nearestTrafo || nearestDist > max_dist) continue;
    buildings.push({
      ...b,
      distance_to_trafo_m:  Math.round(nearestDist),
      nearest_trafo_id:     nearestTrafo.id || null,
      nearest_trafo_tst_id: nearestTrafo.tst_id || null,
      nearest_trafo_status: nearestTrafo.status,
    });
  }

  res.json({ count: buildings.length, buildings });
});

// ── API: on-demand open/industrial area polygons (viewport, Overpass) ────────
// Freiflächen: landuse-Polygone (Industrie, Gewerbe, Brachland…)
// kWp-Schätzung: 75 % der Zonenfläche nutzbar (bodenmontierte Freiflächenanlage)

const _oaCache = new Map();
const OA_TTL   = 10 * 60 * 1000; // 10 min

// landuse tags to query – sorted by PV relevance:
// - industrial / commercial / depot / brownfield: classic targets
// - landfill: closed Deponien – flat, unproductive, often near power infrastructure, ideal for PV
// - construction: emerging zones, good for early-stage pipeline
// - retail: large surface parking / garden centres often usable
const OA_LANDUSE = ['industrial', 'commercial', 'retail', 'depot', 'brownfield', 'landfill', 'construction'];

/**
 * Parse OSM Overpass response into area objects.
 * Handles both simple closed ways AND multipolygon relations so that large
 * industrial parks (which OSM models as relations) are not missed.
 */
function _parseOsmAreas(data, minArea = 500) {
  const nodeMap = new Map();
  for (const el of data.elements)
    if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lng: el.lon });

  // wayMap needed for assembling relation outer rings
  const wayMap = new Map();
  for (const el of data.elements)
    if (el.type === 'way' && el.nodes)
      wayMap.set(el.id, el.nodes.map(id => nodeMap.get(id)).filter(Boolean));

  // Collect way IDs that are outer members of multipolygon relations.
  // Those get their landuse from the relation tag, not from themselves,
  // so we skip them in the way loop to avoid double-counting.
  const relMemberWayIds = new Set();
  for (const el of data.elements) {
    if (el.type === 'relation' && el.tags?.type === 'multipolygon' && el.tags?.landuse)
      for (const m of (el.members || []))
        if (m.type === 'way') relMemberWayIds.add(m.ref);
  }

  const areas = [];

  function pushArea(osm_id, nodes, tags) {
    if (nodes.length < 3) return;
    const area = _polyArea(nodes);
    if (area < minArea) return;
    const lat = nodes.reduce((s, nd) => s + nd.lat, 0) / nodes.length;
    const lng = nodes.reduce((s, nd) => s + nd.lng, 0) / nodes.length;
    areas.push({
      osm_id,
      lat:       parseFloat(lat.toFixed(6)),
      lng:       parseFloat(lng.toFixed(6)),
      area_m2:   Math.round(area),
      polygon:   nodes.map(nd => [nd.lat, nd.lng]),
      landuse:   tags.landuse,
      name:      tags.name || null,
      address:   formatAddressFromOsmTags(tags) || null,
      atlas_url: `https://atlas.noe.gv.at/atlas/portal/noe-atlas/map/Planung%20und%20Kataster/Grundst%C3%BCcke?center=${lng.toFixed(6)},${lat.toFixed(6)}&level=18`,
      ..._calcKwpGround(area),
    });
  }

  // 1) Simple closed ways
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.tags?.landuse) continue;
    if (!OA_LANDUSE.includes(el.tags.landuse)) continue;
    if (relMemberWayIds.has(el.id)) continue; // handled via its relation
    const nodes = (el.nodes || []).map(id => nodeMap.get(id)).filter(Boolean);
    pushArea(el.id, nodes, el.tags);
  }

  // 2) Multipolygon relations (large industrial parks etc.)
  for (const el of data.elements) {
    if (el.type !== 'relation' || el.tags?.type !== 'multipolygon') continue;
    if (!el.tags?.landuse || !OA_LANDUSE.includes(el.tags.landuse)) continue;
    // Assemble outer ring from member ways
    const outerWayIds = (el.members || [])
      .filter(m => m.type === 'way' && m.role === 'outer')
      .map(m => m.ref);
    if (!outerWayIds.length) continue;
    const outerNodes = outerWayIds.flatMap(id => wayMap.get(id) || []);
    pushArea(el.id, outerNodes, el.tags);
  }

  return areas;
}

function _calcKwpGround(area) {
  const usable  = Math.round(area * 0.75);  // 75 % für bodenmontierte PV
  const modules = Math.floor(usable / 2.613);
  const kwp     = Math.round(modules * 0.46 * 10) / 10;
  return { usable_area: usable, modules, kwp, kwh_year: Math.round(kwp * 1050) };
}

app.get('/api/open-areas', async (req, res) => {
  const { north, south, east, west } = req.query;
  const min_area = Math.max(500, parseFloat(req.query.min_area) || 500);
  const max_dist = parseFloat(req.query.max_dist) || 200;

  if (!north || !south || !east || !west)
    return res.status(400).json({ error: 'bbox required' });

  const n = +north, s = +south, e = +east, w = +west;
  const _SNAP = 0.1;
  const oaSn = {
    s: Math.floor(s / _SNAP) * _SNAP, w: Math.floor(w / _SNAP) * _SNAP,
    n: Math.ceil(n  / _SNAP) * _SNAP, e: Math.ceil(e  / _SNAP) * _SNAP,
  };
  const cacheKey = 'oa:' + [oaSn.n, oaSn.s, oaSn.e, oaSn.w].map(v => v.toFixed(3)).join(',');

  let rawAreas;
  const hit = _oaCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < OA_TTL) {
    rawAreas = hit.areas;
  } else {
    const bb      = `${oaSn.s.toFixed(5)},${oaSn.w.toFixed(5)},${oaSn.n.toFixed(5)},${oaSn.e.toFixed(5)}`;
    const luList  = OA_LANDUSE.join('|');
    // Query both simple ways AND multipolygon relations to capture large industrial parks
    const query   = `[out:json][timeout:60];(way["landuse"~"^(${luList})$"](${bb});relation["landuse"~"^(${luList})$"]["type"="multipolygon"](${bb}););out body;>;out skel qt;`;
    try {
      const r = await overpassInterpreter(query, 65000);
      const data = await r.json();
      rawAreas = _parseOsmAreas(data, 500);
      _oaCache.set(cacheKey, { ts: Date.now(), areas: rawAreas });
    } catch (err) {
      console.error('[/api/open-areas]', err.message);
      return res.status(503).json({ error: err.message });
    }
  }

  if (!fs.existsSync(LATEST)) return res.status(503).json({ error: 'no trafo data' });
  const trafos = JSON.parse(fs.readFileSync(LATEST)).trafos || [];
  const buf    = 300 / 111000;
  const localTrafos = trafos.filter(t =>
    t.lat >= s - buf && t.lat <= n + buf &&
    t.lng >= w - buf && t.lng <= e + buf
  );

  const areas = [];
  for (const a of rawAreas) {
    if (a.area_m2 < min_area) continue;
    let nearestTrafo = null, nearestDist = Infinity;
    for (const t of localTrafos) {
      const d = distM({ lat: a.lat, lng: a.lng }, { lat: t.lat, lng: t.lng });
      if (d < nearestDist) { nearestDist = d; nearestTrafo = t; }
    }
    if (!nearestTrafo || nearestDist > max_dist) continue;
    areas.push({
      ...a,
      distance_to_trafo_m:  Math.round(nearestDist),
      nearest_trafo_id:     nearestTrafo.id || null,
      nearest_trafo_tst_id: nearestTrafo.tst_id || null,
      nearest_trafo_status: nearestTrafo.status,
    });
  }
  res.json({ count: areas.length, areas });
});

// ── API: BEV Kataster lookup ──────────────────────────────────────────────────
//
// 3-step approach:
//   1. WMS GetFeatureInfo on data.bev.gv.at → INSPIRE parcel ID
//      e.g. "AT.0002.I.6.CP.010041656#1"  → KG="01004", GNR="1656"
//   2. BEV search API → gnr, ez, kg number
//   3. BEV kgnr API  → KG name
//
const _katCache = new Map(); // 'lat,lng' → { ts, data }
const KAT_TTL   = 60 * 60 * 1000; // 1 h

app.get('/api/kataster', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng))
    return res.status(400).json({ error: 'lat/lng required' });

  const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const hit = _katCache.get(key);
  if (hit && Date.now() - hit.ts < KAT_TTL) return res.json(hit.data);

  const _fetch = require('node-fetch');

  try {
    // ── Step 1: WMS GetFeatureInfo → INSPIRE parcel ID ──────────────────────
    const delta = 0.0005;
    const bbox  = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;
    const wmsUrl =
      `https://data.bev.gv.at/geoserver/INSdataCP/ows` +
      `?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
      `&LAYERS=CP_CadastralParcel&QUERY_LAYERS=CP_CadastralParcel` +
      `&CRS=CRS:84&BBOX=${bbox}&WIDTH=101&HEIGHT=101&I=50&J=50` +
      `&INFO_FORMAT=text/plain&FEATURE_COUNT=3`;

    const wmsRes = await _fetch(wmsUrl, {
      headers: { 'User-Agent': 'Noortec-RoofIdentifyer/1.0' },
      timeout: 10000,
    });
    if (!wmsRes.ok) { _katCache.set(key, { ts: Date.now(), data: null }); return res.json(null); }
    const wmsText = await wmsRes.text();

    // Parse: inspireId = AT.0002.I.6.CP.XXXXXYYY...#N
    const inspireMatch = wmsText.match(/AT\.0002\.I\.6\.CP\.(\d{5})(\d+)/);
    if (!inspireMatch) { _katCache.set(key, { ts: Date.now(), data: null }); return res.json(null); }
    const kgnr = inspireMatch[1];   // e.g. "01004"
    const gnr  = inspireMatch[2];   // e.g. "1656"

    // ── Step 2: BEV search API → parcel details ──────────────────────────────
    const searchUrl =
      `https://kataster.bev.gv.at/api/search?term=${encodeURIComponent(kgnr + ' ' + gnr)}&layers=gst`;
    const searchRes = await _fetch(searchUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'Noortec-RoofIdentifyer/1.0' },
      timeout: 10000,
    });
    let gnrFull = gnr, ezFull = null, kgFromSearch = kgnr;
    if (searchRes.ok) {
      const sj = await searchRes.json();
      const feat = sj?.data?.features?.[0]?.properties ?? sj?.features?.[0]?.properties ?? null;
      if (feat) {
        gnrFull      = feat.gnr  ?? gnrFull;
        ezFull       = feat.ez   ?? null;
        kgFromSearch = feat.kg   ?? kgnr;
      }
    }

    // ── Step 3: KG name lookup ───────────────────────────────────────────────
    let kgName = null;
    try {
      const kgnrRes = await _fetch(
        `https://kataster.bev.gv.at/api/kgnr/${kgFromSearch}`,
        { headers: { Accept: 'application/json', 'User-Agent': 'Noortec-RoofIdentifyer/1.0' }, timeout: 8000 }
      );
      if (kgnrRes.ok) {
        const kj = await kgnrRes.json();
        kgName = kj?.properties?.kg ?? kj?.kg ?? null;
      }
    } catch { /* kg name is optional */ }

    const result = {
      gkz:   kgFromSearch,
      kg:    kgName,
      gstnr: gnrFull,
      ez:    ezFull,
    };
    _katCache.set(key, { ts: Date.now(), data: result });
    res.json(result);

  } catch (err) {
    console.error('[/api/kataster]', err.message);
    _katCache.set(key, { ts: Date.now(), data: null });
    res.json(null);
  }
});

// ── API: bezirke data ────────────────────────────────────────────────────────
app.get('/api/bezirke', (req, res) => res.json(BEZIRKE));

// ── API: save lead → Google Sheets + Drive screenshot ────────────────────────
// NOTE: Not used by the dashboard UI (replaced by mini-CRM). Kept for manual export workflows.
app.post('/api/save-lead', express.json({ limit: '10mb' }), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const auth = getGoogleAuth();
  if (!auth) return res.status(503).json({
    error: 'Google Auth nicht konfiguriert. Bitte /api/auth/google aufrufen.',
    auth_url: '/api/auth/google',
  });

  const body = req.body || {};
  let drive_url    = null;
  let drive_warning = null;

  // ── Upload screenshot to Google Drive ──────────────────────────────────────
  if (body.screenshot_base64) {
    try {
      const drive = google.drive({ version: 'v3', auth });
      let folderId;
      const folderList = await drive.files.list({
        q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)', spaces: 'drive',
      });
      if (folderList.data.files.length > 0) {
        folderId = folderList.data.files[0].id;
      } else {
        const folder = await drive.files.create({
          requestBody: { name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
          fields: 'id',
        });
        folderId = folder.data.id;
      }
      const pngData  = Buffer.from(body.screenshot_base64.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
      const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const { Readable } = require('stream');
      const uploadRes = await drive.files.create({
        requestBody: { name: `screenshot-${ts}.png`, parents: [folderId], mimeType: 'image/png' },
        media: { mimeType: 'image/png', body: Readable.from(pngData) },
        fields: 'id',
      });
      await drive.permissions.create({
        fileId: uploadRes.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });
      drive_url = `https://drive.google.com/file/d/${uploadRes.data.id}/view`;
    } catch (err) {
      console.error('[save-lead] Drive upload failed:', err.message);
      if (err.message?.includes('insufficient') || err.code === 403) {
        drive_warning = 'Drive-Zugriff fehlt. Bitte <a href="/api/auth/google">/api/auth/google</a> aufrufen.';
      } else {
        drive_warning = 'Screenshot-Upload fehlgeschlagen: ' + err.message;
      }
    }
  }

  // ── Append row to Google Sheet ──────────────────────────────────────────────
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const now    = new Date().toLocaleDateString('de-AT');
    const row = [
      now,                              // A: Datum
      'Neu',                            // B: Status
      body.firmenname      || '',       // C: Firmenname
      body.telefon_firma   || '',       // D: Telefon Firma
      body.email_firma     || '',       // E: E-Mail Firma
      body.gf_name         || '',       // F: Geschäftsführer
      body.gf_telefon      || '',       // G: Telefon GF
      body.gf_email        || '',       // H: E-Mail GF
      body.website         || '',       // I: Website
      body.address         || '',       // J: Adresse
      body.roof_area_m2 != null ? String(body.roof_area_m2) : '', // K: Dachfläche m²
      body.kwp          != null ? String(body.kwp)          : '', // L: Leistung kWp
      body.nearest_trafo_status || '',  // M: Trafo-Status
      body.distance_to_trafo_m  != null ? String(body.distance_to_trafo_m) : '', // N: Trafo-Abstand m
      body.gstnr           || '',       // O: Grundstück-Nr
      body.kg_name         || '',       // P: Katastralgemeinde
      body.gkz             || '',       // Q: KG-Nummer
      body.ez              || '',       // R: Einlagezahl
      (body.lat != null && body.lng != null) ? `${body.lat},${body.lng}` : '', // S: Koordinaten
      body.atlas_url       || '',       // T: NÖ Atlas Link
      drive_url            || '',       // U: Screenshot Drive Link
    ];
    // Ensure the tab exists; create it with header row if missing
    const meta = await sheets.spreadsheets.get({ spreadsheetId: CONTRACTING_SHEET_ID });
    const tabExists = (meta.data.sheets || []).some(s => s.properties.title === CONTRACTING_TAB);
    if (!tabExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: CONTRACTING_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: CONTRACTING_TAB } } }] },
      });
      const HEADER = [
        'Datum','Status','Firmenname','Telefon Firma','E-Mail Firma',
        'Geschäftsführer','Telefon GF','E-Mail GF','Website','Adresse',
        'Dachfläche m²','Leistung kWp','Trafo-Status','Trafo-Abstand m',
        'Grundstück-Nr','Katastralgemeinde','KG-Nummer','Einlagezahl',
        'Koordinaten','NÖ Atlas Link','Screenshot',
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId: CONTRACTING_SHEET_ID,
        range: `${CONTRACTING_TAB}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER] },
      });
      // Format the new sheet: bold+freeze header, sensible column widths
      const newSheetId = (await sheets.spreadsheets.get({ spreadsheetId: CONTRACTING_SHEET_ID }))
        .data.sheets.find(s => s.properties.title === CONTRACTING_TAB)?.properties?.sheetId;
      if (newSheetId != null) {
        const COL_WIDTHS = [80,80,180,120,160,160,120,160,160,200,80,70,100,90,100,140,80,80,120,220,160];
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: CONTRACTING_SHEET_ID,
          requestBody: { requests: [
            // Bold + background for header row
            { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: {
                textFormat:      { bold: true },
                backgroundColor: { red: 0.18, green: 0.20, blue: 0.28 },
                horizontalAlignment: 'CENTER',
              }}, fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)' } },
            // Freeze first row
            { updateSheetProperties: { properties: { sheetId: newSheetId,
              gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
            // Column widths
            ...COL_WIDTHS.map((px, i) => ({ updateDimensionProperties: {
              range: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i+1 },
              properties: { pixelSize: px }, fields: 'pixelSize',
            }})),
          ]},
        });
      }
      console.log(`[save-lead] Created tab "${CONTRACTING_TAB}" with header row`);
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONTRACTING_SHEET_ID,
      range: `${CONTRACTING_TAB}!A:U`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    res.json({ success: true, drive_url, drive_warning });
  } catch (err) {
    console.error('[save-lead] Sheet append failed:', err.message);
    res.status(500).json({ error: 'Sheet-Fehler: ' + err.message, drive_url, drive_warning });
  }
});

// ── API: owner search (Google Places + WKO) ───────────────────────────────────
app.get('/api/owner-search', async (req, res) => {
  const lat     = parseFloat(req.query.lat);
  const lng     = parseFloat(req.query.lng);
  const address = req.query.address || '';
  const _fetch  = require('node-fetch');
  const results = [];

  // ── Google Places ───────────────────────────────────────────────────────────
  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  const placesEnabled = !!(placesKey && placesKey.trim());
  if (placesEnabled) {
    try {
      const nearbyUrl =
        `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
        `?location=${lat},${lng}&radius=100&key=${encodeURIComponent(placesKey)}`;
      const nr = await _fetch(nearbyUrl, { timeout: 8000 });
      const nd = await nr.json();
      for (const p of (nd.results || []).slice(0, 3)) {
        try {
          const dUrl =
            `https://maps.googleapis.com/maps/api/place/details/json` +
            `?place_id=${p.place_id}&fields=name,formatted_phone_number,website,formatted_address` +
            `&key=${encodeURIComponent(placesKey)}`;
          const dr = await _fetch(dUrl, { timeout: 6000 });
          const dd = await dr.json();
          const d  = dd.result || {};
          results.push({
            source:   'Google Places',
            name:     d.name || p.name || '',
            phone:    d.formatted_phone_number || null,
            website:  d.website || null,
            address:  d.formatted_address || p.vicinity || null,
            gf_name:  null, gf_phone: null, gf_email: null, email: null,
          });
        } catch {}
      }
    } catch (err) {
      console.error('[owner-search] Places error:', err.message);
    }
  }

  // ── WKO Firmensuche (puppeteer scrape) ──────────────────────────────────────
  if (address) {
    let browser;
    try {
      const puppeteer = require('puppeteer');
      const term = address.split(',').slice(0, 2).join(' ').trim();
      browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', req => {
        // Block images/fonts to speed up load
        if (['image','font','stylesheet'].includes(req.resourceType())) req.abort();
        else req.continue();
      });
      const wkoUrl = `https://firmen.wko.at/suche/?suchbegriff=${encodeURIComponent(term)}`;
      await page.goto(wkoUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Wait for results to appear
      await page.waitForSelector('.result-item, .firmen-list, .company-item, [class*="result"]', { timeout: 8000 }).catch(() => {});

      // Try to extract company cards from the page
      const wkoResults = await page.evaluate(() => {
        const cards = [];
        // WKO firmen.wko.at result structure (may change with site updates)
        const items = document.querySelectorAll(
          '.result-item, .listitem, [data-id], .firmen-eintrag, article.result'
        );
        items.forEach(el => {
          const name    = el.querySelector('h2,h3,.firm-name,.title,strong')?.innerText?.trim();
          const addr    = el.querySelector('.address,.adresse,[class*="addr"]')?.innerText?.trim();
          const phone   = el.querySelector('a[href^="tel:"]')?.innerText?.trim() ||
                          el.querySelector('.phone,.telefon')?.innerText?.trim();
          const website = el.querySelector('a[href^="http"]:not([href*="wko.at"])')?.href;
          if (name) cards.push({ name, address: addr || null, phone: phone || null, website: website || null });
        });
        return cards.slice(0, 3);
      });

      for (const c of wkoResults) {
        results.push({ source: 'WKO', ...c, gf_name: null, gf_phone: null, gf_email: null, email: null });
      }
    } catch (err) {
      console.error('[owner-search] WKO scrape failed:', err.message.slice(0, 80));
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  const addrShort = address.split(',').slice(0, 2).join(' ').trim();
  const addrQ     = encodeURIComponent(addrShort);
  const links     = {
    maps:       `https://www.google.com/maps/search/${addrQ}/@${lat},${lng},17z`,
    herold:     `https://www.herold.at/gelbes-telefonbuch/?what=&where=${addrQ}`,
    wko:        `https://firmen.wko.at/suche/?suchbegriff=${addrQ}`,
    firmenbuch: `https://www.firmenbuchabfrage.at/`,
  };

  res.json({ companies: results, links, places_enabled: placesEnabled });
});

// ── API: feedback / feature requests ─────────────────────────────────────────
const BUG_FILE = path.join(DATA_DIR, 'bug-reports.json');

app.post('/api/bug-report', express.json(), (req, res) => {
  const report = {
    id:          Date.now(),
    timestamp:   new Date().toISOString(),
    type:        req.body.type || 'other',   // 'feature' | 'bug' | 'other'
    description: req.body.description,
    zoom:        req.body.zoom,
    bbox:        req.body.bbox,
    user:        getAuthUser(req) || 'anonym',
  };
  let reports = [];
  if (fs.existsSync(BUG_FILE)) { try { reports = JSON.parse(fs.readFileSync(BUG_FILE)); } catch {} }
  reports.unshift(report);
  fs.writeFileSync(BUG_FILE, JSON.stringify(reports, null, 2));
  const emoji = { feature: '💡', bug: '🐛', other: '💬' }[report.type] || '💬';
  console.log(`[feedback] ${emoji} von ${report.user}: ${report.description?.slice(0, 80)}`);
  res.json({ ok: true, id: report.id });
});

// Admin: alle Feedbacks lesen
app.get('/api/admin/feedback', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const items = fs.existsSync(BUG_FILE)
      ? JSON.parse(fs.readFileSync(BUG_FILE)) : [];
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: einzelnen Feedback-Eintrag löschen
app.delete('/api/admin/feedback/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    let items = fs.existsSync(BUG_FILE) ? JSON.parse(fs.readFileSync(BUG_FILE)) : [];
    items = items.filter(i => String(i.id) !== String(req.params.id));
    fs.writeFileSync(BUG_FILE, JSON.stringify(items, null, 2));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ Mini-CRM (Leads) ═════════════════════════════════════════════════════════
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

function readLeads() {
  if (!fs.existsSync(LEADS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    return (Array.isArray(raw) ? raw : []).map(crm.normalizeLead);
  } catch { return []; }
}
function writeLeads(leads) {
  const out = (Array.isArray(leads) ? leads : []).map(crm.normalizeLead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(out, null, 2));
}

app.get('/api/gemeinden', (req, res) => {
  if (!fs.existsSync(GEMEINDEN_FILE)) return res.status(503).json({ error: 'Gemeindendaten fehlen' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.sendFile(path.resolve(GEMEINDEN_FILE));
});

app.get('/api/gemeinde-at', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'lat, lng' });
  const g = findGemeindeWithFeature(lat, lng);
  if (!g || !g.feature) return res.status(404).json({ error: 'Gemeinde nicht gefunden' });
  const b = turf.bbox(g.feature);
  res.json({ g_id: g.g_id, g_name: g.g_name, west: b[0], south: b[1], east: b[2], north: b[3] });
});

// GET all leads (sorted newest-updated first)
app.get('/api/leads', (req, res) => {
  if (!requireUser(req, res)) return;
  const leads = readLeads().sort((a, b) => (b.updated_at || b.created_at) > (a.updated_at || a.created_at) ? 1 : -1);
  res.json({ leads });
});

// GET single lead by OSM-ID
app.get('/api/leads/osm/:osm_id', (req, res) => {
  if (!requireUser(req, res)) return;
  const k = String(req.params.osm_id).trim();
  const lead = readLeads().find(l => String(l.osm_id).trim() === k);
  if (!lead) return res.status(404).json({ error: 'not found' });
  res.json({ lead });
});

// POST upsert – creates lead if not exists; returns existing one if already there
app.post('/api/leads/upsert', express.json(), async (req, res) => {
  if (!requireCrmWrite(req, res)) return;
  const { osm_id, type, data, stage: stageReq } = req.body;
  if (!osm_id) return res.status(400).json({ error: 'osm_id required' });
  const user = getAuthUser(req);
  const leads = readLeads();
  const osmKey = String(osm_id).trim();
  let lead = leads.find(l => String(l.osm_id).trim() === osmKey);
  if (!lead) {
    let initialStage = 'zu_recherchieren';
    if (stageReq !== undefined && stageReq !== null && String(stageReq).trim() !== '') {
      const s = crm.migrateStage(stageReq);
      if (crm.isValidStage(s)) initialStage = s;
    }
    const lat = data && data.lat != null ? +data.lat : NaN;
    const lng = data && data.lng != null ? +data.lng : NaN;
    if (!isFinite(lat) || !isFinite(lng)) {
      return res.status(400).json({ error: 'Für die Projekterstellung fehlen data.lat / data.lng' });
    }
    let dataFill = { ...(data || {}) };
    if (isMissingOrPlaceholderAddress(dataFill.address)) {
      try {
        const g = await reverseGeocodeLatLng(lat, lng);
        if (g) dataFill = { ...dataFill, address: g };
      } catch (e) {
        console.warn('[leads/upsert] Nominatim', e.message);
      }
    }
    const f = buildNewProjectFields(lat, lng, leads);
    lead = {
      id:         'lead_' + Date.now(),
      project_nr: f.project_nr,
      naming_key: f.naming_key,
      local_seq:  f.local_seq,
      g_id:       f.g_id,
      g_name:     f.g_name,
      trafo_tst:  f.trafo_tst,
      nearest_trafo_id: f.nearest_trafo_id,
      name:       f.name,
      osm_id:     osmKey,
      type:       type || 'building',
      stage:      initialStage,
      vollmacht_bestaetigt: false,
      account_id: null,
      data_overrides: {},
      stakeholders:  [],
      contact:    { name: '', phone: '', email: '' },
      notes:      [],
      data:       dataFill,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: user || 'anonym',
    };
    lead = crm.normalizeLead(lead);
    leads.unshift(lead);
    writeLeads(leads);
    appendAudit({ user, action: 'lead_create', target_type: 'lead', target_id: lead.id, meta: { osm_id: String(osm_id) } });
  }
  res.json({ lead });
});

// PATCH lead – Stage, Namen, Kontakt, Stakeholder, Account, Overrides …
app.patch('/api/leads/:id', express.json(), (req, res) => {
  if (!requireCrmWrite(req, res)) return;
  const user = getAuthUser(req);
  const leads = readLeads();
  const idx   = leads.findIndex(l => l.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  let lead    = leads[idx];
  if (req.body.stage !== undefined) {
    const s = crm.migrateStage(req.body.stage);
    if (!crm.isValidStage(s)) return res.status(400).json({ error: 'Ungültige Stufe' });
    if (s !== lead.stage) appendAudit({ user, action: 'stage', target_type: 'lead', target_id: lead.id, meta: { from: lead.stage, to: s } });
    lead.stage = s;
  }
  if (req.body.contact !== undefined) lead.contact = { ...lead.contact, ...req.body.contact };
  if (req.body.name !== undefined) lead.name = req.body.name;
  if (req.body.vollmacht_bestaetigt !== undefined) {
    const v = !!req.body.vollmacht_bestaetigt;
    if (v !== lead.vollmacht_bestaetigt) {
      appendAudit({ user, action: 'vollmacht_bestaetigt', target_type: 'lead', target_id: lead.id, meta: { value: v } });
    }
    lead.vollmacht_bestaetigt = v;
  }
  if (req.body.account_id !== undefined) {
    const aid = req.body.account_id;
    lead.account_id = aid === null || aid === '' ? null : String(aid);
  }
  if (req.body.account_ids !== undefined) {
    if (!Array.isArray(req.body.account_ids)) return res.status(400).json({ error: 'account_ids[] erwartet' });
    lead.account_ids = req.body.account_ids
      .map((x) => String(x == null ? '' : x).trim())
      .filter(Boolean);
    lead.account_id = lead.account_ids[0] || null;
  }
  if (req.body.stakeholders !== undefined) {
    if (!Array.isArray(req.body.stakeholders)) return res.status(400).json({ error: 'stakeholders[] erwartet' });
    lead.stakeholders = req.body.stakeholders.map((x, i) => ({
      id: String(x.id || `s-${i}-${Date.now()}`),
      name: x.name != null ? String(x.name) : '',
      function: x.function != null ? String(x.function) : '',
      phone: x.phone != null ? String(x.phone) : '',
      email: x.email != null ? String(x.email) : '',
      is_primary: !!x.is_primary,
      created_at: x.created_at || new Date().toISOString(),
    }));
    if (!lead.stakeholders.some(s => s.is_primary) && lead.stakeholders.length) lead.stakeholders[0].is_primary = true;
    if (lead.stakeholders.filter(s => s.is_primary).length > 1) {
      let seen = false;
      for (const s of lead.stakeholders) {
        if (s.is_primary) { if (seen) s.is_primary = false; else seen = true; }
      }
    }
  }
  if (req.body.data_overrides !== undefined && typeof req.body.data_overrides === 'object' && req.body.data_overrides) {
    lead.data_overrides = { ...lead.data_overrides, ...req.body.data_overrides };
  }
  if (req.body.data !== undefined && typeof req.body.data === 'object' && req.body.data) {
    lead.data = { ...lead.data, ...req.body.data };
  }
  lead = crm.normalizeLead(lead);
  lead.updated_at = new Date().toISOString();
  leads[idx] = lead;
  writeLeads(leads);
  res.json({ lead: leads[idx] });
});

// POST add note to lead
app.post('/api/leads/:id/notes', express.json(), (req, res) => {
  if (!requireUser(req, res)) return;
  const u = getAuthUser(req);
  const text = req.body?.text?.trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const leads = readLeads();
  const lead  = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const note = {
    id:     Date.now(),
    ts:     new Date().toISOString(),
    text,
    author: u || 'anonym',
  };
  lead.notes.unshift(note);
  lead.updated_at = new Date().toISOString();
  writeLeads(leads);
  appendAudit({ user: u, action: 'note_add', target_type: 'lead', target_id: lead.id, meta: {} });
  res.json({ lead: crm.normalizeLead(lead) });
});

// DELETE single note from lead
app.delete('/api/leads/:id/notes/:nid', (req, res) => {
  if (!requireVertriebOrAdmin(req, res)) return;
  const leads = readLeads();
  const lead  = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  lead.notes  = lead.notes.filter(n => String(n.id) !== String(req.params.nid));
  lead.updated_at = new Date().toISOString();
  writeLeads(leads);
  appendAudit({ user: getAuthUser(req), action: 'note_delete', target_type: 'lead', target_id: lead.id, meta: {} });
  res.json({ lead: crm.normalizeLead(lead) });
});

// DELETE lead
app.delete('/api/leads/:id', (req, res) => {
  if (!requireVertriebOrAdmin(req, res)) return;
  let leads = readLeads();
  if (!leads.some(l => l.id === req.params.id)) return res.status(404).json({ error: 'not found' });
  appendAudit({ user: getAuthUser(req), action: 'lead_delete', target_type: 'lead', target_id: req.params.id, meta: {} });
  writeLeads(leads.filter(l => l.id !== req.params.id));
  res.json({ ok: true });
});

registerCrmRoutes(app, {
  DATA_DIR,
  BLD_SIMPLE_FILE,
  ACCOUNTS_FILE,
  getAuthUser,
  getRole,
  requireUser,
  requireCrmWrite,
  requireVertriebOrAdmin,
  requireAdmin,
  readLeads,
  writeLeads,
  appendAudit,
  buildNewProjectFields,
  ADMIN_USER,
  VALID_USERNAME,
});

// ── API: trigger full Trafo scrape (admin only, background process) ───────────
// Runs `node src/trafo-scanner.js` — same source as scheduled cron; reads EVN WMS
// from TRAFO_MAP_URL (tile raster + GetFeatureInfo). Returns immediately (202).
app.post('/api/scan', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (_trafoScanJob.running)
    return res.status(409).json({
      error:   'Ein Trafo-Scan läuft bereits.',
      started: _trafoScanJob.startedAt,
      pid:     _trafoScanJob.pid,
    });
  if (!process.env.TRAFO_MAP_URL)
    return res.status(503).json({ error: 'TRAFO_MAP_URL ist auf dem Server nicht gesetzt.' });

  const appRoot = path.join(__dirname, '..');
  const script  = path.join(__dirname, 'trafo-scanner.js');
  const child   = spawn(process.execPath, [script], {
    cwd:   appRoot,
    env:   process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  _trafoScanJob = {
    running:   true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode:  null,
    pid:       child.pid,
    logTail:   '',
    error:     null,
  };
  let buf = '';
  const append = chunk => {
    buf += chunk.toString();
    if (buf.length > 12000) buf = buf.slice(-12000);
    _trafoScanJob.logTail = buf;
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', err => {
    _trafoScanJob.running   = false;
    _trafoScanJob.finishedAt = new Date().toISOString();
    _trafoScanJob.exitCode  = -1;
    _trafoScanJob.error     = err.message;
    console.error('[api/scan] spawn error:', err.message);
  });
  child.on('exit', (code, signal) => {
    _trafoScanJob.running    = false;
    _trafoScanJob.finishedAt = new Date().toISOString();
    _trafoScanJob.exitCode   = signal ? -1 : code;
    if (signal) _trafoScanJob.error = `Signal: ${signal}`;
    console.log(`[api/scan] trafo-scanner exited code=${code} signal=${signal || 'none'}`);
  });

  res.status(202).json({
    ok:       true,
    started:  true,
    pid:      child.pid,
    message:  'Trafo-Vollscan gestartet (läuft auf dem Server, mehrere Minuten). Status unten aktualisieren.',
    poll_url: '/api/scan/status',
  });
});

app.get('/api/scan/status', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let latest = null;
  try {
    if (fs.existsSync(LATEST)) latest = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
  } catch {}
  res.json({
    running:           _trafoScanJob.running,
    started_at:      _trafoScanJob.startedAt,
    finished_at:     _trafoScanJob.finishedAt,
    exit_code:       _trafoScanJob.exitCode,
    pid:             _trafoScanJob.pid,
    spawn_error:     _trafoScanJob.error,
    log_tail:        (_trafoScanJob.logTail || '').slice(-3500),
    latest_count:    latest?.count ?? null,
    latest_scanned_at: latest?.scanned_at ?? null,
    data_source:     'EVN WMS (TRAFO_MAP_URL) + src/trafo-scanner.js',
  });
});

// ─── Email notification ───────────────────────────────────────────────────────

async function sendNewGreenNotification(improved) {
  if (!process.env.MY_EMAIL || !process.env.SMTP_HOST) {
    console.log('[email] SMTP not configured — skipping notification.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const listHtml = improved
    .map(t => `<li><strong>${t.name}</strong> — ${t.old_status} → <span style="color:green">${t.new_status}</span> (${t.lat}, ${t.lng})</li>`)
    .join('\n');

  const html = `
    <h2>Neue freie Trafo-Kapazitäten entdeckt</h2>
    <p>${improved.length} Trafo(s) haben sich seit dem letzten Scan verbessert:</p>
    <ul>${listHtml}</ul>
    <p>Dashboard öffnen: <a href="http://localhost:${PORT}">http://localhost:${PORT}</a></p>
  `;

  await transporter.sendMail({
    from:    process.env.SMTP_USER,
    to:      process.env.MY_EMAIL,
    subject: `[Trafo-Scanner] ${improved.length} Trafo(s) mit neuer Kapazität`,
    html,
  });

  console.log(`[email] Notification sent to ${process.env.MY_EMAIL}`);
}

// ─── Scheduled 90-day scan ────────────────────────────────────────────────────
//
// Cron expression: runs at 06:00 on the 1st of every 3rd month.
// This approximates a 90-day / quarterly cycle.
// For exact 90-day intervals, use setInterval with 90 * 24 * 60 * 60 * 1000.

async function runScheduledScan() {
  console.log('[cron] Running scheduled 90-day scan…');

  // Load previous latest before overwriting
  let previousScan = null;
  if (fs.existsSync(LATEST)) {
    try { previousScan = JSON.parse(fs.readFileSync(LATEST)); } catch {}
  }

  const newScan = await scanTrafos();

  // Compare with previous scan to find improvements
  if (previousScan && previousScan.trafos && newScan.trafos) {
    const changes = compareScans(previousScan, newScan);
    const improved = changes.filter(c =>
      c.direction === 'improved' &&
      (c.new_status === 'free' || c.new_status === 'partial')
    );

    console.log(`[cron] Changes: ${changes.length} total, ${improved.length} improved to green`);

    if (improved.length > 0) {
      await sendNewGreenNotification(improved);
    }
  }
}

// ── API: NÖ-weiter Flächen-Scan ───────────────────────────────────────────────
// Durchsucht ALLE passenden Trafos und findet Freiflächen in deren Nähe.
// Ergebnis wird 30 Min. gecacht. Timeout Overpass: 120 s.

const _scanCache = new Map();
const SCAN_TTL   = 30 * 60 * 1000;

app.get('/api/scan-open-areas', async (req, res) => {
  const statusFilter = (req.query.status || 'free').split(',').filter(Boolean);
  const minArea = Math.max(100, parseFloat(req.query.min_area) || 1000);
  const maxDist = Math.max(50,  parseFloat(req.query.max_dist) || 200);
  const sortBy  = req.query.sort || 'kwp'; // kwp | area | dist

  const cacheKey = `scan:${statusFilter.slice().sort().join(',')}:${minArea}:${maxDist}`;
  const hit = _scanCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < SCAN_TTL) {
    let areas = hit.result.areas;
    if (sortBy === 'area') areas = [...areas].sort((a, b) => b.area_m2  - a.area_m2);
    else if (sortBy === 'dist') areas = [...areas].sort((a, b) => a.distance_to_trafo_m - b.distance_to_trafo_m);
    return res.json({ ...hit.result, areas });
  }

  if (!fs.existsSync(LATEST)) return res.status(503).json({ error: 'no trafo data' });
  const allTrafos      = JSON.parse(fs.readFileSync(LATEST)).trafos || [];
  const filteredTrafos = allTrafos.filter(t => statusFilter.includes(t.status));
  if (!filteredTrafos.length)
    return res.json({ count: 0, areas: [], generated_at: new Date().toISOString(), filter: { statusFilter, minArea, maxDist }, trafo_count: 0 });

  // Bounding box aller gefilterten Trafos + Puffer
  const bufDeg = maxDist / 111000;
  const cosLat = Math.cos(48 * Math.PI / 180);
  const south  = Math.min(...filteredTrafos.map(t => t.lat)) - bufDeg;
  const north  = Math.max(...filteredTrafos.map(t => t.lat)) + bufDeg;
  const west   = Math.min(...filteredTrafos.map(t => t.lng)) - bufDeg / cosLat;
  const east   = Math.max(...filteredTrafos.map(t => t.lng)) + bufDeg / cosLat;
  const bb     = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;

  const luList = OA_LANDUSE.join('|');
  // Query both simple ways AND multipolygon relations to capture large industrial parks
  const query  = `[out:json][timeout:120];(way["landuse"~"^(${luList})$"](${bb});relation["landuse"~"^(${luList})$"]["type"="multipolygon"](${bb}););out body;>;out skel qt;`;

  try {
    const r = await overpassInterpreter(query, 130000);
    const data = await r.json();
    const rawAreas = _parseOsmAreas(data, minArea);

    // Jeder Fläche den nächsten passenden Trafo zuordnen
    const results = [];
    for (const a of rawAreas) {
      let nearestTrafo = null, nearestDist = Infinity;
      for (const t of filteredTrafos) {
        const d = distM({ lat: a.lat, lng: a.lng }, { lat: t.lat, lng: t.lng });
        if (d < nearestDist) { nearestDist = d; nearestTrafo = t; }
      }
      if (!nearestTrafo || nearestDist > maxDist) continue;
      results.push({
        ...a,
        distance_to_trafo_m:  Math.round(nearestDist),
        nearest_trafo_id:     nearestTrafo.id || null,
        nearest_trafo_tst_id: nearestTrafo.tst_id || null,
        nearest_trafo_status: nearestTrafo.status,
      });
    }

    results.sort((a, b) => b.kwp - a.kwp); // default: nach kWp

    const result = {
      count:          results.length,
      areas:          results,
      generated_at:   new Date().toISOString(),
      filter:         { statusFilter, minArea, maxDist },
      trafo_count:    filteredTrafos.length,
      overpass_ways:  rawAreas.length + data.elements.filter(e => e.type === 'node').length,
    };
    _scanCache.set(cacheKey, { ts: Date.now(), result });
    res.json(result);
  } catch (err) {
    console.error('[/api/scan-open-areas]', err.message);
    res.status(503).json({ error: err.message });
  }
});

// ── API: NÖ-weiter Dach-Scan (Gewerbe/Industrie-Dächer) ───────────────────────
// Gleiche logische Region wie Flächen-Scan: BBox um gefilterte Trafos, dann OSM.
const _scanBldCache = new Map();
app.get('/api/scan-buildings', async (req, res) => {
  const statusFilter = (req.query.status || 'free').split(',').filter(Boolean);
  const minArea = Math.max(100, parseFloat(req.query.min_area) || 1000);
  const maxDist = Math.max(50, parseFloat(req.query.max_dist) || 200);
  const sortBy  = req.query.sort || 'kwp';
  const cacheKey = `scanB:${statusFilter.slice().sort().join(',')}:${minArea}:${maxDist}`;
  const hit = _scanBldCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < SCAN_TTL) {
    let buildings = hit.result.buildings;
    if (sortBy === 'area') buildings = [...buildings].sort((a, b) => b.roof_area_m2 - a.roof_area_m2);
    else if (sortBy === 'dist') buildings = [...buildings].sort((a, b) => a.distance_to_trafo_m - b.distance_to_trafo_m);
    return res.json({ ...hit.result, buildings });
  }

  if (!fs.existsSync(LATEST)) return res.status(503).json({ error: 'no trafo data' });
  const allTrafos     = JSON.parse(fs.readFileSync(LATEST, 'utf8')).trafos || [];
  const filteredTrafos = allTrafos.filter(t => statusFilter.includes(t.status));
  if (!filteredTrafos.length) {
    return res.json({ count: 0, buildings: [], generated_at: new Date().toISOString(), filter: { statusFilter, minArea, maxDist }, trafo_count: 0, scan_kind: 'roof' });
  }
  const bufDeg = maxDist / 111000;
  const cosLatC = Math.cos(48 * Math.PI / 180);
  const south  = Math.min(...filteredTrafos.map(t => t.lat)) - bufDeg;
  const north  = Math.max(...filteredTrafos.map(t => t.lat)) + bufDeg;
  const west   = Math.min(...filteredTrafos.map(t => t.lng)) - bufDeg / cosLatC;
  const east   = Math.max(...filteredTrafos.map(t => t.lng)) + bufDeg / cosLatC;
  const bb     = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
  const bTag = 'industrial|warehouse|factory|commercial|retail|supermarket|hangar|storage_tank|shed';
  const query = `[out:json][timeout:120];
(way["building"~"^(${bTag})$"](${bb}););out body;>;out skel qt;`;
  try {
    const r = await overpassInterpreter(query, 130000);
    const data = await r.json();
    const nodeMap = new Map();
    for (const el of data.elements) {
      if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lng: el.lon });
    }
    const localTrafos = filteredTrafos;
    const out = [];
    for (const el of data.elements) {
      if (el.type !== 'way' || !el.tags || !el.tags.building) continue;
      const nodes = (el.nodes || []).map(id => nodeMap.get(id)).filter(Boolean);
      if (nodes.length < 3) continue;
      const area = _polyArea(nodes);
      if (area < minArea) continue;
      const lat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
      const lng = nodes.reduce((s, n) => s + n.lng, 0) / nodes.length;
      let nearestTrafo = null, nearestDist = Infinity;
      for (const t of localTrafos) {
        const d = distM({ lat, lng }, { lat: t.lat, lng: t.lng });
        if (d < nearestDist) { nearestDist = d; nearestTrafo = t; }
      }
      if (!nearestTrafo || nearestDist > maxDist) continue;
      const roofArea  = Math.round(area);
      const calc      = _calcKwp(roofArea);
      out.push({
        osm_id:        el.id,
        lat:           parseFloat(lat.toFixed(6)),
        lng:           parseFloat(lng.toFixed(6)),
        roof_area_m2:  roofArea,
        area_m2:       roofArea,
        building_type: el.tags.building,
        polygon:       nodes.map(nd => [nd.lat, nd.lng]),
        address:       null,
        distance_to_trafo_m: Math.round(nearestDist),
        nearest_trafo_id:     nearestTrafo.id || null,
        nearest_trafo_tst_id:  nearestTrafo.tst_id || null,
        nearest_trafo_status:  nearestTrafo.status,
        kwp:          calc.kwp,
        kwh_year:     calc.kwh_year,
        usable_area:  calc.usable_area,
        modules:      calc.modules,
        address:      formatAddressFromOsmTags(el.tags) || null,
        atlas_url:    `https://atlas.noe.gv.at/atlas/portal/noe-atlas/map/Planung%20und%20Kataster/Grundst%C3%BCcke?center=${lng.toFixed(6)},${lat.toFixed(6)}&level=18`,
      });
    }
    out.sort((a, b) => b.kwp - a.kwp);
    const result = {
      count:   out.length,
      buildings: out,
      generated_at: new Date().toISOString(),
      filter:  { statusFilter, minArea, maxDist, scan_kind: 'roof' },
      trafo_count: filteredTrafos.length,
      scan_kind:   'roof',
    };
    _scanBldCache.set(cacheKey, { ts: Date.now(), result: { ...result, buildings: out } });
    res.json(result);
  } catch (err) {
    console.error('[/api/scan-buildings]', err.message);
    res.status(503).json({ error: err.message });
  }
});

// Schedule: 06:00 on day 1 of Jan, Apr, Jul, Oct (quarterly ≈ 90 days)
cron.schedule('0 6 1 1,4,7,10 *', () => {
  runScheduledScan().catch(err => console.error('[cron] Scan failed:', err));
});

console.log('[cron] Scheduled quarterly scan (1 Jan, 1 Apr, 1 Jul, 1 Oct at 06:00).');

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Dashboard running at http://localhost:${PORT}`);
});
