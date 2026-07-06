require('./load-env');
const { ensureDataDir } = require('./resolve-data-dir');
/**
 * compare-scans.js
 *
 * Compares two versioned scan files and detects trafos whose status changed.
 * Writes /data/changes-DATUM1-vs-DATUM2.json with full change details.
 *
 * Usage:
 *   node src/compare-scans.js [file-or-date-1] [file-or-date-2]
 *
 * Examples:
 *   node src/compare-scans.js                                  ← last two scans
 *   node src/compare-scans.js 2026-03-23 2026-06-15
 *   node src/compare-scans.js data/scans/trafos-2026-03-23.json data/scans/trafos-2026-06-15.json
 *
 *   npm run compare
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = ensureDataDir();
const SCANS_DIR = path.join(DATA_DIR, 'scans');

// ─── Status severity (higher = worse) ────────────────────────────────────────

const SEVERITY = { free: 0, partial: 1, regional: 2, local: 3, full: 4, unknown: 5 };

function severity(status) {
  return SEVERITY[status] ?? 5;
}

// ─── File resolution ──────────────────────────────────────────────────────────

function resolveFile(arg) {
  if (!arg) return null;
  // Already a full path
  if (fs.existsSync(arg)) return path.resolve(arg);
  // Date string like "2026-03-23"
  const byDate = path.join(SCANS_DIR, `trafos-${arg}.json`);
  if (fs.existsSync(byDate)) return byDate;
  throw new Error(`Cannot find scan file for argument: "${arg}"`);
}

function listScanFiles() {
  if (!fs.existsSync(SCANS_DIR)) return [];
  return fs.readdirSync(SCANS_DIR)
    .filter(f => f.match(/^trafos-\d{4}-\d{2}-\d{2}\.json$/))
    .sort(); // lexicographic = chronological for ISO dates
}

function loadScan(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

// ─── Date extraction ──────────────────────────────────────────────────────────

function dateFromFilePath(filePath) {
  const m = path.basename(filePath).match(/trafos-(\d{4}-\d{2}-\d{2})\.json/);
  return m ? m[1] : path.basename(filePath, '.json');
}

// ─── Comparison core ──────────────────────────────────────────────────────────

function compareScans(scan1, scan2) {
  // Index trafos by name (primary key) with lat/lng as fallback
  const key = t => t.name || `${t.lat},${t.lng}`;

  const map1 = new Map(scan1.trafos.map(t => [key(t), t]));
  const map2 = new Map(scan2.trafos.map(t => [key(t), t]));

  const allKeys = new Set([...map1.keys(), ...map2.keys()]);
  const changes = [];
  const now = new Date().toISOString();

  for (const k of allKeys) {
    const t1 = map1.get(k);
    const t2 = map2.get(k);

    if (!t1) {
      // New trafo appeared in scan 2
      changes.push({
        name:       t2.name,
        lat:        t2.lat,
        lng:        t2.lng,
        old_status: null,
        new_status: t2.status,
        direction:  'new',
        changed_at: now,
      });
      continue;
    }

    if (!t2) {
      // Trafo disappeared from scan 2
      changes.push({
        name:       t1.name,
        lat:        t1.lat,
        lng:        t1.lng,
        old_status: t1.status,
        new_status: null,
        direction:  'removed',
        changed_at: now,
      });
      continue;
    }

    if (t1.status !== t2.status) {
      const s1 = severity(t1.status);
      const s2 = severity(t2.status);
      const direction = s2 < s1 ? 'improved' : s2 > s1 ? 'worsened' : 'changed';

      changes.push({
        name:       t2.name,
        lat:        t2.lat,
        lng:        t2.lng,
        old_status: t1.status,
        new_status: t2.status,
        direction,
        changed_at: now,
      });
    }
  }

  // Sort: improved first, then worsened, then new/removed
  const order = { improved: 0, worsened: 1, changed: 2, new: 3, removed: 4 };
  changes.sort((a, b) => (order[a.direction] ?? 99) - (order[b.direction] ?? 99));

  return changes;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run(arg1, arg2) {
  const scans = listScanFiles();

  let file1, file2;

  if (!arg1 && !arg2) {
    if (scans.length < 2) {
      console.error('Need at least 2 scan files to compare. Run a scan first: npm run scan:all');
      process.exit(1);
    }
    file1 = path.join(SCANS_DIR, scans[scans.length - 2]);
    file2 = path.join(SCANS_DIR, scans[scans.length - 1]);
  } else {
    file1 = resolveFile(arg1);
    file2 = resolveFile(arg2);
  }

  const date1 = dateFromFilePath(file1);
  const date2 = dateFromFilePath(file2);

  console.log(`[compare-scans] Comparing:`);
  console.log(`  A: ${file1}  (${date1})`);
  console.log(`  B: ${file2}  (${date2})`);

  const scan1 = loadScan(file1);
  const scan2 = loadScan(file2);

  const changes = compareScans(scan1, scan2);

  // Summary
  const improved = changes.filter(c => c.direction === 'improved');
  const worsened = changes.filter(c => c.direction === 'worsened');
  console.log(`[compare-scans] ${changes.length} changes found:`);
  console.log(`  Improved: ${improved.length}  |  Worsened: ${worsened.length}  |  Other: ${changes.length - improved.length - worsened.length}`);

  const output = {
    generated_at: new Date().toISOString(),
    scan_a:       { date: date1, file: path.basename(file1), count: scan1.count, counts: scan1.counts },
    scan_b:       { date: date2, file: path.basename(file2), count: scan2.count, counts: scan2.counts },
    summary: {
      total_changes: changes.length,
      improved:      improved.length,
      worsened:      worsened.length,
    },
    changes,
  };

  const outFile = path.join(DATA_DIR, `changes-${date1}-vs-${date2}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`[compare-scans] Report saved → ${outFile}`);

  return output;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, a1, a2] = process.argv;
  try {
    run(a1, a2);
    process.exit(0);
  } catch (err) {
    console.error('[compare-scans] Error:', err.message);
    process.exit(1);
  }
}

module.exports = { compareScans, run };
