/**
 * Simplifies Statistik-AT WFS output for web + server (tolerance ~8 m).
 * 1) Rohdaten: Statistik-Austria WFS (nur NÖ: g_id beginnt mit 3):
 *    curl.exe -sL "https://www.statistik.at/gs-open/GEODATA/wfs?service=wfs&version=1.0.0&request=GetFeature&typeName=GEODATA%3ASTATISTIK_AUSTRIA_GEM_20250101&outputFormat=application%2Fjson&CQL_FILTER=g_id%20LIKE%20%273%25%27&srsName=EPSG%3A4326" -o data/gemeinden-noe-raw.json
 * 2) Dann: npm run compact-gemeinden  →  data/gemeinden-noe.json
 * Output: ../data/gemeinden-noe.json
 *
 *   node scripts/compact-gemeinden-noe.js
 */
const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');

const root = path.join(__dirname, '..');
const rawPath = path.join(root, 'data', 'gemeinden-noe-raw.json');
const outPath = path.join(root, 'data', 'gemeinden-noe.json');
const TOL = 0.0001;

if (!fs.existsSync(rawPath)) {
  console.error('Missing', rawPath, '— download with WFS first (see server/data notes).');
  process.exit(1);
}

const fc = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
if (!fc.features) {
  console.error('Invalid FeatureCollection');
  process.exit(1);
}

const out = { type: 'FeatureCollection', features: [] };
for (const f of fc.features) {
  if (!f.geometry) continue;
  try {
    const sim = turf.simplify(f, { tolerance: TOL, highQuality: true, mutate: false });
    out.features.push({
      type: 'Feature',
      id: f.id,
      properties: { g_id: f.properties.g_id, g_name: f.properties.g_name },
      geometry: sim.geometry,
    });
  } catch (e) {
    console.warn('skip feature', f.properties?.g_id, e.message);
  }
}

fs.writeFileSync(outPath, JSON.stringify(out));
const mb = (fs.statSync(outPath).size / 1e6).toFixed(2);
console.log('Wrote', out.features.length, 'features,', mb, 'MB →', outPath);
