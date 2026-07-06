/**
 * CRM: Pipeline-Stufen, Sortierung, Lead-Normalisierung, Merge mit Gebäude-Daten
 */

const CRM_STAGES = [
  'zu_recherchieren',
  'recherche_begonnen',
  'anrufversuch',
  'infos_vollmacht_versendet',
  'vollmacht_erhalten',
  'vororttermin',
  'netzpruefung_positiv',
  'verworfen',
];

const STAGE_LABELS = {
  zu_recherchieren: 'Zu recherchieren',
  recherche_begonnen: 'Recherche begonnen',
  anrufversuch: 'Anrufversuch',
  infos_vollmacht_versendet: 'Infos + Vollmacht versendet',
  vollmacht_erhalten: 'Vollmacht erhalten',
  vororttermin: 'Vororttermin',
  netzpruefung_positiv: 'Netzprüfung positiv',
  verworfen: 'Verworfen / Abgelehnt',
};

// Alte Werte (Mini-CRM) → neue Stufen
const LEGACY_STAGE_MAP = {
  new: 'zu_recherchieren',
  recherche: 'zu_recherchieren',
  contacted: 'anrufversuch',
  interested: 'infos_vollmacht_versendet',
  not_interested: 'verworfen',
  followup: 'anrufversuch',
  signed: 'vollmacht_erhalten',
  in_construction: 'netzpruefung_positiv',
  completed: 'netzpruefung_positiv',
};

function isValidStage(s) {
  return CRM_STAGES.includes(s);
}

function migrateStage(stage) {
  if (!stage) return 'zu_recherchieren';
  if (isValidStage(stage)) return stage;
  if (Object.prototype.hasOwnProperty.call(LEGACY_STAGE_MAP, stage)) {
    return LEGACY_STAGE_MAP[stage];
  }
  return 'zu_recherchieren';
}

/**
 * Grundstücksadresse: Straße, PLZ, Ort — kein interner Projektname, kein Trafo-Kürzel in der Adresszeile.
 */
function sanitizeCrmPropertyAddress(raw, lead) {
  if (raw == null) return null;
  let t = String(raw).replace(/\u00A0/g, ' ').trim();
  if (t === '' || t === '—' || t === '–' || t === '-') return null;
  const proj = lead && lead.name ? String(lead.name).trim() : '';
  if (proj && t === proj) return null;
  if (/_TST-\d+_\d{2,4}\b/i.test(t) && !/,/.test(t)) return null;
  t = t.replace(/,?\s*TST[- ]?\d{1,8}\b[^,]*/gi, '').trim();
  t = t.replace(/,?\s*Trafo-?Station\s*[:,]?\s*[\d.a-z-]+/gi, '').trim();
  t = t.replace(/,+\s*,/g, ',').replace(/^,|,$/g, '').trim();
  if (t.length > 160) {
    const p = t.split(',').map(s => s.trim()).filter(Boolean);
    t = p.slice(0, 4).join(', ');
  }
  return t || null;
}

/**
 * Nutzbare Fläche: Override > data > Schätzung 75 % von Dach
 */
function effectiveRoofArea(lead) {
  const o = lead.data_overrides;
  if (o && o.roof_area_m2 != null && isFinite(+o.roof_area_m2)) return Math.round(+o.roof_area_m2);
  const d = lead.data;
  if (d && d.roof_area_m2 != null) return Math.round(+d.roof_area_m2);
  if (d && d.area_m2 != null) return Math.round(+d.area_m2);
  return 0;
}

function effectiveDistanceM(lead) {
  const d = lead.data;
  if (d && d.distance_to_trafo_m != null) return Math.round(+d.distance_to_trafo_m);
  return 999999;
}

function effectiveKwp(lead) {
  const d = lead.data;
  if (d && d.kwp != null) return +d.kwp;
  const a = effectiveRoofArea(lead);
  if (a <= 0) return 0;
  const usable = ovrUsable(lead) ?? Math.round(a * 0.75);
  const modules = Math.floor(usable / 2.613);
  return Math.round(modules * 0.46 * 10) / 10;
}

function ovrUsable(lead) {
  const o = lead.data_overrides;
  if (o && o.usable_area_m2 != null && isFinite(+o.usable_area_m2)) return Math.round(+o.usable_area_m2);
  const d = lead.data;
  if (d && d.usable_area != null) return Math.round(+d.usable_area);
  if (d && d.usable_area_m2 != null) return Math.round(+d.usable_area_m2);
  return null;
}

/**
 * Sortierung: 1) geringerer Abstand zum Trafo zuerst, 2) größere Dachfläche zuerst
 * Rückgabe: Array-Vergleich [dist, -area] — für sort((a,b)=> cmp(ka,kb))
 */
function sortTuple(lead) {
  const dist = effectiveDistanceM(lead);
  const area = effectiveRoofArea(lead);
  return [dist, -area];
}

function compareLeads(a, b) {
  const [d1, ar1] = sortTuple(a);
  const [d2, ar2] = sortTuple(b);
  if (d1 !== d2) return d1 - d2;
  return ar1 - ar2;
}

function normalizeLead(raw) {
  const lead = { ...raw };
  lead.stage = migrateStage(lead.stage);
  if (lead.stakeholders == null || !Array.isArray(lead.stakeholders)) {
    // Legacy single contact
    const c = lead.contact || {};
    lead.stakeholders = [];
    if (c.name || c.phone || c.email) {
      lead.stakeholders.push({
        id: 'mig-1',
        name: c.name || '',
        function: '',
        phone: c.phone || '',
        email: c.email || '',
        is_primary: true,
        created_at: lead.created_at || new Date().toISOString(),
      });
    }
  }
  if (lead.data_overrides == null || typeof lead.data_overrides !== 'object') lead.data_overrides = {};
  if (typeof lead.vollmacht_bestaetigt !== 'boolean') lead.vollmacht_bestaetigt = false;
  if (lead.account_ids == null || !Array.isArray(lead.account_ids)) {
    if (lead.account_id !== undefined && lead.account_id !== null && String(lead.account_id).trim() !== '') {
      lead.account_ids = [String(lead.account_id).trim()];
    } else {
      lead.account_ids = [];
    }
  }
  lead.account_ids = Array.from(new Set(
    lead.account_ids
      .map((x) => String(x == null ? '' : x).trim())
      .filter(Boolean)
  ));
  lead.account_id = lead.account_ids[0] || null;
  if (lead.account_id !== undefined && lead.account_id !== null) lead.account_id = String(lead.account_id);
  if (lead.notes == null) lead.notes = [];
  if (lead.data == null) lead.data = {};
  const prim = lead.stakeholders.find(s => s.is_primary) || lead.stakeholders[0];
  if (prim) {
    lead.contact = { name: prim.name || '', phone: prim.phone || '', email: prim.email || '' };
  } else if (!lead.contact) lead.contact = { name: '', phone: '', email: '' };
  if (lead.data && Object.prototype.hasOwnProperty.call(lead.data, 'address')) {
    const a = sanitizeCrmPropertyAddress(lead.data.address, lead);
    if (a) lead.data.address = a;
    else delete lead.data.address;
  }
  return lead;
}

function indexBuildingsByOsm(simpleData) {
  const map = new Map();
  const list = (simpleData && simpleData.buildings) || [];
  for (const b of list) {
    if (b.osm_id != null) map.set(String(b.osm_id), b);
  }
  return map;
}

/**
 * lead.data mit Gebäude aus opportunities-simple anreichern (neuere Systemdaten)
 */
function mergeBuildingIntoLead(lead, building) {
  if (!building) return lead;
  const d = { ...(lead.data || {}) };
  d.lat = building.lat;
  d.lng = building.lng;
  const addrCand = building.address != null && String(building.address).trim() !== '' && String(building.address).trim() !== '—'
    ? building.address
    : d.address;
  const addrNorm = sanitizeCrmPropertyAddress(addrCand, { ...lead, data: d });
  if (addrNorm) d.address = addrNorm;
  else delete d.address;
  d.roof_area_m2 = building.roof_area_m2;
  d.polygon = building.polygon || d.polygon;
  d.kwp = building.kwp;
  d.usable_area = building.usable_area;
  d.kwh_year = building.kwh_year;
  d.distance_to_trafo_m = building.distance_to_trafo_m;
  d.nearest_trafo_id = building.nearest_trafo_id;
  d.nearest_trafo_tst_id = building.nearest_trafo_tst_id;
  d.nearest_trafo_status = building.nearest_trafo_status;
  d.atlas_url = building.atlas_url;
  d.building_type = building.building_type;
  d.gis_building_id = building.id;
  return { ...lead, data: d };
}

module.exports = {
  CRM_STAGES,
  STAGE_LABELS,
  isValidStage,
  migrateStage,
  sanitizeCrmPropertyAddress,
  effectiveDistanceM,
  effectiveRoofArea,
  effectiveKwp,
  compareLeads,
  sortTuple,
  normalizeLead,
  indexBuildingsByOsm,
  mergeBuildingIntoLead,
};
