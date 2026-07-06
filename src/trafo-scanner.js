/**
 * trafo-scanner.js
 *
 * Scans transformer (Trafo) capacity data from a QGIS MapServer WMS endpoint.
 *
 * Coordinate accuracy fix (v2):
 *   - Previous large tiles (0.22°×0.15°, scale 1:47000) caused ~100-150 m northward
 *     offset because trafo pin symbols are rendered with the anchor at the BOTTOM of
 *     the coloured circle.  At 1:47000 the pin stem is ~8 px tall = ~100 m in map space.
 *   - New small tiles (0.04°×0.03°, scale 1:22400) make the same 8 px stem only ~50 m,
 *     and with CELL_PX=5 the intra-cell error is ±15 m → overall accuracy ≈ 15–20 m.
 *   - WMS GetFeatureInfo returns geometry: null for this layer (server configuration),
 *     so exact coordinates must be derived from pixel analysis.
 *   - DEDUP_RADIUS corrected from 0.003° (333 m) → 0.00027° (30 m).
 *
 * Tile grid: 0.04° × 0.03°, image 500 × 500 px, scale ≈ 1:22 400
 * Tiles are fetched 20 at a time; progress bar + checkpoint every 100 tiles.
 *
 * Usage:
 *   node src/trafo-scanner.js
 *   npm run scan:all
 */

require('./load-env');
const { ensureDataDir } = require('./resolve-data-dir');
const fetch  = require('node-fetch');
const https  = require('https');
const { PNG } = require('pngjs');
const fs     = require('fs');
const path   = require('path');

// EVN server uses a corporate/self-signed certificate — bypass TLS verification.
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

// gesperrt → status (authoritative from WMS attributes)
const GESPERRT_STATUS = { 0: 'free', 1: 'partial', 2: 'regional', 3: 'local', 4: 'full' };

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = process.env.TRAFO_MAP_URL;
if (!BASE_URL) {
  console.error('ERROR: TRAFO_MAP_URL is not set in .env');
  process.exit(1);
}

const DATA_DIR    = ensureDataDir();
const SCANS_DIR   = path.join(DATA_DIR, 'scans');
const LATEST_PATH = path.join(DATA_DIR, 'trafos-latest.json');
const LAYER       = 'TST';

// Full NÖ scan extent
const EXTENT = { west: 14.45, south: 47.45, east: 17.20, north: 48.98 };

// Small tiles keep map scale within TST visibility range (1:1000–1:50 001).
// 0.04°×0.03° at 1300×1300 px → scale ≈ 1:8 600 ✓
// At this resolution, each trafo marker is ~8 px ≈ 18 m — no marker overlap for
// trafos ≥ 36 m apart, and the pin-anchor offset is only ≈ 18 m (was ≈ 100 m
// at the previous 0.22°/1300 px tiles which used scale 1:47 000).
const TILE_W = 0.04;
const TILE_H = 0.03;
const IMG_W  = 1300;
const IMG_H  = 1300;

// Minimum pixels in a connected component to count as a real marker
// (filters noise / anti-alias artefacts)
const MIN_BLOB_PX = 4;

// Dedup radius ≈ 30 m — handles cross-tile edge duplicates only.
// Connected-components ensures each blob produces exactly 1 candidate,
// so we only need to merge partial blobs cut at tile edges.
const DEDUP_DEG = 0.00027;

// Parallel tile fetches
const TILE_BATCH = 20;

// Save checkpoint every N completed tiles
const CHECKPOINT_EVERY = 100;

// ─── Known status colours ─────────────────────────────────────────────────────

const STATUS_COLOURS = [
  { status: 'free',     r: 22,  g: 144, b: 0   },   // #169000 dark green
  { status: 'partial',  r: 82,  g: 255, b: 0   },   // #52ff00 lime green
  { status: 'regional', r: 255, g: 255, b: 0   },   // #ffff00 yellow
  { status: 'local',    r: 254, g: 190, b: 4   },   // #febe04 amber
  { status: 'full',     r: 255, g: 0,   b: 0   },   // #ff0000 red
];
const COLOUR_THRESHOLD = 60;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO()   { return new Date().toISOString().slice(0, 10); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function classifyPixel(r, g, b) {
  if (r < 30 && g < 30 && b < 30) return null;   // near-black outline
  let best = null, bestDist = Infinity;
  for (const c of STATUS_COLOURS) {
    const d = Math.sqrt((r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2);
    if (d < bestDist) { bestDist = d; best = c.status; }
  }
  return bestDist < COLOUR_THRESHOLD ? best : null;
}

/** WMS GetMap URL for a tile */
function getMapUrl(west, south, east, north) {
  return (
    BASE_URL +
    '&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
    `&LAYERS=${LAYER}&FORMAT=image/png&TRANSPARENT=TRUE` +
    `&WIDTH=${IMG_W}&HEIGHT=${IMG_H}&CRS=CRS:84` +
    `&BBOX=${west},${south},${east},${north}`
  );
}

/** WMS GetFeatureInfo URL — used for attribute enrichment only (geometry is null server-side) */
function getFeatureInfoUrl(west, south, east, north, I, J) {
  return (
    BASE_URL +
    '&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo' +
    `&LAYERS=${LAYER}&QUERY_LAYERS=${LAYER}` +
    '&INFO_FORMAT=application%2Fgeo%2Bjson&FEATURE_COUNT=1' +
    `&WIDTH=${IMG_W}&HEIGHT=${IMG_H}&CRS=CRS:84` +
    `&BBOX=${west},${south},${east},${north}` +
    `&I=${Math.round(I)}&J=${Math.round(J)}` +
    '&FI_POINT_TOLERANCE=20'
  );
}

/** Fetch + decode a PNG tile */
async function fetchPNG(url) {
  const res = await fetch(url, { timeout: 30000, agent: tlsAgent });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return PNG.sync.read(await res.buffer());
}

/**
 * Scan a decoded PNG using connected-components (8-connectivity flood fill).
 * Each contiguous blob of status-coloured pixels becomes exactly one marker
 * candidate, regardless of blob size.  This avoids the cell-grid artefact
 * where one trafo symbol creates multiple cells that may not all be deduped.
 *
 * Returns array of { pixelX, pixelY, status } — one entry per blob.
 */
function findMarkersInImage(png) {
  const { width, height, data } = png;

  // Build status map: index → status string | null
  const statusMap = new Array(width * height).fill(null);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4;
      if (data[idx + 3] < 10) continue;
      const s = classifyPixel(data[idx], data[idx + 1], data[idx + 2]);
      if (s) statusMap[y * width + x] = s;
    }
  }

  // BFS flood-fill to label connected components (8-connectivity)
  const visited = new Uint8Array(width * height);
  const markers = [];

  for (let start = 0; start < statusMap.length; start++) {
    if (!statusMap[start] || visited[start]) continue;

    // Flood fill from this seed pixel
    const queue  = [start];
    visited[start] = 1;
    let sumX = 0, sumY = 0, n = 0;
    const counts = {};

    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x   = idx % width;
      const y   = (idx - x) / width;
      const s   = statusMap[idx];
      sumX += x; sumY += y; n++;
      counts[s] = (counts[s] || 0) + 1;

      // Check 8 neighbours
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !statusMap[nIdx]) continue;
          visited[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }

    if (n < MIN_BLOB_PX) continue;   // skip noise / anti-alias artefacts

    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    markers.push({ pixelX: sumX / n, pixelY: sumY / n, status: dominant[0] });
  }

  return markers;
}

/** Convert pixel position to geographic coordinates */
function pixelToGeo(px, py, west, south, east, north) {
  return {
    lng: west  + (px / IMG_W) * (east  - west),
    lat: north - (py / IMG_H) * (north - south),
  };
}

/** Global deduplication with 30 m radius.  Sorted-array early-exit for O(n log n). */
function deduplicate(trafos) {
  trafos.sort((a, b) => a.lat - b.lat || a.lng - b.lng);
  const used   = new Uint8Array(trafos.length);
  const result = [];
  for (let i = 0; i < trafos.length; i++) {
    if (used[i]) continue;
    const a = trafos[i];
    for (let j = i + 1; j < trafos.length; j++) {
      if (used[j]) continue;
      if (trafos[j].lat - a.lat > DEDUP_DEG) break;
      const dlat = a.lat - trafos[j].lat;
      const dlng = a.lng - trafos[j].lng;
      if (Math.sqrt(dlat * dlat + dlng * dlng) < DEDUP_DEG) used[j] = 1;
    }
    result.push(a);
  }
  return result;
}

// ─── GFI enrichment ───────────────────────────────────────────────────────────

async function enrichTrafo(t) {
  const px = ((t.lng - t._tileW) / (t._tileE - t._tileW)) * IMG_W;
  const py = ((t._tileN - t.lat) / (t._tileN - t._tileS)) * IMG_H;
  const url = getFeatureInfoUrl(t._tileW, t._tileS, t._tileE, t._tileN, px, py);
  try {
    const res = await fetch(url, { timeout: 12000, agent: tlsAgent });
    if (!res.ok) return null;
    const geo = await res.json();
    return geo.features?.[0]?.properties || null;
  } catch { return null; }
}

// ─── Main scanner ──────────────────────────────────────────────────────────────

async function scanTrafos() {
  console.log(`[trafo-scanner] Starting v2 scan — ${new Date().toISOString()}`);
  console.log(`[trafo-scanner] Tile size: ${TILE_W}°×${TILE_H}° @ ${IMG_W}×${IMG_H}px (scale ≈ 1:8600)`);
  console.log(`[trafo-scanner] DEDUP radius: ${DEDUP_DEG}° ≈ 30 m (cross-tile edge correction)`);

  const { west: W, south: S, east: E, north: N } = EXTENT;
  const tilesLon   = Math.ceil((E - W) / TILE_W);
  const tilesLat   = Math.ceil((N - S) / TILE_H);
  const totalTiles = tilesLon * tilesLat;
  console.log(`[trafo-scanner] Grid: ${tilesLon}×${tilesLat} = ${totalTiles} tiles`);

  ensureDir(SCANS_DIR);
  const dateStamp      = todayISO();
  const checkpointFile = path.join(DATA_DIR, 'scan-checkpoint.json');

  // Resume from today's checkpoint
  let allRaw   = [];
  let startIdx = 0;
  if (fs.existsSync(checkpointFile)) {
    try {
      const cp = JSON.parse(fs.readFileSync(checkpointFile));
      if (cp.date === dateStamp && cp.tilesCompleted > 0) {
        allRaw   = cp.trafos;
        startIdx = cp.tilesCompleted;
        console.log(`[trafo-scanner] Resuming from tile ${startIdx}/${totalTiles} (${allRaw.length} trafos so far)`);
      }
    } catch { /* ignore corrupt checkpoint */ }
  }

  // Build full tile list
  const tiles = [];
  for (let row = 0; row < tilesLat; row++) {
    for (let col = 0; col < tilesLon; col++) {
      const tileW = W + col * TILE_W;
      const tileE = Math.min(tileW + TILE_W, E);
      const tileN = N - row * TILE_H;
      const tileS = Math.max(tileN - TILE_H, S);
      tiles.push({ tileW, tileE, tileN, tileS });
    }
  }

  let doneTiles = startIdx;

  for (let b = startIdx; b < tiles.length; b += TILE_BATCH) {
    const batch = tiles.slice(b, b + TILE_BATCH);

    const batchResults = await Promise.all(
      batch.map(async ({ tileW, tileE, tileN, tileS }) => {
        try {
          const png     = await fetchPNG(getMapUrl(tileW, tileS, tileE, tileN));
          const markers = findMarkersInImage(png);
          return markers.map(m => {
            const { lat, lng } = pixelToGeo(m.pixelX, m.pixelY, tileW, tileS, tileE, tileN);
            return { lat, lng, status: m.status, _tileW: tileW, _tileS: tileS, _tileE: tileE, _tileN: tileN };
          });
        } catch { return []; }
      })
    );

    for (const markers of batchResults) allRaw.push(...markers);
    doneTiles += batch.length;

    // Progress bar
    const pct = Math.round(doneTiles / totalTiles * 100);
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    process.stdout.write(`\r  [${bar}] ${pct}%  ${doneTiles}/${totalTiles}  ${allRaw.length} raw`);

    // Checkpoint
    if (doneTiles % CHECKPOINT_EVERY === 0 || doneTiles === totalTiles) {
      const deduped = deduplicate([...allRaw]);
      fs.writeFileSync(checkpointFile, JSON.stringify({
        date: dateStamp, tilesCompleted: doneTiles, trafos: deduped,
      }));
      allRaw = deduped;
      process.stdout.write(` ✓cp ${deduped.length}`);
    }
  }
  console.log('\n[trafo-scanner] Tile scan complete — deduplicating…');

  const deduped = deduplicate(allRaw);
  console.log(`[trafo-scanner] ${deduped.length} unique trafos (after 30 m dedup)`);

  // ── Enrich with GFI attributes (ID, gesperrt) ────────────────────────────────
  console.log('[trafo-scanner] Enriching via GetFeatureInfo (attributes only)…');
  const scannedAt = new Date().toISOString();
  const trafos    = new Array(deduped.length);
  const ENRICH_BATCH = 40;
  let enrichDone = 0;

  for (let b = 0; b < deduped.length; b += ENRICH_BATCH) {
    const batch   = deduped.slice(b, b + ENRICH_BATCH);
    const results = await Promise.all(batch.map(enrichTrafo));

    results.forEach((props, j) => {
      const i        = b + j;
      const t        = deduped[i];
      const tstId    = props?.ID       !== undefined ? Number(props.ID)       : null;
      const gesperrt = props?.gesperrt !== undefined ? Number(props.gesperrt) : null;
      const status   = gesperrt !== null ? (GESPERRT_STATUS[gesperrt] ?? t.status) : t.status;
      trafos[i] = {
        id:         `trafo-${String(i + 1).padStart(4, '0')}`,
        name:       tstId !== null ? `TST-${tstId}` : `Trafo-${String(i + 1).padStart(4, '0')}`,
        tst_id:     tstId,
        gesperrt,
        lat:        Math.round(t.lat * 1e6) / 1e6,
        lng:        Math.round(t.lng * 1e6) / 1e6,
        status,
        scanned_at: scannedAt,
      };
    });
    enrichDone += batch.length;
    process.stdout.write(`\r  Enriched: ${enrichDone}/${deduped.length}`);
  }
  console.log();

  // Status summary
  const counts = { free: 0, partial: 0, regional: 0, local: 0, full: 0, unknown: 0 };
  trafos.forEach(t => { counts[t.status] = (counts[t.status] || 0) + 1; });
  console.log('[trafo-scanner] Status distribution:');
  Object.entries(counts).filter(([, n]) => n > 0)
    .forEach(([s, n]) => console.log(`  ${s.padEnd(8)}: ${n}`));

  // Save
  const scanFile    = path.join(SCANS_DIR, `trafos-${dateStamp}.json`);
  const scanPayload = { scanned_at: scannedAt, date: dateStamp, count: trafos.length, counts, trafos };

  fs.writeFileSync(scanFile,    JSON.stringify(scanPayload, null, 2));
  fs.writeFileSync(LATEST_PATH, JSON.stringify(scanPayload, null, 2));

  if (fs.existsSync(checkpointFile)) fs.unlinkSync(checkpointFile);

  console.log(`[trafo-scanner] Saved  → ${scanFile}`);
  console.log(`[trafo-scanner] Latest → ${LATEST_PATH}`);
  return scanPayload;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (require.main === module) {
  scanTrafos()
    .then(() => process.exit(0))
    .catch(err => { console.error('[trafo-scanner] Fatal:', err); process.exit(1); });
}

module.exports = { scanTrafos };
