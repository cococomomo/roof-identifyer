/**
 * enrich-scan.js
 *
 * Post-processing step: adds `tst_id` and `gesperrt` attributes to every trafo
 * in trafos-latest.json (and the matching dated scan file) by querying
 * WMS GetFeatureInfo with FI_POINT_TOLERANCE=20.
 *
 * Runs requests in parallel batches for speed.
 *
 * Usage:
 *   node src/enrich-scan.js [path/to/scan.json]   ← defaults to trafos-latest.json
 */

require('./load-env');
const { ensureDataDir } = require('./resolve-data-dir');
const fetch  = require('node-fetch');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const BASE     = process.env.TRAFO_MAP_URL;
const agent    = new https.Agent({ rejectUnauthorized: false });
const IMG_W    = 1300;
const IMG_H    = 1300;
// Must match trafo-scanner.js tile grid so GFI pixel coordinates align correctly
const TILE_W   = 0.04;
const TILE_H   = 0.03;
const EXTENT   = { west: 14.45, south: 47.45, east: 17.20, north: 48.98 };
const BATCH    = 40;  // parallel requests per batch

// gesperrt → status (authoritative from WMS, confirmed against pixel-colour counts)
const GESPERRT_STATUS = { 0: 'free', 1: 'partial', 2: 'regional', 3: 'local', 4: 'full' };

const DATA_DIR  = ensureDataDir();
const LATEST    = path.join(DATA_DIR, 'trafos-latest.json');

// ─── Tile reconstruction ──────────────────────────────────────────────────────
// Re-derive the tile bbox a trafo belongs to from its coordinates.
function tileForTrafo(lat, lng) {
  const col = Math.floor((lng - EXTENT.west)  / TILE_W);
  const row = Math.floor((EXTENT.north - lat) / TILE_H);
  const tileW = EXTENT.west + col * TILE_W;
  const tileE = Math.min(tileW + TILE_W, EXTENT.east);
  const tileN = EXTENT.north - row * TILE_H;
  const tileS = Math.max(tileN - TILE_H, EXTENT.south);
  return { tileW, tileS, tileE, tileN };
}

// ─── Single GetFeatureInfo request ────────────────────────────────────────────
async function fetchProps(trafo) {
  const { tileW, tileS, tileE, tileN } = tileForTrafo(trafo.lat, trafo.lng);
  const px = Math.round(((trafo.lng - tileW) / (tileE - tileW)) * IMG_W);
  const py = Math.round(((tileN - trafo.lat) / (tileN - tileS)) * IMG_H);

  const url = BASE +
    '&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo' +
    '&LAYERS=TST&QUERY_LAYERS=TST' +
    '&INFO_FORMAT=application%2Fgeo%2Bjson' +
    '&FEATURE_COUNT=1' +
    `&WIDTH=${IMG_W}&HEIGHT=${IMG_H}&CRS=CRS:84` +
    `&BBOX=${tileW},${tileS},${tileE},${tileN}` +
    `&I=${px}&J=${py}` +
    '&FI_POINT_TOLERANCE=20';

  try {
    const res = await fetch(url, { agent, timeout: 12000 });
    if (!res.ok) return null;
    const geo = await res.json();
    return geo.features?.[0]?.properties || null;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(scanPath) {
  scanPath = scanPath || LATEST;
  console.log(`[enrich-scan] Loading: ${scanPath}`);
  const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
  const { trafos } = scan;
  console.log(`[enrich-scan] Enriching ${trafos.length} trafos in batches of ${BATCH}…`);

  let done = 0, found = 0;

  for (let i = 0; i < trafos.length; i += BATCH) {
    const batch = trafos.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(fetchProps));

    results.forEach((props, j) => {
      if (!props) return;
      const t        = batch[j];
      const tstId    = props.ID !== undefined    ? Number(props.ID)        : null;
      const gesperrt = props.gesperrt !== undefined ? Number(props.gesperrt) : null;
      t.tst_id   = tstId;
      t.gesperrt = gesperrt;
      // Override status with authoritative gesperrt value
      if (gesperrt !== null && GESPERRT_STATUS[gesperrt]) t.status = GESPERRT_STATUS[gesperrt];
      if (tstId !== null) {
        t.name = `TST-${tstId}`;
        found++;
      }
    });

    done += batch.length;
    process.stdout.write(`\r  ${done}/${trafos.length} enriched, ${found} IDs found`);
  }
  console.log(); // newline

  // Save back
  fs.writeFileSync(scanPath, JSON.stringify(scan, null, 2));
  console.log(`[enrich-scan] Saved: ${scanPath}`);

  // Also update latest if we enriched a dated scan
  if (scanPath !== LATEST) {
    fs.writeFileSync(LATEST, JSON.stringify(scan, null, 2));
    console.log(`[enrich-scan] Updated: ${LATEST}`);
  }

  // If it's latest, also update the dated scan file
  if (scanPath === LATEST && scan.date) {
    const dated = path.join(DATA_DIR, 'scans', `trafos-${scan.date}.json`);
    if (fs.existsSync(dated)) {
      fs.writeFileSync(dated, JSON.stringify(scan, null, 2));
      console.log(`[enrich-scan] Updated: ${dated}`);
    }
  }

  console.log(`[enrich-scan] Done — ${found}/${trafos.length} trafos have EVN IDs`);
}

if (require.main === module) {
  const [,, arg] = process.argv;
  run(arg).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
