/**
 * building-scanner-simple.js
 *
 * Scans the first 50 'free' trafos from data/trafos-latest.json,
 * queries Overpass for nearby industrial/commercial buildings, computes
 * roof area via the shoelace formula, reverse-geocodes via Nominatim, and
 * saves results to data/opportunities-simple.json.
 *
 * Usage: node src/building-scanner-simple.js
 */

require('./load-env');
const { ensureDataDir } = require('./resolve-data-dir');
const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR      = ensureDataDir();
const LATEST_FILE   = path.join(DATA_DIR, 'trafos-latest.json');
const OUTPUT_FILE   = path.join(DATA_DIR, 'opportunities-simple.json');

const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_UA  = 'Noortec-BuildingScanner/1.0 (vertrieb@noortec.at)';

const RADIUS_M         = 500;   // search radius around each trafo
const MIN_AREA_M2      = 1100;  // minimum roof area to include
const MAX_TRAFOS       = 50;    // process at most this many free trafos
const NOMINATIM_DELAY  = 1000;  // ms between Nominatim requests

// Building tag values we care about
const BUILDING_TYPES = [
  'industrial', 'warehouse', 'commercial',
  'factory', 'retail', 'supermarket',
];

// ─── Haversine helpers ────────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const R_EARTH = 6371000; // metres

function haversineDistance(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLng = (lng2 - lng1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLng / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute the area (m²) of a polygon given as [{lat, lng}] nodes.
 * Converts to a local metre-plane (flat-earth approximation) then applies
 * the shoelace formula.  Good enough for sub-km² buildings.
 */
function polygonAreaM2(nodes) {
  if (nodes.length < 3) return 0;

  // Reference point: first node
  const lat0 = nodes[0].lat * DEG2RAD;
  const lng0 = nodes[0].lng * DEG2RAD;
  const cosLat = Math.cos(lat0);

  // Convert each node to local (x, y) in metres
  const pts = nodes.map(n => ({
    x: (n.lng - nodes[0].lng) * DEG2RAD * R_EARTH * cosLat,
    y: (n.lat - nodes[0].lat) * DEG2RAD * R_EARTH,
  }));

  // Shoelace formula
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

// ─── Bbox helpers ─────────────────────────────────────────────────────────────

function bboxAround(lat, lng, radiusM) {
  const dLat = (radiusM / R_EARTH) / DEG2RAD;
  const dLng = dLat / Math.cos(lat * DEG2RAD);
  return {
    south: lat - dLat,
    north: lat + dLat,
    west:  lng - dLng,
    east:  lng + dLng,
  };
}

// ─── Overpass query ───────────────────────────────────────────────────────────

/**
 * Build ONE query using the combined bounding box of all trafos + buffer.
 * Single request = no rate-limit issues.  JS post-filters by distance.
 */
function buildUnionBboxQuery(trafos) {
  const buf = RADIUS_M / 111000;  // degrees buffer (~200m)
  const south = Math.min(...trafos.map(t => t.lat)) - buf;
  const north = Math.max(...trafos.map(t => t.lat)) + buf;
  const west  = Math.min(...trafos.map(t => t.lng)) - buf / Math.cos(48 * Math.PI / 180);
  const east  = Math.max(...trafos.map(t => t.lng)) + buf / Math.cos(48 * Math.PI / 180);
  const bb    = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
  return `[out:json][timeout:90];
(
  way["building"~"^(${BUILDING_TYPES.join('|')})$"](${bb});
  way["landuse"="industrial"](${bb});
);
out body;
>;
out skel qt;`;
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Overpass fetch ───────────────────────────────────────────────────────────

async function queryOverpassBulk(trafos, retries = 3) {
  const query = buildUnionBboxQuery(trafos);
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 30000;  // 30s, 60s, 90s
      console.log(`[bld-scan] Overpass retry ${attempt}/${retries} after ${wait/1000}s…`);
      await sleep(wait);
    }
    const res = await fetch(OVERPASS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `data=${encodeURIComponent(query)}`,
      timeout: 130000,
    });
    if (res.status === 429 || res.status === 504) continue;
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('Overpass unavailable after retries');
}

// ─── Process Overpass response ────────────────────────────────────────────────

/**
 * From a raw Overpass JSON response, extract buildings as:
 *   { osmId, buildingType, nodes: [{lat, lng}] }
 * Returns only ways (buildings), resolving node coordinates.
 */
function extractBuildings(data) {
  // Build node id → {lat, lng} map
  const nodeMap = new Map();
  for (const el of data.elements) {
    if (el.type === 'node') {
      nodeMap.set(el.id, { lat: el.lat, lng: el.lon });
    }
  }

  const buildings = [];
  for (const el of data.elements) {
    if (el.type !== 'way') continue;

    const buildingTag = el.tags?.building || null;
    const landuse     = el.tags?.landuse  || null;

    const buildingType =
      BUILDING_TYPES.includes(buildingTag) ? buildingTag :
      landuse === 'industrial'             ? 'industrial' :
      null;

    if (!buildingType) continue;

    const nodes = (el.nodes || [])
      .map(id => nodeMap.get(id))
      .filter(Boolean);

    if (nodes.length < 3) continue;

    buildings.push({ osmId: el.id, buildingType, nodes });
  }

  return buildings;
}

// ─── Centroid ─────────────────────────────────────────────────────────────────

function centroid(nodes) {
  const lat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
  const lng = nodes.reduce((s, n) => s + n.lng, 0) / nodes.length;
  return { lat, lng };
}

// ─── Nominatim reverse geocode ────────────────────────────────────────────────

async function reverseGeocode(lat, lng) {
  try {
    const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lng}&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch {
    return null;
  }
}

// ─── NÖ Atlas URL ─────────────────────────────────────────────────────────────

function atlasUrl(lat, lng) {
  return `https://atlas.noe.gv.at/atlas/25/?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}`;
}

// ─── Main run function ────────────────────────────────────────────────────────

async function run() {
  // ── Load trafos ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(LATEST_FILE)) {
    console.error('[bld-scan] ERROR: trafos-latest.json not found.');
    process.exit(1);
  }
  const trafosData = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8'));
  const freeTrafos = (trafosData.trafos || [])
    .filter(t => t.status === 'free')
    .slice(0, MAX_TRAFOS);

  console.log(`[bld-scan] Querying Overpass with single union-bbox query for ${freeTrafos.length} trafos…`);

  // ── Single union-bbox Overpass query ─────────────────────────────────────────
  const seen           = new Map();
  let   nominatimQueue = [];

  const raw = await queryOverpassBulk(freeTrafos);
  const allElements = raw.elements || [];

  console.log(`[bld-scan] Total elements from Overpass: ${allElements.length}`);
  const candidates = extractBuildings({ elements: allElements });
  console.log(`[bld-scan] ${candidates.length} candidate buildings extracted`);

  // For each building, find the nearest trafo among our 50
  for (const bld of candidates) {
    if (seen.has(bld.osmId)) continue;

    const area = polygonAreaM2(bld.nodes);
    if (area < MIN_AREA_M2) continue;

    const c = centroid(bld.nodes);

    // Find nearest free trafo within RADIUS_M
    let nearestTrafo = null, nearestDist = Infinity;
    for (const t of freeTrafos) {
      const d = haversineDistance(c.lat, c.lng, t.lat, t.lng);
      if (d < nearestDist) { nearestDist = d; nearestTrafo = t; }
    }
    if (!nearestTrafo || nearestDist > RADIUS_M) continue;

    const polygon = bld.nodes.map(n => [n.lat, n.lng]);
    const record  = {
      osmId:                bld.osmId,
      lat:                  parseFloat(c.lat.toFixed(6)),
      lng:                  parseFloat(c.lng.toFixed(6)),
      roof_area_m2:         Math.round(area),
      polygon,
      address:              null,
      distance_to_trafo_m:  Math.round(nearestDist),
      nearest_trafo_id:     nearestTrafo.id || null,
      nearest_trafo_tst_id: nearestTrafo.tst_id || null,
      nearest_trafo_status: nearestTrafo.status,
      building_type:        bld.buildingType,
      atlas_url:            atlasUrl(c.lat, c.lng),
    };

    seen.set(bld.osmId, record);
    nominatimQueue.push(record);
  }

  console.log(`[bld-scan] ${seen.size} unique buildings within ${RADIUS_M}m of a free trafo`);

  // ── Reverse-geocode collected buildings (rate-limited to 1 req/s) ────────────
  console.log(`[bld-scan] Reverse-geocoding ${nominatimQueue.length} buildings (1 req/s)…`);
  for (let i = 0; i < nominatimQueue.length; i++) {
    const rec = nominatimQueue[i];
    rec.address = await reverseGeocode(rec.lat, rec.lng);
    if (i < nominatimQueue.length - 1) await sleep(NOMINATIM_DELAY);
  }

  // ── Assemble output ──────────────────────────────────────────────────────────
  const buildings = Array.from(seen.values()).map((rec, idx) => ({
    id:  `bld-${String(idx + 1).padStart(5, '0')}`,
    osm_id:                 rec.osmId,
    lat:                    rec.lat,
    lng:                    rec.lng,
    roof_area_m2:           rec.roof_area_m2,
    polygon:                rec.polygon,
    address:                rec.address || '—',
    distance_to_trafo_m:    rec.distance_to_trafo_m,
    nearest_trafo_id:       rec.nearest_trafo_id,
    nearest_trafo_tst_id:   rec.nearest_trafo_tst_id,
    nearest_trafo_status:   rec.nearest_trafo_status,
    building_type:          rec.building_type,
    atlas_url:              rec.atlas_url,
  }));

  const output = {
    generated_at: new Date().toISOString(),
    source_trafos: freeTrafos.length,
    count: buildings.length,
    buildings,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  console.log(`[bld-scan] Done. ${buildings.length} unique buildings saved to ${OUTPUT_FILE}`);
  return output;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error('[bld-scan] Fatal error:', err);
    process.exit(1);
  });
}
