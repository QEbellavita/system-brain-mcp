'use strict';

// Loads config/analytics.json, falling back to analytics.default.json.
// Regex-shaped fields arrive as strings in JSON and are compiled here, so the
// engine gets the same types it had when these were hardcoded.

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.resolve(__dirname, '..', 'config');

function pick() {
  const candidates = [
    process.env.SYSTEM_BRAIN_ANALYTICS_CONFIG,
    path.join(CONFIG_DIR, 'analytics.json'),
    path.join(CONFIG_DIR, 'analytics.default.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No analytics config found; expected config/analytics.default.json');
}

function load() {
  const file = pick();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid analytics config at ${file}: ${error.message}`);
  }

  const ledger = raw.outcomeLedger || {};
  if (!ledger.table || !ledger.labelColumn) {
    throw new Error(`${file}: outcomeLedger.table and outcomeLedger.labelColumn are required`);
  }

  const fab = raw.fabrication || {};
  return {
    source: file,
    outcomeLedger: { table: String(ledger.table), labelColumn: String(ledger.labelColumn) },
    legacyFeedbackTables: raw.legacyFeedbackTables || [],
    predictionTables: raw.predictionTables || [],
    timestampColumns: raw.timestampColumns || ['created_at'],
    thresholds: {
      famineCoverageRatio: Number(raw.thresholds?.famineCoverageRatio ?? 0.02),
      ledgerMinForFamine: Number(raw.thresholds?.ledgerMinForFamine ?? 20),
      noLedgerActivityFloor: Number(raw.thresholds?.noLedgerActivityFloor ?? 50),
    },
    seedUserPattern: new RegExp(raw.seedUserPattern || '^(demo|seed|test)', 'i'),
    fabrication: {
      maxDepth: Number(fab.maxDepth ?? 4),
      fileCap: Number(fab.fileCap ?? 1500),
      findingCap: Number(fab.findingCap ?? 300),
      extensions: fab.extensions || ['.js'],
      excludeDirPattern: new RegExp(fab.excludeDirPattern || '^(node_modules|\\.git)$', 'i'),
      excludeFilePattern: new RegExp(fab.excludeFilePattern || '\\.(test|spec)\\.js$', 'i'),
    },
  };
}

module.exports = { load };
