/**
 * scorer.js
 *
 * Finds and scores PV installation opportunities in Lower Austria by:
 *   1. Querying Overpass API for large industrial/commercial buildings
 *   2. Matching buildings to nearby free/partial trafos (≤200m)
 *   3. Scoring each match 0–100
 *   4. Enriching high-score (>40) buildings with address, PVGIS data, DORIS link
 *   5. Saving results to /data/opportunities.json
 *
 * Usage:  node src/scorer.js      or      npm run score
 */

require('./load-env');
const { ensureDataDir } = require('./resolve-data-dir');
const fetch = require('node-fetch');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const turf  = require('@turf/turf');

const tlsAgent   = new https.Agent({ rejectUnauthorized: false });
const DATA_DIR   = ensureDataDir();
const LATEST     = path.join(DATA_DIR, 'trafos-latest.json');
const OUT_FILE   = path.join(DATA_DIR, 'opportunities.json');

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_AREA_M2     = 2850;   // ≥ 2850 m² roof → 450 kWp+
const MAX_TRAFO_DIST  = 200;    // metres
const MIN_SCORE       = 40;     // only enrich above this
const ENRICH_BATCH    = 10;     // parallel enrichment requests
const NOE_BBOX        = [14.45, 47.40, 17.07, 49.02]; // [west,south,east,north]

const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const PVGIS_URL     = 'https://re.jrc.ec.europa.eu/api/v5_2/PVcalc';

// ─── Overpass query ───────────────────────────────────────────────────────────

const OVERPASS_QUERY = `
[out:json][timeout:120];
(
  way["building"~"^(industrial|warehouse|factory|commercial|retail|supermarket|hangar|storage_tank|shed)$"]
     ["generator:source"!="solar"]
     (${NOE_BBOX[1]},${NOE_BBOX[0]},${NOE_BBOX[3]},${NOE_BBOX[2]});
  way["landuse"~"^(industrial|commercial)$"]
     ["building"]["generator:source"!="solar"]
     (${NOE_BBOX[1]},${NOE_BBOX[0]},${NOE_BBOX[3]},${NOE_BBOX[2]});
);
out body;
>;
out skel qt;
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Haversine distance in metres */
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// ─── Spatial trafo index (grid 0.002° ≈ 200m) ────────────────────────────────

function buildTrafoIndex(trafos) {
  const CELL = 0.002;
  const idx  = new Map();
  for (const t of trafos) {
    const cx = Math.floor(t.lng / CELL);
    const cy = Math.floor(t.lat / CELL);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const key = `${cx+dx},${cy+dy}`;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(t);
    }
  }
  return { idx, CELL };
}

function nearestTrafo(lat, lng, index) {
  const { idx, CELL } = index;
  const cx = Math.floor(lng / CELL), cy = Math.floor(lat / CELL);
  const candidates = idx.get(`${cx},${cy}`) || [];
  let best = null, bestDist = Infinity;
  for (const t of candidates) {
    const d = distanceM(lat, lng, t.lat, t.lng);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return { trafo: best, dist: bestDist };
}

// ─── OSM building polygon → area ─────────────────────────────────────────────

function buildingArea(way, nodeMap) {
  const coords = way.nodes
    .map(id => nodeMap.get(id))
    .filter(Boolean)
    .map(n => [n.lon, n.lat]);
  if (coords.length < 4) return 0;
  try {
    const poly = turf.polygon([coords]);
    return turf.area(poly);
  } catch { return 0; }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function score(area, dist, trafoStatus, pvgisKwh) {
  const distScore   = (1 - dist / MAX_TRAFO_DIST) * 35;
  const areaScore   = Math.min(area / 10000, 1) * 30;
  const trafoScore  = (trafoStatus === 'free' ? 1 : 0.6) * 20;
  const solarScore  = (pvgisKwh / 1_000_000) * 15;
  return Math.round(distScore + areaScore + trafoScore + solarScore);
}

// ─── PVGIS irradiation ────────────────────────────────────────────────────────

async function fetchPvgis(lat, lng) {
  const url = `${PVGIS_URL}?lat=${lat}&lon=${lng}&peakpower=1&loss=14&outputformat=json`;
  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) return 950; // default kWh/kWp/year for Austria
    const data = await res.json();
    return data?.outputs?.totals?.fixed?.E_y || 950;
  } catch { return 950; }
}

// ─── Nominatim reverse geocode ────────────────────────────────────────────────

async function reverseGeocode(lat, lng) {
  const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lng}&format=json`;
  try {
    const res = await fetch(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Noortec-RoofIdentifyer/1.0 (vertrieb@noortec.at)' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch { return null; }
}

// ─── DORIS NÖ deep link ───────────────────────────────────────────────────────

function dorisUrl(lat, lng) {
  // Atlas NÖ / DORIS deep link — opens map centred on the given coordinate
  return `https://doris.noel.gv.at/atlas.asp?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('[scorer] Starting building opportunity scan…');

  // ── Load trafos ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(LATEST)) {
    console.error('[scorer] No trafos-latest.json — run npm run scan:all first');
    process.exit(1);
  }
  const { trafos: allTrafos } = JSON.parse(fs.readFileSync(LATEST));
  const goodTrafos = allTrafos.filter(t => t.status === 'free' || t.status === 'partial');
  console.log(`[scorer] ${goodTrafos.length} free/partial trafos loaded`);
  const trafoIndex = buildTrafoIndex(goodTrafos);

  // ── Fetch buildings from Overpass ────────────────────────────────────────────
  console.log('[scorer] Querying Overpass for industrial/commercial buildings…');
  let osmData;
  try {
    const res = await fetch(OVERPASS_URL, {
      method:  'POST',
      body:    `data=${encodeURIComponent(OVERPASS_QUERY)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 150_000,
    });
    osmData = await res.json();
  } catch (err) {
    console.error('[scorer] Overpass failed:', err.message);
    process.exit(1);
  }

  const elements = osmData.elements || [];
  const nodeMap  = new Map();
  const ways     = [];
  for (const el of elements) {
    if (el.type === 'node') nodeMap.set(el.id, el);
    if (el.type === 'way')  ways.push(el);
  }
  console.log(`[scorer] ${ways.length} candidate buildings, ${nodeMap.size} nodes`);

  // ── Filter by area + trafo proximity ─────────────────────────────────────────
  const candidates = [];
  for (const way of ways) {
    const area = buildingArea(way, nodeMap);
    if (area < MIN_AREA_M2) continue;

    // Centroid from nodes
    const lats = way.nodes.map(id => nodeMap.get(id)?.lat).filter(Boolean);
    const lngs = way.nodes.map(id => nodeMap.get(id)?.lon).filter(Boolean);
    if (!lats.length) continue;
    const lat = lats.reduce((s, v) => s + v, 0) / lats.length;
    const lng = lngs.reduce((s, v) => s + v, 0) / lngs.length;

    const { trafo, dist } = nearestTrafo(lat, lng, trafoIndex);
    if (!trafo || dist > MAX_TRAFO_DIST) continue;

    candidates.push({ way, area, lat, lng, trafo, dist });
  }
  console.log(`[scorer] ${candidates.length} buildings within 200m of free/partial trafo`);

  // ── Score (pre-pass with default irradiation) ─────────────────────────────────
  const DEFAULT_KWH_PER_KWP = 950;
  const scored = candidates.map(c => {
    const modules   = Math.floor((c.area * 0.75) / 1.9);
    const kwp       = modules * 0.4;
    const kwh_year  = kwp * DEFAULT_KWH_PER_KWP;
    const s         = score(c.area, c.dist, c.trafo.status, kwh_year);
    return { ...c, modules, kwp, kwh_year, score: s };
  }).sort((a, b) => b.score - a.score);

  const toEnrich = scored.filter(c => c.score >= MIN_SCORE);
  const skipped  = scored.length - toEnrich.length;
  console.log(`[scorer] ${toEnrich.length} buildings to enrich (${skipped} below score ${MIN_SCORE})`);

  // ── Enrich ────────────────────────────────────────────────────────────────────
  const opportunities = [];
  let done = 0;

  for (let b = 0; b < toEnrich.length; b += ENRICH_BATCH) {
    const batch = toEnrich.slice(b, b + ENRICH_BATCH);

    const enriched = await Promise.all(batch.map(async (c, j) => {
      const [address, pvgisKwh] = await Promise.all([
        reverseGeocode(c.lat, c.lng),
        fetchPvgis(c.lat, c.lng),
      ]);

      const modules      = Math.floor((c.area * 0.75) / 1.9);
      const kwp          = Math.round(modules * 0.4 * 10) / 10;
      const kwh_year     = Math.round(kwp * pvgisKwh);
      const co2_tons     = Math.round(kwh_year * 0.4) / 1000;
      const finalScore   = score(c.area, c.dist, c.trafo.status, kwh_year);

      return {
        id:                   `opp-${String(b + j + 1).padStart(5, '0')}`,
        score:                finalScore,
        address:              address || `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`,
        lat:                  Math.round(c.lat * 1e6) / 1e6,
        lng:                  Math.round(c.lng * 1e6) / 1e6,
        roof_area_m2:         Math.round(c.area),
        modules,
        kwp,
        kwh_year,
        co2_tons_year:        co2_tons,
        distance_to_trafo_m:  Math.round(c.dist),
        nearest_trafo_id:     c.trafo.tst_id || c.trafo.id,
        nearest_trafo_status: c.trafo.status,
        osm_building_type:    c.way.tags?.building || c.way.tags?.landuse || 'unknown',
        osm_id:               c.way.id,
        doris_url:            dorisUrl(c.lat, c.lng),
        existing_pv:          false,
      };
    }));

    opportunities.push(...enriched);
    done += batch.length;
    process.stdout.write(`\r  Enriched: ${done}/${toEnrich.length}`);
    await sleep(1000); // Nominatim rate limit: 1 req/s
  }
  console.log();

  // Sort by score desc
  opportunities.sort((a, b) => b.score - a.score);

  const output = {
    generated_at:   new Date().toISOString(),
    count:          opportunities.length,
    total_kwp:      Math.round(opportunities.reduce((s, o) => s + o.kwp, 0)),
    total_kwh_year: Math.round(opportunities.reduce((s, o) => s + o.kwh_year, 0)),
    total_co2_tons: Math.round(opportunities.reduce((s, o) => s + o.co2_tons_year, 0)),
    opportunities,
  };

  ensureDir(DATA_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[scorer] Saved ${opportunities.length} opportunities → ${OUT_FILE}`);
  console.log(`[scorer] Total potential: ${output.total_kwp} kWp / ${output.total_kwh_year.toLocaleString()} kWh/year`);
}

if (require.main === module) {
  run().catch(err => { console.error('[scorer]', err); process.exit(1); });
}

module.exports = { run };
