'use strict';
/**
 * Lädt Umgebungsvariablen unabhängig vom aktuellen Arbeitsverzeichnis
 * (wichtig für PM2, node von anderem cwd, CLI-Skripte im Unterordner).
 *
 * .env         — gemeinsame Vorlage (kann per Deploy mit auf den Server)
 * .env.local   — optional, nur lokal, überschreibt; wird nicht per deploy/deploy.sh/scp
 *   mitgeliefert (nur .env) — sinnvoll z. B. DATA_DIR= für einen Rechner
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const envPath = path.join(root, '.env');
const localPath = path.join(root, '.env.local');

require('dotenv').config({ path: envPath });
if (fs.existsSync(localPath)) {
  require('dotenv').config({ path: localPath, override: true });
}

module.exports = { appRoot: root };
