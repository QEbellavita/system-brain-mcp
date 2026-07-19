'use strict';

// Config-driven work taxonomy.
//
// Replaces a hardcoded classification scheme with one loaded from JSON, so the
// systems, phases, work types and risk tags describe YOUR system rather than
// the author's. See config/taxonomy.default.json.
//
// Contract kept deliberately identical to what the lens layer expects:
//   normalizeTaskContext(value) -> { repository, systems, phases, workTypes,
//                                    changedFileKinds, riskTags }
//   normalizeRecommendation(value) -> a sanitised recommendation record

const fs = require('fs');
const path = require('path');

const MAX_ARRAY = 32;
const MAX_TEXT = 512;

function loadTaxonomy(configPath) {
  const candidates = [
    configPath,
    process.env.SYSTEM_BRAIN_TAXONOMY,
    path.resolve(__dirname, '..', 'config', 'taxonomy.json'),
    path.resolve(__dirname, '..', 'config', 'taxonomy.default.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return compile(parsed, candidate);
    } catch (error) {
      throw new Error(`Invalid taxonomy config at ${candidate}: ${error.message}`);
    }
  }
  throw new Error('No taxonomy config found. Expected config/taxonomy.default.json.');
}

function compile(raw, source) {
  const rules = (raw.systems || []).map((entry) => ({
    system: String(entry.name),
    phases: Array.isArray(entry.phases) ? entry.phases : [],
    pattern: entry.pattern ? new RegExp(entry.pattern, 'i') : null,
  }));
  const workTypes = (raw.workTypes || []).map((entry) => ({
    name: String(entry.name),
    pattern: entry.pattern ? new RegExp(entry.pattern, 'i') : null,
  }));
  const riskTags = (raw.riskTags || []).map((entry) => ({
    name: String(entry.name),
    pattern: entry.pattern ? new RegExp(entry.pattern, 'i') : null,
  }));

  const phaseMin = Number(raw.phases?.min ?? 1);
  const phaseMax = Number(raw.phases?.max ?? 6);
  if (!Number.isInteger(phaseMin) || !Number.isInteger(phaseMax) || phaseMax < phaseMin) {
    throw new Error(`phases.min/max must be integers with max >= min (got ${phaseMin}..${phaseMax})`);
  }

  return {
    source,
    rules,
    workTypes,
    riskTags,
    phaseMin,
    phaseMax,
    phaseLabels: raw.phases?.labels || {},
    systemNames: new Set(rules.map((r) => r.system)),
    workTypeNames: new Set(workTypes.map((w) => w.name)),
    riskTagNames: new Set(riskTags.map((r) => r.name)),
    changedFileKinds: new Set(raw.changedFileKinds || []),
    repositories: new Map((raw.repositories || []).map((name) => [slug(name), name])),
  };
}

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function text(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedArray(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ARRAY);
}

function allowedLabels(value, allowed) {
  return [...new Set(
    boundedArray(value)
      .map((entry) => slug(entry))
      .filter((entry) => allowed.has(entry)),
  )];
}

function createTaxonomy(configPath) {
  const t = loadTaxonomy(configPath);

  function phases(value) {
    return [...new Set(boundedArray(value)
      .map((phase) => {
        const n = typeof phase === 'number' ? phase
          : (typeof phase === 'string' && /^\d+$/.test(phase) ? Number(phase) : null);
        if (n === null || !Number.isInteger(n)) return null;
        return n >= t.phaseMin && n <= t.phaseMax ? n : null;
      })
      .filter((phase) => phase !== null))]
      .sort((a, b) => a - b);
  }

  function repository(value) {
    const name = slug(value);
    if (t.repositories.size === 0) return name || null;   // no allowlist: accept any
    return t.repositories.get(name) || null;
  }

  function normalizeTaskContext(value) {
    const source = record(value);
    const has = (f) => Object.hasOwn(source, f);
    return {
      repository: has('repository') ? repository(source.repository) : null,
      systems: has('systems') ? allowedLabels(source.systems, t.systemNames) : [],
      phases: has('phases') ? phases(source.phases) : [],
      workTypes: has('workTypes') ? allowedLabels(source.workTypes, t.workTypeNames) : [],
      changedFileKinds: has('changedFileKinds')
        ? allowedLabels(source.changedFileKinds, t.changedFileKinds) : [],
      riskTags: has('riskTags') ? allowedLabels(source.riskTags, t.riskTagNames) : [],
    };
  }

  function normalizeRecommendation(value) {
    const source = record(value);
    return {
      id: text(source.id) || null,
      title: text(source.title) || null,
      rationale: text(source.rationale) || null,
      taskContext: normalizeTaskContext(source.taskContext),
    };
  }

  /** Classify free text into the configured taxonomy. */
  function classifyTask(input) {
    const value = text(input);
    const systems = [];
    const phaseSet = new Set();
    for (const rule of t.rules) {
      if (rule.pattern && rule.pattern.test(value)) {
        systems.push(rule.system);
        for (const phase of rule.phases) phaseSet.add(phase);
      }
    }
    return {
      repository: null,
      systems: [...new Set(systems)],
      phases: [...phaseSet].sort((a, b) => a - b),
      workTypes: t.workTypes.filter((w) => w.pattern && w.pattern.test(value)).map((w) => w.name),
      changedFileKinds: [],
      riskTags: t.riskTags.filter((r) => r.pattern && r.pattern.test(value)).map((r) => r.name),
    };
  }

  return {
    normalizeTaskContext,
    normalizeRecommendation,
    classifyTask,
    describe: () => ({
      source: t.source,
      systems: [...t.systemNames],
      workTypes: [...t.workTypeNames],
      riskTags: [...t.riskTagNames],
      phases: { min: t.phaseMin, max: t.phaseMax, labels: t.phaseLabels },
    }),
  };
}

// Default instance, so consumers can require the functions directly.
const defaultTaxonomy = createTaxonomy();

module.exports = {
  createTaxonomy,
  normalizeTaskContext: defaultTaxonomy.normalizeTaskContext,
  normalizeRecommendation: defaultTaxonomy.normalizeRecommendation,
  classifyTask: defaultTaxonomy.classifyTask,
  describeTaxonomy: defaultTaxonomy.describe,
};
