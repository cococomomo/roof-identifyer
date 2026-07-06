/**
 * Zusatz-Routen: CRM-Pipeline, Firmen, Export, Audit, GIS-Sync, /crm-Seite
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crm = require('./crm-core');
const nominatim = require('./nominatim-helpers');

const BLD_SIMPLE_FILE_NAME = 'opportunities-simple.json';

let _bldIndexCache = { ts: 0, byOsm: new Map() };

function loadBuildingIndex(bldFile) {
  const now = Date.now();
  if (now - _bldIndexCache.ts < 60_000 && _bldIndexCache.byOsm.size) return _bldIndexCache.byOsm;
  const byOsm = new Map();
  if (fs.existsSync(bldFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(bldFile, 'utf8'));
      for (const b of d.buildings || []) {
        if (b.osm_id != null) byOsm.set(String(b.osm_id), b);
      }
    } catch (e) {
      console.error('[crm] opportunities-simple', e.message);
    }
  }
  _bldIndexCache = { ts: now, byOsm: byOsm };
  return byOsm;
}

function readAccounts(accountsFile) {
  if (!fs.existsSync(accountsFile)) return [];
  try {
    const a = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function writeAccounts(accountsFile, list) {
  fs.writeFileSync(accountsFile, JSON.stringify(list, null, 2));
}

function normalizeAccountName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('de-AT');
}

function sanitizeAccountDraft(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function getLeadAccountIds(lead) {
  const ids = Array.isArray(lead && lead.account_ids) ? lead.account_ids : [];
  const out = ids
    .map((id) => String(id == null ? '' : id).trim())
    .filter(Boolean);
  if (!out.length && lead && lead.account_id != null) {
    const primary = String(lead.account_id).trim();
    if (primary) out.push(primary);
  }
  return Array.from(new Set(out));
}

function buildAccountUsage(accounts, leads) {
  const usage = new Map();
  for (const lead of leads || []) {
    for (const aid of getLeadAccountIds(lead)) {
      if (!usage.has(aid)) usage.set(aid, []);
      usage.get(aid).push(lead);
    }
  }
  return (accounts || []).map((acc) => {
    const projects = (usage.get(String(acc.id)) || []).slice()
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    return {
      ...acc,
      norm_name: normalizeAccountName(acc.name),
      project_count: projects.length,
      project_ids: projects.map((p) => p.id),
      project_labels: projects.slice(0, 8).map((p) => (
        (p.project_nr != null ? `P-${String(p.project_nr).padStart(3, '0')}` : 'Projekt') +
        (p.name ? ` · ${p.name}` : '')
      )),
    };
  });
}

function findAccountByName(accounts, name) {
  const norm = normalizeAccountName(name);
  if (!norm) return null;
  return (accounts || []).find((acc) => normalizeAccountName(acc.name) === norm) || null;
}

function googleMapsUrl(lat, lng) {
  if (lat == null || lng == null) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(lat) + ',' + String(lng))}`;
}

function osmStaticPreviewUrl(lat, lng) {
  if (lat == null || lng == null) return '';
  // Öffentliches OpenStreetMap-Static-Map (Mosaik) – nur Vorschau, Nutzung mit OSM-Attribution in UI
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=18&size=400x300&maptype=mapnik`;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[;\r\n"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const VALID_ROLES = new Set(['admin', 'vertrieb', 'assistenz']);

/**
 * @param {import('express').Application} app
 * @param {object} o
 */
function registerCrmRoutes(app, o) {
  const {
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
  } = o;

  const bldFile = BLD_SIMPLE_FILE || path.join(DATA_DIR, BLD_SIMPLE_FILE_NAME);
  const buildNewProjectFields = o.buildNewProjectFields;

  // Gefilterte Scan-Ergebnisse → CRM-Leads (fehlende OSM-IDs anlegen)
  app.post('/api/crm/seed-from-scan', require('express').json({ limit: '20mb' }), async (req, res) => {
    if (!requireCrmWrite(req, res)) return;
    if (typeof buildNewProjectFields !== 'function') {
      return res.status(500).json({ error: 'buildNewProjectFields fehlt' });
    }
    const items  = Array.isArray(req.body?.items) ? req.body.items : [];
    const kind   = (req.body?.kind || 'open').toString(); // 'roof' | 'open'
    if (!items.length) return res.status(400).json({ error: 'items[] leer' });
    const type = kind === 'roof' ? 'building' : 'open_area';
    const leads  = readLeads();
    const totalBefore = leads.length;
    let created = 0, skipped = 0;
    let geocoded = 0;
    try {
      for (const row of items) {
        const osm = row && row.osm_id != null ? String(row.osm_id).trim() : '';
        if (!osm) continue;
        if (leads.some(l => String(l.osm_id).trim() === osm)) { skipped++; continue; }
        const lat = row.lat != null ? +row.lat : NaN;
        const lng = row.lng != null ? +row.lng : NaN;
        if (!isFinite(lat) || !isFinite(lng)) continue;
        const f  = buildNewProjectFields(lat, lng, leads);
        const data = { ...row };
        if (nominatim.isMissingOrPlaceholderAddress(data.address)) {
          try {
            const g = await nominatim.reverseGeocodeLatLng(lat, lng);
            if (g) {
              data.address = g;
              geocoded++;
            }
          } catch (e) {
            console.warn('[crm seed] nominatim', e.message);
          }
        }
        const lead = {
          id:         'lead_' + Date.now() + '_' + created + '_' + osm,
          project_nr: f.project_nr,
          naming_key: f.naming_key,
          local_seq:  f.local_seq,
          g_id:       f.g_id,
          g_name:     f.g_name,
          trafo_tst:  f.trafo_tst,
          nearest_trafo_id: f.nearest_trafo_id,
          name:       f.name,
          osm_id:     osm,
          type,
          stage:                 'zu_recherchieren',
          vollmacht_bestaetigt:  false,
          account_id:            null,
          data_overrides:        {},
          stakeholders:         [],
          contact:               { name: '', phone: '', email: '' },
          notes:                 [],
          data,
          created_at:  new Date().toISOString(),
          updated_at:  new Date().toISOString(),
          created_by:  getAuthUser(req) || 'anonym',
          seeded_from: 'scan',
        };
        leads.unshift(crm.normalizeLead(lead));
        created++;
      }
      writeLeads(leads);
      console.log(`[crm seed-from-scan] kind=${kind} before=${totalBefore} after=${leads.length} created=${created} skipped=${skipped} nominatim=${geocoded}`);
      appendAudit({ user: getAuthUser(req), action: 'crm_seed', target_type: 'crm', target_id: '', meta: { created, skipped, kind, totalBefore, totalAfter: leads.length, geocoded } });
      res.json({ ok: true, created, skipped, totalLeads: leads.length, geocoded });
    } catch (e) {
      console.error('[crm seed-from-scan]', e);
      res.status(500).json({ error: e.message || 'seed failed' });
    }
  });

  // Rolle setzen (Admin)
  app.post('/api/admin/user-role', require('express').json(), (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { username, role } = req.body || {};
    if (!username || !VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'username und role (admin|vertrieb|assistenz) erforderlich' });
    }
    const { ADMIN_USER, VALID_USERNAME } = o;
    if (VALID_USERNAME && !VALID_USERNAME.test(username)) {
      return res.status(400).json({ error: 'Ungültiger Benutzername' });
    }
    if (ADMIN_USER && String(username) === String(ADMIN_USER) && role !== 'admin') {
      return res.status(400).json({ error: 'Der Haupt-Admin-Account muss die Rolle Admin behalten.' });
    }
    const f = path.join(DATA_DIR, 'user-roles.json');
    const cur = (() => {
      if (!fs.existsSync(f)) return {};
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
    })();
    cur[username] = role;
    fs.writeFileSync(f, JSON.stringify(cur, null, 2));
    appendAudit({ user: getAuthUser(req), action: 'user_role', target_type: 'user', target_id: username, meta: { role } });
    res.json({ ok: true, username, role });
  });

  // Firmen (Stakeholder)
  app.get('/api/crm/accounts', (req, res) => {
    if (!requireUser(req, res)) return;
    const accounts = buildAccountUsage(readAccounts(ACCOUNTS_FILE), readLeads());
    res.json({ accounts });
  });
  app.post('/api/crm/accounts', require('express').json(), (req, res) => {
    if (!requireCrmWrite(req, res)) return;
    const name = sanitizeAccountDraft(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name' });
    const list = readAccounts(ACCOUNTS_FILE);
    const existing = findAccountByName(list, name);
    if (existing) {
      return res.json({ account: existing, created: false, duplicate: true });
    }
    const acc = {
      id:  'acc_' + Date.now(),
      name,
      note: (req.body?.note || '').trim(),
      created_at: new Date().toISOString(),
    };
    list.push(acc);
    writeAccounts(ACCOUNTS_FILE, list);
    appendAudit({ user: getAuthUser(req), action: 'account_create', target_type: 'account', target_id: acc.id, meta: { name } });
    res.json({ account: acc });
  });
  app.patch('/api/crm/accounts/:id', require('express').json(), (req, res) => {
    if (!requireCrmWrite(req, res)) return;
    const list = readAccounts(ACCOUNTS_FILE);
    const acc = list.find(x => x.id === req.params.id);
    if (!acc) return res.status(404).json({ error: 'not found' });
    if (req.body.name != null) {
      const nextName = sanitizeAccountDraft(req.body.name);
      if (!nextName) return res.status(400).json({ error: 'name' });
      const clash = list.find((x) => x.id !== acc.id && normalizeAccountName(x.name) === normalizeAccountName(nextName));
      if (clash) return res.status(409).json({ error: 'Firma existiert bereits', account: clash });
      acc.name = nextName;
    }
    if (req.body.note != null) acc.note = String(req.body.note);
    acc.updated_at = new Date().toISOString();
    writeAccounts(ACCOUNTS_FILE, list);
    res.json({ account: acc });
  });

  function buildPipeline() {
    const idx = loadBuildingIndex(bldFile);
    const accList = readAccounts(ACCOUNTS_FILE);
    const leads = readLeads();
    const accSummary = buildAccountUsage(accList, leads);
    const byAcc = new Map(accSummary.map(a => [a.id, a]));
    const merged = leads.map(lead => {
      const b = idx.get(String(lead.osm_id));
      const L = b ? crm.mergeBuildingIntoLead(lead, b) : crm.normalizeLead(lead);
      const a = L.account_id ? byAcc.get(L.account_id) : null;
      const lat = L.data && L.data.lat;
      const lng = L.data && L.data.lng;
      return {
        ...L,
        account_name: a ? a.name : null,
        account_project_count: a ? a.project_count : 0,
        sort_distance_m: crm.effectiveDistanceM(L),
        sort_roof_m2: crm.effectiveRoofArea(L),
        sort_kwp: crm.effectiveKwp(L),
        google_maps_url: googleMapsUrl(lat, lng),
        preview_map_url: osmStaticPreviewUrl(lat, lng),
        dedupe_key: `osm:${L.osm_id}`,
      };
    });
    merged.sort(crm.compareLeads);
    return { merged, accList, idx };
  }

  app.get('/api/crm/pipeline', (req, res) => {
    if (!requireUser(req, res)) return;
    const { merged } = buildPipeline();
    res.json({
      leads: merged,
      stages: crm.CRM_STAGES,
      stageLabels: crm.STAGE_LABELS,
    });
  });

  // GIS-Sync: aktuelle opportunities-simple in lead.data mischen; ggf. Nominatim für fehlende Adresse
  app.post('/api/leads/:id/sync-gis', async (req, res) => {
    if (!requireCrmWrite(req, res)) return;
    const idx = loadBuildingIndex(bldFile);
    const leads = readLeads();
    const i = leads.findIndex(l => l.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'not found' });
    const b = idx.get(String(leads[i].osm_id));
    if (!b) return res.status(404).json({ error: 'Gebäude nicht in opportunities-simple' });
    leads[i] = crm.mergeBuildingIntoLead(leads[i], b);
    const lat = leads[i].data && leads[i].data.lat;
    const lng = leads[i].data && leads[i].data.lng;
    if (nominatim.isMissingOrPlaceholderAddress(leads[i].data && leads[i].data.address) && isFinite(+lat) && isFinite(+lng)) {
      try {
        const g = await nominatim.reverseGeocodeLatLng(+lat, +lng);
        if (g) leads[i].data = { ...leads[i].data, address: g };
      } catch (e) { console.warn('[sync-gis] nominatim', e.message); }
    }
    leads[i].updated_at = new Date().toISOString();
    leads[i] = crm.normalizeLead(leads[i]);
    writeLeads(leads);
    appendAudit({ user: getAuthUser(req), action: 'sync_gis', target_type: 'lead', target_id: leads[i].id, meta: {} });
    res.json({ lead: leads[i] });
  });

  app.get('/api/crm/audit', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(500, Math.max(20, parseInt(req.query.limit, 10) || 150));
    const auditPath = path.join(DATA_DIR, 'audit.json');
    if (!fs.existsSync(auditPath)) return res.json({ entries: [] });
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(auditPath, 'utf8')); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    res.json({ entries: arr.slice(-limit).reverse() });
  });

  // CSV-Export: UTF-8 mit BOM, Semikolon
  app.get('/api/crm/export.csv', (req, res) => {
    if (!requireUser(req, res)) return;
    const { merged } = buildPipeline();
    const stageF = (req.query.stage || '').trim();
    const minM2 = parseFloat(req.query.min_m2);
    const maxDist = parseFloat(req.query.max_dist);
    let rows = merged;
    if (stageF) rows = rows.filter(x => x.stage === stageF);
    if (isFinite(minM2)) rows = rows.filter(x => crm.effectiveRoofArea(x) >= minM2);
    if (isFinite(maxDist)) rows = rows.filter(x => crm.effectiveDistanceM(x) <= maxDist);
    // Dedup OSM: bereits ein lead pro osm
    const seen = new Set();
    rows = rows.filter(x => {
      const k = x.dedupe_key;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const header = [
      'projekt_nr', 'projekt_name', 'osm_id', 'pipeline_stufe', 'vollmacht_bestaetigt',
      'firma', 'stakeholder', 'kontakt_primär',
      'lat', 'lng', 'adresse', 'trafo_m', 'dach_m2', 'nutzbar_m2', 'kwp', 'kwh_a',
      'trafo_tst', 'trafo_id', 'trafo_status',
      'atlas', 'google_maps', 'vorschau_karte', 'projektbeschreibung',
      'erinnerung_datum', 'erinnerung_label', 'crm_notizen',
      'zuletzt_geändert', 'erstellt',
    ];
    const lines = [header.map(csvEscape).join(';')];
    for (const L of rows) {
      const d = L.data || {};
      const prim = (L.stakeholders || []).find(s => s.is_primary) || (L.stakeholders || [])[0];
      const stText = (L.stakeholders || [])
        .map(s => [s.name, s.function, s.phone, s.email].filter(Boolean).join(' '))
        .join(' | ');
      const pnr = L.project_nr != null ? L.project_nr : '';
      const usable = d.usable_area != null ? d.usable_area : d.usable_area_m2;
      lines.push([
        pnr, L.name, L.osm_id, L.stage, L.vollmacht_bestaetigt ? 'ja' : 'nein',
        L.account_name || '', stText, prim ? [prim.name, prim.phone, prim.email].filter(Boolean).join(' · ') : '',
        d.lat, d.lng, d.address || '', crm.effectiveDistanceM(L), crm.effectiveRoofArea(L), usable, crm.effectiveKwp(L), d.kwh_year,
        d.nearest_trafo_tst_id != null ? `TST-${d.nearest_trafo_tst_id}` : '', d.nearest_trafo_id || '', d.nearest_trafo_status || '',
        d.atlas_url || '', L.google_maps_url, L.preview_map_url,
        d.project_description || '',
        d.reminder_at || '', d.reminder_label || '', d.crm_notes || '',
        L.updated_at, L.created_at,
      ].map(csvEscape).join(';'));
    }
    const bom = '\uFEFF';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="crm-export.csv"');
    res.send(bom + lines.join('\r\n'));
    appendAudit({ user: getAuthUser(req), action: 'export_csv', target_type: 'crm', target_id: '', meta: { rows: rows.length, stage: stageF || null } });
  });
}

module.exports = { registerCrmRoutes, googleMapsUrl, osmStaticPreviewUrl };
