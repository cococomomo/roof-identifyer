'use strict';
/**
 * Einheitliches Betriebsdaten-Verzeichnis (Leads, Accounts, Scans, …).
 * Per Umgebung: DATA_DIR=/var/lib/roof-identifyer  (außerhalb des Release-Ordners)
 * so bleibt CRM-Stand bei npm deploy / tar-Update erhalten.
 */
const fs = require('fs');
const path = require('path');

const defaultDataDir = () => path.join(__dirname, '..', 'data');

function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  return defaultDataDir();
}

function ensureDataDir() {
  const d = resolveDataDir();
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    console.error('[DATA_DIR] mkdir:', d, e.message);
  }
  return d;
}

/**
 * Beim Wechsel auf ein externes DATA_DIR: fehlende Dateien aus dem
 * bisherigen Release-ordner-…/data/ übernehmen.
 * Wichtig: Nicht nur CRM, sondern auch Trafos, Geo (Bezirke, Gemeinden),
 * Chancen-JSON – sonst liefert die API 404/503 und die Karte bleibt leer.
 */
const MIGRATED_FILES = [
  'leads.json',
  'accounts.json',
  'user-roles.json',
  'audit.json',
  'bug-reports.json',
  'trafos-latest.json',
  'bezirke-noe.json',
  'gemeinden-noe.json',
  'opportunities.json',
  'opportunities-simple.json',
];

function migrateFromAppDataIfNeeded() {
  const current = resolveDataDir();
  const legacy = defaultDataDir();
  if (path.resolve(current) === path.resolve(legacy)) return;
  for (const f of MIGRATED_FILES) {
    const src = path.join(legacy, f);
    const dst = path.join(current, f);
    if (!fs.existsSync(src)) continue;
    let doCopy = !fs.existsSync(dst);
    if (fs.existsSync(dst) && fs.statSync(dst).size < 8 && fs.statSync(src).size > 8) {
      doCopy = true; // leere/Platzhalter-Datei im neuen DATA_DIR
    }
    if (doCopy) {
      try {
        fs.copyFileSync(src, dst);
        console.log(`[data] Migrated ${f} → ${dst}`);
      } catch (e) {
        console.error(`[data] migrate ${f}:`, e.message);
      }
    }
  }
  const legScans = path.join(legacy, 'scans');
  const curScans = path.join(current, 'scans');
  if (fs.existsSync(legScans) && !fs.existsSync(curScans)) {
    try {
      fs.cpSync(legScans, curScans, { recursive: true });
      console.log('[data] Migrated scans/ →', curScans);
    } catch (e) {
      console.error('[data] migrate scans/:', e.message);
    }
  }
}

module.exports = {
  defaultDataDir,
  resolveDataDir,
  ensureDataDir,
  migrateFromAppDataIfNeeded,
};
