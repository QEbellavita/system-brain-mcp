'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBrainService } = require('./engine');
const { createReasoningLensService } = require('./lenses');
const { LENSES, KINDS: LENS_KIND_ENUM } = require('./lens-registry');
const { normalizeTaskContext, describeTaxonomy } = require('./taxonomy');
const { selectLens } = require('./lens-selector');

// Input-schema vocabularies are derived from the taxonomy config at load time,
// so the MCP contract describes YOUR system rather than a baked-in ontology.
// Edit config/taxonomy.json to change them.
const TAXONOMY = describeTaxonomy();
const RISK_TAG_ENUM = TAXONOMY.riskTags;
const SYSTEM_ENUM = TAXONOMY.systems;
const WORK_TYPE_ENUM = TAXONOMY.workTypes;
const PHASE_ENUM = Array.from(
  { length: TAXONOMY.phases.max - TAXONOMY.phases.min + 1 },
  (_, i) => TAXONOMY.phases.min + i,
);
const CHANGED_FILE_KIND_ENUM = [];
const LENS_ENUM = ['auto', 'off', ...LENSES.map((lens) => lens.key)];
const RECOMMENDATION_KEY_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const RECOMMENDATION_KEY_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RECOMMENDATION_KEY_LENGTH = 120;
const REFRAME_INPUT_KEYS = new Set(['recommendationKey', 'taskContext', 'lens']);
const TASK_CONTEXT_KEYS = new Set(['repository', 'systems', 'phases', 'workTypes', 'changedFileKinds', 'riskTags']);

function loadManifestPath() {
  return process.env.SYSTEM_BRAIN_DEPLOY_MANIFEST
    || path.join(os.homedir(), '.config', 'system-brain', 'deploy-targets.json');
}

function loadVaults() {
  const raw = process.env.SYSTEM_BRAIN_OBSIDIAN_VAULTS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function loadDbPath() {
  return process.env.SYSTEM_BRAIN_DB || null;
}

function loadModelsDirs() {
  const raw = process.env.SYSTEM_BRAIN_MODELS_DIRS;
  if (!raw) return [];
  return raw.split(':').map((entry) => entry.trim()).filter(Boolean);
}

function loadFabricationDirs() {
  const raw = process.env.SYSTEM_BRAIN_FABRICATION_DIRS;
  if (!raw) return [];
  return raw.split(':').map((entry) => entry.trim()).filter(Boolean);
}

function loadRegistryDoc() {
  // No default: a model-registry doc is site-specific. Unset means "no registry".
  return process.env.SYSTEM_BRAIN_MODEL_REGISTRY || null;
}

function loadArchDocs() {
  // Colon-separated paths to your architecture docs. No default — these are
  // whatever markdown describes YOUR system.
  const raw = process.env.SYSTEM_BRAIN_ARCH_DOCS;
  if (!raw) return [];
  return raw.split(':').map((entry) => entry.trim()).filter(Boolean)
    .filter((filePath) => fs.existsSync(filePath));
}

function makeInput(properties, required) {
  return { type: 'object', properties, required };
}

function enumArraySchema(enumValues, maxItems, itemType = 'string') {
  return {
    type: 'array',
    items: { type: itemType, enum: enumValues },
    minItems: 1,
    maxItems,
    uniqueItems: true,
  };
}

const TASK_CONTEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  maxProperties: 6,
  properties: {
    repository: { type: 'string', minLength: 1, maxLength: 80 },
    systems: enumArraySchema(SYSTEM_ENUM, SYSTEM_ENUM.length),
    phases: enumArraySchema(PHASE_ENUM, PHASE_ENUM.length, 'integer'),
    workTypes: enumArraySchema(WORK_TYPE_ENUM, WORK_TYPE_ENUM.length),
    changedFileKinds: enumArraySchema(CHANGED_FILE_KIND_ENUM, CHANGED_FILE_KIND_ENUM.length),
    riskTags: enumArraySchema(RISK_TAG_ENUM, RISK_TAG_ENUM.length),
  },
  anyOf: [
    { required: ['repository'] },
    { required: ['systems'] },
    { required: ['phases'] },
    { required: ['workTypes'] },
    { required: ['changedFileKinds'] },
    { required: ['riskTags'] },
  ],
};

const REFRAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  maxProperties: 3,
  properties: {
    recommendationKey: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_RECOMMENDATION_KEY_LENGTH,
      pattern: RECOMMENDATION_KEY_PATTERN,
    },
    taskContext: TASK_CONTEXT_SCHEMA,
    lens: { type: 'string', enum: LENS_ENUM, maxLength: 80 },
  },
  required: [],
  anyOf: [
    { required: ['recommendationKey'] },
    { required: ['taskContext'] },
  ],
};

// NOT the packet's live uncertainty signal: every recommendation emitted by
// buildRecommendations() is already gated on completeForRecommendation() of
// its own evidence sources, so in practice this only ever sees 'complete'
// inputs and 'skipped' is structurally unreachable here. This exists as a
// forward-compat guard for a future evidence source that isn't gated that
// way -- fail toward uncertainty, never toward false confidence: complete
// only when every relevant sourceHealth entry is complete; otherwise prefer
// stale, then failed, then partial, and default to failed for anything else
// (e.g. skipped) rather than reading it as confirmed support. The signal
// that actually fires for callers is the KB-health override
// (gateEvidenceState in lenses.js), which produces
// evidence-uncertain when the KB is absent.
function deriveEvidenceState(recommendation, sourceHealth) {
  const names = Array.isArray(recommendation.evidenceSources) ? recommendation.evidenceSources : [];
  const entries = names.map((name) => (sourceHealth && sourceHealth[name]) || {});
  if (entries.length > 0 && entries.every((entry) => entry.complete === true)) return 'complete';
  if (entries.some((entry) => entry.stale === true)) return 'stale';
  if (entries.some((entry) => entry.failed === true)) return 'failed';
  if (entries.some((entry) => entry.partial === true)) return 'partial';
  return 'failed';
}

function invalidReframeInput() {
  return { ok: false, error: 'invalid reframe input' };
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataKeys(source, allowedKeys, maxProperties) {
  if (!isPlainRecord(source)) return null;
  if (Object.getOwnPropertySymbols(source).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const keys = Object.getOwnPropertyNames(descriptors);
  if (keys.length > maxProperties) return null;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!allowedKeys.has(key)) return null;
    if (!descriptor.enumerable) return null;
    if (!Object.hasOwn(descriptor, 'value')) return null;
  }
  return keys;
}

function ownDataValue(source, field) {
  const descriptor = Object.getOwnPropertyDescriptor(source, field);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
  return descriptor.value;
}

function hasUniqueItems(values) {
  return new Set(values).size === values.length;
}

function arrayHasOnlyDenseOwnDataItems(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(descriptors);
  if (!names.includes('length')) return false;
  for (const name of names) {
    if (name === 'length') continue;
    if (!/^(?:0|[1-9]\d*)$/.test(name)) return false;
    const index = Number(name);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) return false;
    const descriptor = descriptors[name];
    if (!descriptor.enumerable) return false;
    if (!Object.hasOwn(descriptor, 'value')) return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(descriptors, String(index))) return false;
  }
  return true;
}

function enumArrayIsCanonical(value, enumValues, maxItems, itemType = 'string') {
  if (!arrayHasOnlyDenseOwnDataItems(value)) return false;
  if (value.length < 1 || value.length > maxItems) return false;
  if (!hasUniqueItems(value)) return false;
  return value.every((item) => {
    if (itemType === 'integer') return Number.isInteger(item) && enumValues.includes(item);
    return typeof item === 'string' && enumValues.includes(item);
  });
}

function taskContextIsCanonical(taskContext) {
  const keys = ownDataKeys(taskContext, TASK_CONTEXT_KEYS, TASK_CONTEXT_SCHEMA.maxProperties);
  if (!keys) return false;
  if (keys.length < 1) return false;

  let aggregateItems = 0;
  if (keys.includes('repository')) {
    // Repository names are free strings here (bounded), unlike the enum'd
    // vocabularies below — the taxonomy config knows repo aliases, but the
    // canonical check only guards shape, not membership.
    const repository = ownDataValue(taskContext, 'repository');
    if (typeof repository !== 'string'
      || repository.length < TASK_CONTEXT_SCHEMA.properties.repository.minLength
      || repository.length > TASK_CONTEXT_SCHEMA.properties.repository.maxLength) return false;
  }

  const arrays = [
    ['systems', SYSTEM_ENUM, SYSTEM_ENUM.length, 'string'],
    ['phases', PHASE_ENUM, PHASE_ENUM.length, 'integer'],
    ['workTypes', WORK_TYPE_ENUM, WORK_TYPE_ENUM.length, 'string'],
    ['changedFileKinds', CHANGED_FILE_KIND_ENUM, CHANGED_FILE_KIND_ENUM.length, 'string'],
    ['riskTags', RISK_TAG_ENUM, RISK_TAG_ENUM.length, 'string'],
  ];
  for (const [field, enumValues, maxItems, itemType] of arrays) {
    if (!keys.includes(field)) continue;
    const value = ownDataValue(taskContext, field);
    if (!enumArrayIsCanonical(value, enumValues, maxItems, itemType)) return false;
    aggregateItems += value.length;
  }

  const maxAggregateItems = SYSTEM_ENUM.length
    + PHASE_ENUM.length
    + WORK_TYPE_ENUM.length
    + CHANGED_FILE_KIND_ENUM.length
    + RISK_TAG_ENUM.length;
  if (aggregateItems > maxAggregateItems) return false;

  return keys.includes('repository') || aggregateItems > 0;
}

function validRecommendationKey(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_RECOMMENDATION_KEY_LENGTH
    && RECOMMENDATION_KEY_REGEX.test(value);
}

function validateReframeInput(input) {
  const inputKeys = ownDataKeys(input, REFRAME_INPUT_KEYS, REFRAME_SCHEMA.maxProperties);
  if (!inputKeys) return invalidReframeInput();

  const hasRecommendationKey = inputKeys.includes('recommendationKey');
  const hasTaskContext = inputKeys.includes('taskContext');
  if (!hasRecommendationKey && !hasTaskContext) return invalidReframeInput();
  if (hasRecommendationKey && !validRecommendationKey(ownDataValue(input, 'recommendationKey'))) {
    return invalidReframeInput();
  }

  if (hasTaskContext) {
    const taskContext = ownDataValue(input, 'taskContext');
    if (!taskContextIsCanonical(taskContext)) return invalidReframeInput();
  }

  if (inputKeys.includes('lens')) {
    const lens = ownDataValue(input, 'lens');
    if (typeof lens !== 'string' || lens.length > 80 || !LENS_ENUM.includes(lens)) return invalidReframeInput();
  }

  return { ok: true };
}

function createDomain() {
  const manifestPath = loadManifestPath();
  const vaults = loadVaults();
  const dbPath = loadDbPath();
  const modelsDirs = loadModelsDirs();
  const registryDoc = loadRegistryDoc();
  const archDocs = loadArchDocs();
  const fabricationDirs = loadFabricationDirs();
  const service = createBrainService({ manifestPath, vaults, dbPath, modelsDirs, registryDoc, archDocs, fabricationDirs });
  let lensService;

  function getLensService() {
    if (!lensService) {
      // No knowledge base in this build. The stub adapter reports that
      // honestly instead of throwing: reframe still works, but its evidence
      // health gates to non-complete, which (by design) trips the adversarial
      // review — fail toward uncertainty, never toward false confidence.
      const stubHealth = () => ({
        ok: false, complete: false, partial: false, failed: true,
        reason: 'no knowledge base configured in this build', supportFound: false,
      });
      const kbAdapter = {
        getStatus: async () => ({ evidenceHealth: stubHealth() }),
        getEvidence: async () => ({
          kbEvidence: { concepts: [], links: [], articles: [], sources: [] },
          evidenceHealth: stubHealth(),
        }),
      };
      lensService = createReasoningLensService({ kbAdapter });
    }
    return lensService;
  }

  return {
    tools: () => [
      {
        def: {
          name: 'brain_where_deploys',
          description: 'Resolve the canonical deploy target for a file/path and cross-check it against repo config.',
          inputSchema: makeInput({ path: { type: 'string' } }, ['path']),
        },
        handler: (args) => service.whereDoesThisDeploy(args.path),
      },
      {
        def: {
          name: 'brain_backlog',
          description: 'Unified open items across GitHub PRs/issues and local git. `includeVault` (default false) opts into a bounded, most-recent-first Obsidian vault marker-sample — off by default because even the bounded scan adds iCloud latency.',
          inputSchema: makeInput(
            {
              repos: { type: 'array', items: { type: 'string' } },
              includeVault: { type: 'boolean' },
            },
            []
          ),
        },
        handler: (args) => service.backlog(args),
      },
      {
        def: {
          name: 'brain_db_schema',
          description: "List tables in the configured local SQLite database, or (with `table`) inspect one table's columns/indexes/row count. Read-only via the system sqlite3 CLI; table names are validated to prevent injection.",
          inputSchema: makeInput({ table: { type: 'string' } }, []),
        },
        handler: (args) => service.dbSchema(args && args.table),
      },
      {
        def: {
          name: 'brain_ml_models',
          description: 'List on-disk ML model artifact files across configured model directories. Presence on disk does NOT mean a model is loaded or active.',
          inputSchema: makeInput({}, []),
        },
        handler: () => service.mlModels(),
      },
      {
        def: {
          name: 'brain_analytics',
          description: 'Row counts and recency for known prediction/feedback tables in the local dev SQLite database. Honestly labeled as local/dev, not production; flags feedback famine.',
          inputSchema: makeInput({}, []),
        },
        handler: () => service.analytics(),
      },
      {
        def: {
          name: 'brain_architecture',
          description: "Curated architecture docs (gateway skills). No `area`: list doc names/sections/sizes. With `area`: return one doc's content (truncated to 8000 chars), matched by name/basename substring.",
          inputSchema: makeInput({ area: { type: 'string' } }, []),
        },
        handler: (args) => service.architecture(args && args.area),
      },
      {
        def: {
          name: 'brain_fabrication_audit',
          description:
            'Read-only static scan for fabricated-core leaves (Math.random()-fed confidence/accuracy/score/decision values) ' +
            'across configured engine directories. A signal, not proof — verify each finding against stub-detection-audit before ' +
            'certifying REAL/ABSENT. `dirs` overrides the configured SYSTEM_BRAIN_FABRICATION_DIRS list for this call.',
          inputSchema: makeInput({ dirs: { type: 'array', items: { type: 'string' } } }, []),
        },
        handler: (args) => service.fabricationAudit(args),
      },
      {
        def: {
          name: 'brain_lenses',
          description:
            'List available reasoning lenses (mental models / thinker-inspired frames) for framing a decision. '
            + '`kind` optionally filters to one lens kind. Output includes an `applyGuidance` string the calling model '
            + 'is expected to execute: pick the 1-2 lenses that bite hardest on the live problem and apply them, rather '
            + 'than treating the list as reference material.',
          inputSchema: makeInput({ kind: { type: 'string', enum: LENS_KIND_ENUM } }, []),
        },
        handler: (args) => {
          const options = args || {};
          if (options.kind !== undefined && !LENS_KIND_ENUM.includes(options.kind)) {
            return { ok: false, error: 'unknown lens kind' };
          }
          return getLensService().listLenses(options);
        },
      },
      {
        def: {
          name: 'brain_roadmap',
          description:
            'Scan configured Obsidian vaults for plan/roadmap/next-steps notes (filename-matched, most-recently-modified '
            + 'first) and count their open `- [ ]` checklist items. Content reads are bounded by `limit` (default 6, max 12) '
            + 'so an iCloud-hosted vault cannot stall the call.',
          inputSchema: makeInput({ limit: { type: 'integer', minimum: 1, maximum: 12 } }, []),
        },
        handler: (args) => service.roadmap(args || {}),
      },
      {
        def: {
          name: 'brain_recommend',
          description:
            "Rank next steps from the brain's own read-only evidence (analytics, backlog, models; `deep: true` adds the "
            + 'roadmap scan). A deterministic rule table, NOT a model: every candidate cites the tool and number it came '
            + 'from, and per-source health is reported so degraded evidence cannot read as confirmed support. Output '
            + 'includes a `reasoning` contract the calling model is expected to execute: rank the candidates against live '
            + 'session context and state what would change its mind.',
          inputSchema: makeInput({ deep: { type: 'boolean' } }, []),
        },
        handler: (args) => service.recommend(args || {}),
      },
      {
        def: {
          name: 'brain_reframe',
          description:
            'Reframe a real brain_recommend recommendation (looked up by `recommendationKey`), or a bounded task-only '
            + 'subject when omitted, through a reasoning lens. Priority/evidence/title/why/action/systems/phases are always '
            + 'derived server-side from the real recommendation and its evidence health — never accepted from the caller. '
            + 'Output includes a `reasoning` contract (static, in-session instructions) the calling model is expected to '
            + 'execute: actually answer the lens questions against the cited evidence and emit a proceed/reframe/reject verdict.',
          inputSchema: REFRAME_SCHEMA,
        },
        handler: async (args) => {
          const options = args || {};
          const validation = validateReframeInput(options);
          if (validation.ok === false) return validation;
          const taskContext = options.taskContext;
          const lens = options.lens || 'auto';

          let recommendation;
          let evidenceState;
          if (options.recommendationKey !== undefined) {
            const recommendResult = await service.recommend({ deep: false });
            const match = (recommendResult.recommendations || []).find(
              (candidate) => candidate.key === options.recommendationKey
            );
            if (!match) return { ok: false, error: 'recommendation not found' };
            recommendation = match;
            evidenceState = deriveEvidenceState(match, recommendResult.sourceHealth);
          } else if (lens === 'auto') {
            const task = normalizeTaskContext(taskContext);
            const selection = selectLens({
              mode: 'auto',
              subject: {
                priority: 'medium',
                category: 'completion-gap',
                systems: task.systems,
                phases: task.phases,
                workTypes: task.workTypes,
                riskTags: task.riskTags,
                flags: [],
              },
            });
            if (selection.ok === false && selection.reason === 'no relevant lens') {
              return { ok: false, error: 'no relevant lens' };
            }
          }

          try {
            return await getLensService().reframe({ recommendation, taskContext, lens, evidenceState });
          } catch (error) {
            if (error instanceof Error && error.message === 'unknown lens') {
              return { ok: false, error: 'unknown lens' };
            }
            throw error;
          }
        },
      },
    ],
    resources: () => [
      {
        name: 'system-brain-capabilities',
        uri: 'system-brain://capabilities',
        handler: async () => ({
          domain: 'system-brain',
          tools: [
            'brain_where_deploys',
            'brain_backlog',
            'brain_db_schema',
            'brain_ml_models',
            'brain_analytics',
            'brain_architecture',
            'brain_fabrication_audit',
            'brain_lenses',
            'brain_roadmap',
            'brain_recommend',
            'brain_reframe',
          ],
          manifestConfigured: fs.existsSync(manifestPath),
          vaultsConfigured: Boolean(vaults && Object.keys(vaults).length > 0),
          dbConfigured: Boolean(dbPath && fs.existsSync(dbPath)),
          modelsDirsConfigured: modelsDirs.length > 0,
          archDocsConfigured: archDocs.length > 0,
          fabricationDirsConfigured: fabricationDirs.length > 0,
          // No knowledge base ships in this build; reframe runs with its
          // evidence health gated to non-complete accordingly.
          kbConfigured: false,
        }),
      },
    ],
  };
}

const domain = createDomain();

module.exports = {
  name: 'system-brain',
  requires: [],
  tools: domain.tools,
  resources: domain.resources,
  deriveEvidenceState,
  validateReframeInput,
};
